import { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { AdapterConfig, validateConfig, requireJulesApiKey } from "./config.js";
import { JulesAdapterSessionV1, sessionCodec, serializeSession } from "./session.js";
import { JulesActivity, JulesClient, JulesClientError, extractPullRequestUrl } from "./jules-client.js";
import { buildPrompt, hashPromptIdentity, PROMPT_IDENTITY_HASH_VERSION } from "./prompt-builder.js";
import { handleJulesState } from "./state-machine.js";
import { classifyFailure, toErrorFamily, summarizeJulesFailure } from "./failure-classifier.js";
import { shouldRetry, getRetryNotBefore } from "./retry-policy.js";
import { asJulesActivityId, asJulesSessionId, asPaperclipId } from "./brands.js";
import { CtxContextSchema, HostContextSchema } from "./context-schemas.js";
import { sanitizeError } from "./error-sanitizer.js";
import { deleteStoredSession, loadStoredSession, saveStoredSession } from "./session-store.js";
import {
  isAfterCheckpoint,
  laterCheckpoint,
  normalizeActivities,
} from "./activity-checkpoint.js";
import {
  createNoPrCompletionInteraction,
  addJulesActivityComment,
  createJulesFeedbackInteraction,
  createJulesPlanApprovalInteraction,
  getPaperclipInteraction,
  moveIssueToBlocked,
  moveIssueToInProgress,
  postSessionLink,
  moveIssueToDone,
  moveIssueToReview,
  PaperclipClientError,
  type PaperclipInteraction,
} from "./paperclip-client.js";
import { createTelemetry } from "./telemetry.js";

const JULES_POLL_INTERVAL_MS = 5 * 60 * 1000;
const JULES_WATCH_WINDOW_MS = 6 * 60 * 60 * 1000;
const JULES_CONTINUATION_DELAY_MS = 5 * 60 * 1000;
const JULES_INITIAL_ACTIVITY_CHECK_DELAY_MS = 15 * 1000;

function readContextString(context: Record<string, unknown>, key: string): string | null {
  const value = context[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readContextRecord(context: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = context[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function completionInteractionResult(
  session: JulesAdapterSessionV1,
  issueStatus: "blocked" | "done",
  summary: string,
  clearSession: boolean,
): AdapterExecutionResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    sessionParams: serializeSession(session),
    sessionDisplayId: session.julesSessionId ?? null,
    summary,
    resultJson: {
      provider: "jules",
      julesSessionId: session.julesSessionId,
      julesState: session.julesState ?? session.phase,
      issueStatus,
      interactionId: session.pendingInteraction?.paperclipInteractionId,
      completedWithoutPr: true,
    },
    clearSession,
  };
}

function paperclipInteractionFailure(
  session: JulesAdapterSessionV1,
  error: unknown,
): AdapterExecutionResult {
  const status = error instanceof PaperclipClientError ? error.status : null;
  const transient = status === null || status === 408 || status === 429 || status >= 500;
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorCode: "paperclip_completion_interaction_failed",
    errorFamily: transient ? "transient_upstream" : null,
    errorMessage: sanitizeError(error),
    retryNotBefore: transient
      ? new Date(Date.now() + JULES_CONTINUATION_DELAY_MS).toISOString()
      : null,
    sessionParams: serializeSession(session),
    sessionDisplayId: session.julesSessionId ?? null,
    clearSession: false,
  };
}

function createProgressSummary(session: JulesAdapterSessionV1): string {
    const state = session.julesState || session.phase || "RUNNING";
    return `Jules session ${session.julesSessionId} is ${state}; Paperclip will resume polling it on the next heartbeat.`;
}

function createPendingResult(
  session: JulesAdapterSessionV1,
  initialActivityCheck = false,
): AdapterExecutionResult {
    const summary = createProgressSummary(session);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "jules_session_pending",
      errorFamily: "transient_upstream",
      errorMessage: `Jules session ${session.julesSessionId} is still active`,
      retryNotBefore: new Date(
        Date.now() + (initialActivityCheck ? JULES_INITIAL_ACTIVITY_CHECK_DELAY_MS : JULES_CONTINUATION_DELAY_MS),
      ).toISOString(),
      sessionParams: serializeSession(session),
      sessionDisplayId: session.julesSessionId || null,
      summary,
      resultJson: {
        provider: "jules",
        julesSessionId: session.julesSessionId,
        julesState: session.julesState ?? session.phase,
        pending: true,
      },
      clearSession: false,
    };
}

async function persistSessionBestEffort(
  session: JulesAdapterSessionV1,
  onLog: AdapterExecutionContext["onLog"] | undefined,
): Promise<void> {
  try {
    await saveStoredSession(session);
  } catch (error) {
    if (onLog) {
      await onLog("stderr", `[jules] Could not persist the local recovery record: ${sanitizeError(error)}\n`);
    }
  }
}

function activityComment(activity: JulesActivity): string | null {
  if (activity.planGenerated) {
    const steps = [...activity.planGenerated.plan.steps]
      .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
      .map((step, position) =>
        `${(step.index ?? position) + 1}. **${step.title}**${step.description ? ` — ${step.description}` : ""}`)
      .join("\n");
    return `**Jules plan**\n\n${steps}`;
  }
  if (activity.progressUpdated) {
    const description = activity.progressUpdated.description?.trim();
    return `**Jules progress: ${activity.progressUpdated.title}**${description ? `\n\n${description}` : ""}`;
  }
  if (activity.agentMessaged) return `**Jules message**\n\n${activity.agentMessaged.agentMessage}`;
  if (activity.userMessaged) return `**Message sent to Jules**\n\n${activity.userMessaged.userMessage}`;
  if (activity.planApproved) return `**Jules plan approved**\n\nPlan ID: \`${activity.planApproved.planId}\``;
  if (activity.sessionCompleted) return "**Jules session completed**";
  if (activity.sessionFailed) return `**Jules session failed**\n\n${activity.sessionFailed.reason}`;

  // Jules adds activity variants over time. Preserve the material work-product
  // variants even when a newer API field is not yet modelled above; this keeps
  // bash output, changesets, artifacts, and media references durable in the
  // Paperclip timeline rather than silently advancing the activity checkpoint.
  const raw = activity as Record<string, unknown>;
  const evidence = [
    ["bashCodeExecution", "Jules bash execution"],
    ["changeSet", "Jules changeset"],
    ["artifact", "Jules artifact"],
    ["artifactCreated", "Jules artifact"],
    ["media", "Jules media"],
    ["mediaGenerated", "Jules media"],
  ] as const;
  for (const [key, label] of evidence) {
    const value = raw[key];
    if (value === undefined) continue;
    let detail: string;
    try {
      detail = JSON.stringify(value, null, 2);
    } catch {
      detail = String(value);
    }
    return `**${label}**\n\n\`\`\`json\n${detail.slice(0, 12_000)}\n\`\`\``;
  }
  return activity.description ? `**Jules activity**\n\n${activity.description}` : null;
}

function latestAgentMessage(activities: JulesActivity[]): JulesActivity | null {
  return [...activities].reverse().find((activity) => Boolean(activity.agentMessaged)) ?? null;
}

function latestPlan(activities: JulesActivity[]): JulesActivity | null {
  return [...activities].reverse().find((activity) => Boolean(activity.planGenerated)) ?? null;
}

function planMarkdown(activity: JulesActivity | null): string {
  return activity
    ? activityComment(activity) ?? "Jules is waiting for plan approval. Open the Jules session for the generated plan."
    : "Jules is waiting for plan approval. Open the Jules session for the generated plan.";
}

function feedbackAnswer(result: unknown): string | null {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return null;
  const answers = (result as Record<string, unknown>)["answers"];
  if (!Array.isArray(answers)) return null;
  for (const answer of answers) {
    if (typeof answer !== "object" || answer === null || Array.isArray(answer)) continue;
    const otherText = (answer as Record<string, unknown>)["otherText"];
    if (typeof otherText === "string" && otherText.trim().length > 0) return otherText.trim();
  }
  return null;
}

function rejectionReason(result: unknown): string | null {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return null;
  const record = result as Record<string, unknown>;
  for (const key of ["reason", "rejectReason", "rejectionReason", "feedback"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return feedbackAnswer(result);
}

function interactionPlanRevisionId(interaction: PaperclipInteraction | null): string | null {
  if (!interaction || typeof interaction.target !== "object" || interaction.target === null) return null;
  const target = interaction.target as Record<string, unknown>;
  return target["type"] === "issue_document" && target["key"] === "plan" && typeof target["revisionId"] === "string"
    ? target["revisionId"]
    : null;
}

async function listAllActivities(client: JulesClient, sessionId: NonNullable<JulesAdapterSessionV1["julesSessionId"]>): Promise<JulesActivity[]> {
  const activities: JulesActivity[] = [];
  let pageToken: string | undefined;
  do {
    const page = await client.getActivities(sessionId, pageToken);
    activities.push(...(page.activities ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return normalizeActivities(activities);
}

const MAX_COMMENT_LENGTH = 3500;
/** Consecutive resume attempts on the same Jules session before creating a fresh one. */
const MAX_SESSION_RESUME_ATTEMPTS = 4;

async function mirrorNewActivities(
  client: JulesClient,
  session: JulesAdapterSessionV1,
  taskId: string,
  authToken: string | undefined,
  runId: string | undefined,
  onLog: AdapterExecutionContext["onLog"] | undefined,
): Promise<JulesActivity[]> {
  const activities = await listAllActivities(client, session.julesSessionId!);
  const delivered = new Set(session.deliveredActivityIds ?? []);
  for (const activity of activities) {
    if (!isAfterCheckpoint(activity, session.activityCheckpoint) || delivered.has(activity.id)) continue;
    const rawBody = activityComment(activity);
    // Paperclip rejects oversized comments (observed 422 on a long verdict) -
    // truncate with an explicit marker instead of losing the delivery to an error.
    const body =
      rawBody && rawBody.length > MAX_COMMENT_LENGTH
        ? rawBody.slice(0, MAX_COMMENT_LENGTH) + "\n…[truncated]"
        : rawBody;
    if (body) {
      // Per-activity isolation: one rejected comment (e.g. 422 from board-side
      // validation) must not abort the whole mirror batch and starve every later
      // activity behind the durable cursor. Failure is logged with the activity id
      // and the cursor still advances - the activity is lost from the board but the
      // session never wedges. (Issue #7)
      try {
        await addJulesActivityComment(taskId, activity.id, body, session.julesSessionUrl, authToken, runId);
      } catch (commentError) {
        await onLog?.(
          "stderr",
          `[jules-mirror] failed to deliver activity ${activity.id}: ${String(commentError)}\n`,
        );
      }
    }
    delivered.add(activity.id);
    session.deliveredActivityIds = [...delivered].slice(-200);
    session.activityCheckpoint = laterCheckpoint(session.activityCheckpoint, activity);
    await persistSessionBestEffort(session, onLog);
  }
  return activities;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    let timer: NodeJS.Timeout;

    const abortHandler = () => {
        clearTimeout(timer);
        resolve();
    };

    timer = setTimeout(() => {
      signal?.removeEventListener("abort", abortHandler);
      resolve();
    }, ms);

    signal?.addEventListener("abort", abortHandler, { once: true });
  });
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  if (!ctx.agent || typeof ctx.agent.adapterConfig === 'undefined') {
      throw new Error("Missing adapter config");
  }
  // Resumed runs (scheduled-retry promotion, heartbeat recovery) may arrive with
  // an empty context - Paperclip does not re-attach task/paperclipIssue on those
  // paths. When an existing session is being resumed, task identity is already
  // captured in the stored prompt hash, so synthesize the minimum the schema
  // requires instead of crashing before the poll loop. (Issue #7 follow-up /
  // upstream ask: promote-with-context.)
  const rawCtx: Record<string, unknown> =
    ctx.context && typeof ctx.context === "object"
      ? (ctx.context as Record<string, unknown>)
      : {};
  const resumedSessionId: string | undefined = (() => {
    // sessionParams is Record<string, unknown> | null (adapter-utils types.d.ts).
    // julesSessionId may sit at top level or nested in a legacy view.
    const sp = (ctx.runtime?.sessionParams ?? null) as Record<string, unknown> | null;
    if (!sp) return undefined;
    const direct = sp["julesSessionId"];
    if (typeof direct === "string" && direct) return direct;
    for (const v of Object.values(sp)) {
      if (v && typeof v === "object") {
        const nested = (v as Record<string, unknown>)["julesSessionId"];
        if (typeof nested === "string" && nested) return nested;
      }
    }
    return undefined;
  })();

  const hasTaskIdentity = "task" in rawCtx || "paperclipIssue" in rawCtx;
  const contextForParse: Record<string, unknown> =
    !hasTaskIdentity && resumedSessionId
      ? {
          ...rawCtx,
          task: { id: `resumed:${resumedSessionId}`, title: "Resumed Jules session", description: "" },
        }
      : rawCtx;
  const parsedCtxContext = CtxContextSchema.parse(contextForParse);
  const rawContext = parsedCtxContext as Record<string, unknown>;
  const rawWorkspace = readContextRecord(parsedCtxContext, "workspace");
  const issueOverride = rawContext["julesSettings"] ?? rawContext["adapterSettings"];
  const workspaceRepositoryUrl = readContextString(rawWorkspace, "repositoryUrl") ?? readContextString(rawWorkspace, "repoUrl");
  const workspaceDefaultBranch = readContextString(rawWorkspace, "defaultBranch") ?? readContextString(rawWorkspace, "defaultRef");
  const warnings: string[] = [];
  const config = validateConfig(ctx.agent.adapterConfig, {
    issueOverride,
    workspace: {
      ...(workspaceRepositoryUrl ? { repositoryUrl: workspaceRepositoryUrl } : {}),
      ...(workspaceDefaultBranch ? { defaultBranch: workspaceDefaultBranch } : {}),
      ...(rawWorkspace["hasRemote"] === false ? { hasRemote: false } : {}),
    },
    warn: message => warnings.push(message),
  });
  for (const warning of warnings) await ctx.onLog?.("stderr", `[jules settings] ${warning}\n`);
  const parsedHostCtx = HostContextSchema.parse(ctx);

  let session = sessionCodec.decode(ctx.runtime.sessionParams);
  const canonicalSessionId = sessionCodec.getCanonicalSessionId(ctx.runtime.sessionParams);
  const heartbeatDeadline = Date.now() + JULES_WATCH_WINDOW_MS;

  const abortSignal = parsedHostCtx.abortSignal || new AbortController().signal;

  const rawTaskId = parsedCtxContext.task.id;
  const taskId = asPaperclipId(rawTaskId);
  const telemetry = createTelemetry(taskId, async (record) => {
    if (ctx.onLog) await ctx.onLog("stdout", `${JSON.stringify(record)}\n`);
  });
  const apiKey = requireJulesApiKey(ctx.config);
  const client = new JulesClient(apiKey, telemetry);
  const taskTitle = parsedCtxContext.task.title;
  const taskDescription = parsedCtxContext.task.description;

  // Paperclip's external-adapter resume path normalizes persisted state to the
  // canonical `{ sessionId }` shape. Rebuild the adapter-local polling state
  // from that identity so a heartbeat resumes the remote Jules session rather
  // than creating another one.
  if (!session && canonicalSessionId) {
    session = {
      version: 1,
      paperclipIssueId: taskId,
      promptHash: "",
      repository: config.repository,
      source: config.source,
      baseBranch: config.baseBranch,
      phase: "RUNNING",
      sessionId: canonicalSessionId,
      julesSessionId: asJulesSessionId(canonicalSessionId),
      attempt: 1,
      failedSessions: [],
      createdAt: new Date().toISOString()
    };
  }

  if (!session) {
    try {
      session = await loadStoredSession(taskId, config.source, config.baseBranch);
      if (session && ctx.onLog) {
        await ctx.onLog(
          "stdout",
          `[jules] Restored session ${session.julesSessionId} from the local recovery record.\n`,
        );
      }
    } catch (error) {
      if (ctx.onLog) {
        await ctx.onLog("stderr", `[jules] Could not read the local recovery record: ${sanitizeError(error)}\n`);
      }
    }
  }

  const paperclipWake = readContextRecord(parsedCtxContext, "paperclipWake");
  const interactionId = readContextString(parsedCtxContext, "interactionId") ??
    readContextString(paperclipWake, "interactionId");
  const interactionKind = readContextString(parsedCtxContext, "interactionKind") ??
    readContextString(paperclipWake, "interactionKind");
  const interactionStatus = readContextString(parsedCtxContext, "interactionStatus") ??
    readContextString(paperclipWake, "interactionStatus");
  const pendingCompletion = session?.pendingInteraction?.type === "completion_confirmation"
    ? session.pendingInteraction
    : null;
  const pendingProviderInteraction = session?.pendingInteraction &&
    (session.pendingInteraction.type === "user_feedback" || session.pendingInteraction.type === "plan_approval")
    ? session.pendingInteraction
    : null;
  const isCompletionResolution = interactionKind === "request_confirmation" &&
    (interactionStatus === "accepted" || interactionStatus === "rejected");

  if (!pendingCompletion && !pendingProviderInteraction && isCompletionResolution) {
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "Ignored an already-resolved or stale Paperclip interaction wake with no pending Jules state.",
      sessionParams: session ? serializeSession(session) : null,
      sessionDisplayId: session?.julesSessionId ?? null,
      clearSession: false,
    };
  }

  if (pendingCompletion && isCompletionResolution) {
    if (interactionId !== pendingCompletion.paperclipInteractionId) {
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "Ignored a stale Paperclip completion interaction wake.",
        sessionParams: serializeSession(session!),
        sessionDisplayId: session!.julesSessionId ?? null,
        clearSession: false,
      };
    }

    try {
      await deleteStoredSession(taskId, config.source, config.baseBranch);
      if (interactionStatus === "accepted") {
        await moveIssueToDone(taskId, session!.julesSessionId!, ctx.authToken, ctx.runId);
        return completionInteractionResult(
          session!,
          "done",
          `Confirmed Jules session ${session!.julesSessionId} completed without a PR; marked the Paperclip issue done.`,
          true,
        );
      }
      return completionInteractionResult(
        session!,
        "blocked",
        `Rejected completion of Jules session ${session!.julesSessionId}; the Paperclip issue remains blocked for manual follow-up.`,
        true,
      );
    } catch (error) {
      return paperclipInteractionFailure(session!, error);
    }
  }

  // Paperclip normally supplies the resolved interaction in the wake context.  Do
  // not depend on that being present, though: some wake paths only preserve the
  // generic issue context.  The persisted card is the authority in that case.
  let storedPendingInteraction: PaperclipInteraction | null = null;
  if (pendingProviderInteraction) {
    try {
      storedPendingInteraction = await getPaperclipInteraction(
        taskId,
        pendingProviderInteraction.paperclipInteractionId!,
        ctx.authToken,
        ctx.runId,
      );
    } catch (error) {
      if (ctx.onLog) {
        await ctx.onLog("stderr", `[jules] Could not read the pending Paperclip interaction: ${sanitizeError(error)}\n`);
      }
    }
  }
  const providerInteractionId = interactionId ??
    (storedPendingInteraction?.status !== "pending" ? pendingProviderInteraction?.paperclipInteractionId : null);
  const providerInteractionKind = interactionKind ?? storedPendingInteraction?.kind ?? null;
  const providerInteractionStatus = interactionStatus ?? storedPendingInteraction?.status ?? null;
  const isProviderResolution = providerInteractionStatus === "answered" ||
    (providerInteractionKind === "request_confirmation" &&
      (providerInteractionStatus === "accepted" || providerInteractionStatus === "rejected"));

  if (pendingProviderInteraction && storedPendingInteraction?.status === "superseded") {
    session!.pendingInteraction = undefined;
    await persistSessionBestEffort(session!, ctx.onLog);
  }

  if (pendingProviderInteraction && isProviderResolution) {
    if (providerInteractionId !== pendingProviderInteraction.paperclipInteractionId) {
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "Ignored a stale Paperclip provider interaction wake.",
        sessionParams: serializeSession(session!),
        sessionDisplayId: session!.julesSessionId ?? null,
        clearSession: false,
      };
    }
    try {
      if (pendingProviderInteraction.type === "user_feedback") {
        if (providerInteractionStatus !== "answered") {
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            sessionParams: serializeSession(session!),
            sessionDisplayId: session!.julesSessionId ?? null,
            summary: "Jules feedback request remains blocked until a Paperclip answer is submitted.",
            resultJson: { provider: "jules", issueStatus: "blocked" },
            clearSession: false,
          };
        }
        const answer = storedPendingInteraction ? feedbackAnswer(storedPendingInteraction.result) : null;
        if (!answer) {
          const nextAttempt = (session!.feedbackInteractionAttempt ?? 0) + 1;
          const replacement = await createJulesFeedbackInteraction(
            taskId,
            session!.julesSessionId!,
            pendingProviderInteraction.julesActivityId,
            pendingProviderInteraction.question,
            ctx.authToken,
            nextAttempt,
            ctx.runId,
          );
          session!.feedbackInteractionAttempt = nextAttempt;
          session!.pendingInteraction = {
            ...pendingProviderInteraction,
            paperclipInteractionId: replacement.id,
            createdAt: new Date().toISOString(),
          };
          await persistSessionBestEffort(session!, ctx.onLog);
          await moveIssueToBlocked(taskId, ctx.authToken, ctx.runId);
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            sessionParams: serializeSession(session!),
            sessionDisplayId: session!.julesSessionId ?? null,
            summary: "Jules did not receive an empty reply; Paperclip opened a new reply card.",
            resultJson: { provider: "jules", issueStatus: "blocked", interactionId: replacement.id },
            clearSession: false,
          };
        }
        await client.sendMessage(session!.julesSessionId!, { prompt: answer });
      } else {
        const resolvedRevisionId = interactionPlanRevisionId(storedPendingInteraction);
        if (!pendingProviderInteraction.planRevisionId || resolvedRevisionId !== pendingProviderInteraction.planRevisionId) {
          return {
            exitCode: 1,
            signal: null,
            timedOut: false,
            errorCode: "paperclip_plan_revision_mismatch",
            errorMessage: "Resolved Paperclip confirmation does not target the pending Jules plan revision",
            sessionParams: serializeSession(session!),
            sessionDisplayId: session!.julesSessionId ?? null,
            clearSession: false,
          };
        }
        if (providerInteractionStatus === "rejected") {
          const reason = storedPendingInteraction ? rejectionReason(storedPendingInteraction.result) : null;
          // A rejection is actionable provider feedback, not a terminal dead
          // end. Jules uses sendMessage to regenerate the plan; retain the
          // issue's blocked disposition until it publishes the replacement.
          await client.sendMessage(
            session!.julesSessionId!,
            { prompt: `The Paperclip plan review rejected the current plan.${reason ? ` Feedback: ${reason}` : " Please regenerate the plan with the requested changes."}` },
          );
          session!.pendingInteraction = undefined;
          session!.phase = "RUNNING";
          await persistSessionBestEffort(session!, ctx.onLog);
          await moveIssueToBlocked(taskId, ctx.authToken, ctx.runId);
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            sessionParams: serializeSession(session!),
            sessionDisplayId: session!.julesSessionId ?? null,
            summary: "Jules received the plan rejection feedback and will regenerate its plan asynchronously.",
            resultJson: { provider: "jules", issueStatus: "blocked" },
            clearSession: false,
          };
        }
        if (providerInteractionStatus !== "accepted") {
          return {
            exitCode: 1,
            signal: null,
            timedOut: false,
            errorCode: "paperclip_plan_approval_missing",
            errorMessage: "The Jules plan approval interaction was not accepted",
            sessionParams: serializeSession(session!),
            sessionDisplayId: session!.julesSessionId ?? null,
            clearSession: false,
          };
        }
        // Idempotent resume: if the relay already succeeded in a previous run
        // (planApprovedAt set), do NOT call approvePlan again - Jules rejects
        // double-approval and the run would fail-loop (MAZ-37 incident).
        if (!session!.planApprovedAt) {
          await client.approvePlan(session!.julesSessionId!);
          session!.planApprovedAt = new Date().toISOString();
        }
      }
      session!.pendingInteraction = undefined;
      session!.phase = "RUNNING";
      await persistSessionBestEffort(session!, ctx.onLog);
      // Jules can take a few seconds to leave its waiting state.  Polling it in
      // this same heartbeat would see the old state and create a duplicate card.
      return createPendingResult(session!, true);
    } catch (error) {
      return paperclipInteractionFailure(session!, error);
    }
  }

  let createdSessionThisRun = false;
  if (!session || session.phase === 'RETRY_SCHEDULED') {
    const isRetry = session?.phase === 'RETRY_SCHEDULED';
    const failedSessions = session?.failedSessions || [];
    const attempt = (isRetry && session) ? (session.attempt + 1) : 1;

    // RETRY PREFERENCE: resume the existing Jules session via chat for up to
    // MAX_SESSION_RESUME_ATTEMPTS consecutive executions. Each resume preserves full
    // context. Only after exhausting resume attempts do we fall through to
    // new-session creation below, which naturally starts from the branch tip.
    //
    // SKIP RESUME if the session already produced a PR: sending a chat message
    // to a completed session starts a redundant cycle (observed live on MAZ-105).
    const alreadyDeliveredPr = Boolean(session?.currentPrUrl);
    if (alreadyDeliveredPr && isRetry) {
      await ctx.onLog?.('stdout', `[jules] Session already delivered PR ${session!.currentPrUrl} - skipping resume.\n`);
    } else if (isRetry && session!.julesSessionId && attempt <= MAX_SESSION_RESUME_ATTEMPTS) {
      await ctx.onLog?.('stdout', `[jules] Retrying by resuming session ${session!.julesSessionId} (attempt ${attempt}/${MAX_SESSION_RESUME_ATTEMPTS})\n`);
      await client.sendMessage(
          session!.julesSessionId as Parameters<typeof client.sendMessage>[0],
          { prompt: "Your previous run hit an error. Please retry the task from where you left off." },
      );
      session!.phase = 'RUNNING';
      session!.pendingInteraction = undefined;
      // Board was set to blocked by the failure; flip it back so dashboards
      // show active work. Best-effort: failure here doesn't affect the retry.
      try { await moveIssueToInProgress(taskId, ctx.authToken,
        `Jules session resumed for retry (attempt ${attempt}).`, ctx.runId); }
      catch { /* board unavailable */ }
      await persistSessionBestEffort(session!, ctx.onLog);
      return createPendingResult(session!, true);
    }
    // Attempts exhausted or no session to resume: fall through to fresh creation.
    if (isRetry) {
      await ctx.onLog?.('stderr', `[jules] Session resume budget exhausted (${MAX_SESSION_RESUME_ATTEMPTS} attempts) - creating fresh session as continuation.\n`);
    }

    let failedSessionId, failedSessionMessage;
    if (isRetry && failedSessions.length > 0) {
       const lastFailed = failedSessions[failedSessions.length - 1];
       if (lastFailed) {
         failedSessionId = lastFailed.sessionId;
         failedSessionMessage = lastFailed.message;
       }
    }

    const promptContext = {
      issueId: taskId,
      runId: ctx.runId,
      title: taskTitle,
      description: taskDescription,
      isRetry,
      resumeAttempt: isRetry ? attempt : 0,
      failedSessionUrl: failedSessionId ? `Session ID: ${failedSessionId}` : undefined,
      failedSessionMessage,
      priorPrUrls: (session?.failedSessions ?? [])
          .map((fs) => fs.prUrl)
          .filter((url): url is string => Boolean(url)),
    };

    const prompt = buildPrompt(promptContext, config);
    const pHash = hashPromptIdentity(promptContext, config);

    try {
      const julesSession = await client.createSession({
          prompt,
          title: taskTitle,
          sourceContext: {
              source: config.source,
              githubRepoContext: {
                  startingBranch: config.baseBranch
              }
          },
          requirePlanApproval: config.requirePlanApproval,
          automationMode: config.automationMode
      });

      session = {
        version: 1,
        paperclipIssueId: taskId,
        promptHash: pHash,
        promptHashVersion: PROMPT_IDENTITY_HASH_VERSION,
        repository: config.repository,
        source: config.source,
        baseBranch: config.baseBranch,
        phase: 'RUNNING',
        sessionId: julesSession.id,
        julesSessionId: julesSession.id,
        julesSessionUrl: julesSession.url,
        attempt,
        failedSessions,
        createdAt: new Date().toISOString()
      };
      createdSessionThisRun = true;
      await persistSessionBestEffort(session, ctx.onLog);

    } catch (error) {
      const classification = classifyFailure(error);
      const willRetry = shouldRetry(classification, attempt, config);

      if (willRetry) {
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorCode: "jules_transient_failure",
          errorFamily: toErrorFamily(classification),
          errorMessage: sanitizeError(error),
          retryNotBefore: new Date(getRetryNotBefore(attempt, {
            retryAfterMs: error instanceof JulesClientError ? error.retryAfterMs : null,
          })).toISOString(),
          sessionParams: serializeSession({
            version: 1,
            paperclipIssueId: taskId,
            promptHash: pHash,
            promptHashVersion: PROMPT_IDENTITY_HASH_VERSION,
            repository: config.repository,
            source: config.source,
            baseBranch: config.baseBranch,
            phase: 'RETRY_SCHEDULED',
            attempt,
            failedSessions: [
              ...failedSessions,
              { failedAt: new Date().toISOString(), message: sanitizeError(error), classification,
                ...(session?.currentPrUrl ? { prUrl: session.currentPrUrl } : {}) },
            ],
            createdAt: new Date().toISOString()
          }),
          clearSession: false
        };
      }

      return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorCode: "jules_create_failure",
          errorFamily: toErrorFamily(classification),
          errorMessage: sanitizeError(error),
          clearSession: false
      };
    }
  }

  if (!session) throw new Error("Session is null after initialization");

  // Persist the provider identity before waiting on Jules. If Paperclip or the
  // adapter process restarts during a long Jules job, the next run can resume
  // this exact remote session instead of creating another one.
  if (createdSessionThisRun) {
    if (ctx.onLog) {
      await ctx.onLog('stdout', `[jules] Created session ${session.julesSessionId}; checkpointing before long polling.\n`);
    }
    if (session.julesSessionUrl) {
      try { await postSessionLink(taskId, session.julesSessionUrl, ctx.authToken, ctx.runId); }
      catch { /* board unavailable */ }
    }
    return createPendingResult(session, true);
  }

  const currentPromptContext = {
    issueId: taskId,
    runId: ctx.runId,
    title: taskTitle,
    description: taskDescription,
    isRetry: false
  };
  const currentHash = hashPromptIdentity(currentPromptContext, config);
  if (session.promptHashVersion !== PROMPT_IDENTITY_HASH_VERSION) {
    session.promptHash = currentHash;
    session.promptHashVersion = PROMPT_IDENTITY_HASH_VERSION;
    await persistSessionBestEffort(session, ctx.onLog);
  } else if (session.promptHash !== currentHash && session.attempt === 1) {
    if (ctx.onLog) {
        await ctx.onLog('stderr', `[WARN] Task identity changed. Using original prompt hash for session ${session.julesSessionId}`);
    }
  }

  while (!abortSignal.aborted && Date.now() < heartbeatDeadline) {
    if (!session.julesSessionId) throw new Error("Missing julesSessionId during polling loop");

    try {
      const julesSession = await client.getSession(session.julesSessionId);
      const state = julesSession.state || 'UNKNOWN';
      session.julesState = state;
      session.lastPolledAt = new Date().toISOString();
      if (julesSession.url) {
          session.julesSessionUrl = julesSession.url;
      }
      const prUrl = extractPullRequestUrl(julesSession);
      if (prUrl) {
          session.currentPrUrl = prUrl;
      }

      // Mirroring must never prevent terminal detection: a mirror failure used to
      // abort this run before the COMPLETED/FAILED branches could fire, leaving
      // the Paperclip issue blocked forever (MAZ-102 incident, issue #4/#5 class).
      let activities: JulesActivity[] = [];
      try {
        activities = await mirrorNewActivities(client, session, taskId, ctx.authToken, ctx.runId, ctx.onLog);
      } catch (mirrorError) {
        await ctx.onLog?.(
          'stderr',
          `[jules] activity mirroring failed (terminal detection continues): ${String(mirrorError)}\n`,
        );
      }

      const stateMachineRes = handleJulesState(state, !!session.currentPrUrl);
      // Recover from stale blocked status: if Jules is actively working but the
      // board still shows a previous failure's blocked status, flip back to
      // in_progress so dashboards reflect reality.
      // Unconditional: whenever Jules is actively coding, ensure the board
      // reflects it. Covers blocked→in_progress after retry-resume, and is a
      // no-op when already in_progress (Paperclip handles idempotent PATCHes).
      if (state === 'IN_PROGRESS') {
        try { await moveIssueToInProgress(taskId, ctx.authToken,
          `Jules session is actively working.`, ctx.runId); }
        catch { /* board unavailable; session continues regardless */ }
      }
      session.phase = stateMachineRes.nextPhase;

      if (stateMachineRes.isTerminal) {
         if (session.phase === 'COMPLETED') {
             if (!stateMachineRes.isSuccess) {
                 try {
                   let completion = session.pendingInteraction?.type === "completion_confirmation"
                     ? session.pendingInteraction
                     : null;
                   if (!completion) {
                     const question = `Jules session ${session.julesSessionId} completed without creating a PR. Is this task complete?`;
                     const interaction = await createNoPrCompletionInteraction(
                       taskId,
                       session.julesSessionId!,
                       session.julesSessionUrl,
                       ctx.authToken,
                       ctx.runId,
                     );
                     completion = {
                       type: "completion_confirmation",
                       paperclipInteractionId: interaction.id,
                       question,
                       createdAt: new Date().toISOString(),
                     };
                     session.pendingInteraction = completion;
                     await persistSessionBestEffort(session, ctx.onLog);

                     if (interaction.status === "accepted") {
                       await deleteStoredSession(taskId, config.source, config.baseBranch);
                       await moveIssueToDone(taskId, session.julesSessionId!, ctx.authToken, ctx.runId);
                       return completionInteractionResult(
                         session,
                         "done",
                         `Confirmed Jules session ${session.julesSessionId} completed without a PR; marked the Paperclip issue done.`,
                         true,
                       );
                     }
                     if (interaction.status === "rejected") {
                       await deleteStoredSession(taskId, config.source, config.baseBranch);
                       return completionInteractionResult(
                         session,
                         "blocked",
                         `Rejected completion of Jules session ${session.julesSessionId}; the Paperclip issue remains blocked for manual follow-up.`,
                         true,
                       );
                     }
                   }

                   await moveIssueToBlocked(taskId, ctx.authToken, ctx.runId);
                   return completionInteractionResult(
                     session,
                     "blocked",
                     `Jules session ${session.julesSessionId} completed without a PR and awaits confirmation in Paperclip.`,
                     false,
                   );
                 } catch (error) {
                   return paperclipInteractionFailure(session, error);
                 }
             }

             await moveIssueToReview(taskId, session.currentPrUrl!, ctx.authToken, ctx.runId);
             await deleteStoredSession(taskId, config.source, config.baseBranch);
             if (ctx.onLog) {
                 await ctx.onLog(
                     "stdout",
                     `[jules] Session ${session.julesSessionId} completed; cleared its recovery state. Reopening this Paperclip issue will start a new Jules task.\n`,
                 );
             }
             return {
                 exitCode: 0,
                 signal: null,
                 timedOut: false,
                 sessionParams: serializeSession(session),
                 sessionDisplayId: session.julesSessionId || null,
                 summary: `Jules session ${session.julesSessionId} completed, created a PR, and moved the Paperclip issue to review: ${session.currentPrUrl}`,
                 resultJson: { provider: "jules", julesSessionId: session.julesSessionId, prUrl: session.currentPrUrl, issueStatus: "in_review" },
                 clearSession: true
             };
         } else if (session.phase === 'FAILED') {
             const failureDetails = julesSession.errorInfo || {};
             const classification = classifyFailure(failureDetails);
             const willRetry = shouldRetry(classification, session.attempt, config);

             if (willRetry) {
                 session.failedSessions.push({
                     sessionId: session.julesSessionId,
                     failedAt: new Date().toISOString(),
                     message: sanitizeError(summarizeJulesFailure(failureDetails)),
                     classification,
                     ...(session.currentPrUrl ? { prUrl: session.currentPrUrl } : {})
                 });
                 session.phase = 'RETRY_SCHEDULED';
                 return {
                     exitCode: 1,
                     signal: null,
                     timedOut: false,
                     errorCode: "jules_transient_failure",
                     errorFamily: toErrorFamily(classification),
                     errorMessage: sanitizeError(summarizeJulesFailure(failureDetails)),
                     retryNotBefore: new Date(getRetryNotBefore(session.attempt)).toISOString(),
                     sessionParams: serializeSession(session),
                     clearSession: false
                 };
             } else {
                 return {
                     exitCode: 1,
                     signal: null,
                     timedOut: false,
                     errorCode: "jules_task_failure",
                     errorFamily: toErrorFamily(classification),
                     errorMessage: sanitizeError(`Jules session failed and exhausted retries: ${summarizeJulesFailure(failureDetails)}`),
                     sessionParams: serializeSession(session),
                     clearSession: false
                 };
             }
         }
      }

      if (stateMachineRes.requiresReturn) {
          try {
            if (session.phase === "WAITING_FOR_FEEDBACK") {
              let pending = session.pendingInteraction?.type === "user_feedback"
                ? session.pendingInteraction
                : null;
              if (!pending) {
                const activity = latestAgentMessage(activities);
                const question = activity?.agentMessaged?.agentMessage ??
                  "Jules is waiting for feedback. Open the Jules session for the full question.";
                const activityId = activity?.id ?? "awaiting-user-feedback";
                const interactionAttempt = (session.feedbackInteractionAttempt ?? 0) + 1;
                const interaction = await createJulesFeedbackInteraction(
                  taskId, session.julesSessionId!, activityId, question, ctx.authToken, interactionAttempt, ctx.runId,
                );
                session.feedbackInteractionAttempt = interactionAttempt;
                pending = {
                  type: "user_feedback",
                  julesActivityId: asJulesActivityId(activityId),
                  paperclipInteractionId: interaction.id,
                  question,
                  createdAt: new Date().toISOString(),
                };
                session.pendingInteraction = pending;
                await persistSessionBestEffort(session, ctx.onLog);
              }
              await moveIssueToBlocked(taskId, ctx.authToken, ctx.runId);
              return {
                exitCode: 0,
                signal: null,
                timedOut: false,
                sessionParams: serializeSession(session),
                sessionDisplayId: session.julesSessionId ?? null,
                summary: `Jules session ${session.julesSessionId} awaits feedback in Paperclip.`,
                resultJson: { provider: "jules", issueStatus: "blocked", interactionId: pending.paperclipInteractionId },
                clearSession: false,
              };
            }

            if (session.phase === "WAITING_FOR_PLAN_APPROVAL") {
              let pending = session.pendingInteraction?.type === "plan_approval"
                ? session.pendingInteraction
                : null;
              if (!pending) {
                const activity = latestPlan(activities);
                const plan = planMarkdown(activity);
                const activityId = activity?.id ?? "awaiting-plan-approval";
                const interaction = await createJulesPlanApprovalInteraction(
                  taskId, session.julesSessionId!, activityId, plan, ctx.authToken, ctx.runId,
                );
                pending = {
                  type: "plan_approval",
                  julesActivityId: asJulesActivityId(activityId),
                  paperclipInteractionId: interaction.id,
                  question: plan,
                  planDocumentId: interaction.planRevision.documentId,
                  planRevisionId: interaction.planRevision.revisionId,
                  planRevisionNumber: interaction.planRevision.revisionNumber,
                  createdAt: new Date().toISOString(),
                };
                session.pendingInteraction = pending;
                await persistSessionBestEffort(session, ctx.onLog);
              }
              await moveIssueToBlocked(taskId, ctx.authToken, ctx.runId);
              return {
                exitCode: 0,
                signal: null,
                timedOut: false,
                sessionParams: serializeSession(session),
                sessionDisplayId: session.julesSessionId ?? null,
                summary: `Jules session ${session.julesSessionId} awaits plan approval in Paperclip.`,
                resultJson: { provider: "jules", issueStatus: "blocked", interactionId: pending.paperclipInteractionId },
                clearSession: false,
              };
            }
          } catch (error) {
            return paperclipInteractionFailure(session, error);
          }
      }

      await sleep(JULES_POLL_INTERVAL_MS, abortSignal);

    } catch (error) {
      const classification = classifyFailure(error);

      if (classification === 'transient') {
         await sleep(JULES_POLL_INTERVAL_MS, abortSignal);
         continue;
      } else {
          return {
             exitCode: 1,
             signal: null,
             timedOut: false,
             errorCode: "jules_polling_error",
             errorFamily: toErrorFamily(classification),
             errorMessage: sanitizeError(error),
             sessionParams: serializeSession(session),
             clearSession: false
          };
      }
    }
  }

  return createPendingResult(session);
}
