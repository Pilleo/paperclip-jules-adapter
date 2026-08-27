import {
  evaluateInteractionAction,
  recordFeedbackRelayed,
  recordPlanApprovalRelayed,
  determinePaperclipIssueStatus,
} from "./interaction-engine.js";
import { formatCardPrompt, formatCardSummary } from "./card-prompt.js";
import { getPullRequestCiStatus, getPullRequestDetails } from "./ci-status.js";
import { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { AdapterConfig, validateConfig, requireJulesApiKey, discoverLocalGitDefaultBranch } from "./config.js";
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
  listPaperclipInteractions,
  moveIssueToBlocked,
  moveIssueToInProgress,
  postSessionLink,
  moveIssueToDone,
  moveIssueToReview,
  PaperclipClientError,
  type PaperclipInteraction,
} from "./paperclip-client.js";
import { createTelemetry } from "./telemetry.js";

const JULES_POLL_INTERVAL_MS = 45 * 1000;
const JULES_WATCH_WINDOW_MS = 6 * 60 * 60 * 1000;
const JULES_CONTINUATION_DELAY_MS = 60 * 1000;
const JULES_INITIAL_ACTIVITY_CHECK_DELAY_MS = 5 * 1000;

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
  console.error("[jules] paperclipInteractionFailure:", error);
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
  // Plan approvals and agent questions are rendered directly inside interactive
  // Paperclip cards rather than duplicated as orphaned text comments in the discussion thread.
  if (activity.userMessaged) return `**Message sent to Jules**\n\n${activity.userMessaged.userMessage}`;
  if (activity.sessionFailed) return `**Jules session failed**\n\n${activity.sessionFailed.reason}`;

  return null;
}

function latestAgentMessage(activities: JulesActivity[]): JulesActivity | null {
  return (
    [...activities].reverse().find(
      (activity) => Boolean(activity.agentMessaged?.agentMessage?.trim()) || Boolean(activity.description?.trim())
    ) ?? null
  );
}

function extractQuestionText(activity: JulesActivity | null): string {
  if (!activity) return 'Jules is waiting for feedback. Open the Jules session for the full question.';
  const msg = activity.agentMessaged?.agentMessage?.trim();
  if (msg) return msg;
  const desc = activity.description?.trim();
  if (desc) return desc;
  return 'Jules is waiting for feedback. Open the Jules session for the full question.';
}

function latestPlan(activities: JulesActivity[]): JulesActivity | null {
  return [...activities].reverse().find((activity) => Boolean(activity.planGenerated)) ?? null;
}

function planMarkdown(activity: JulesActivity | null): string {
  if (activity?.planGenerated?.plan?.steps) {
    const steps = [...activity.planGenerated.plan.steps]
      .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
      .map((step, position) =>
        `${(step.index ?? position) + 1}. **${step.title}**${step.description ? ` — ${step.description}` : ""}`)
      .join("\n");
    return `### Jules Implementation Plan\n\n${steps}`;
  }
  return "Jules is waiting for plan approval. Open the Jules session for the generated plan.";
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

function formatActivityForLog(activity: JulesActivity): string {
  const ts = activity.createTime ? new Date(activity.createTime).toLocaleTimeString() : new Date().toLocaleTimeString();
  const raw = activity as Record<string, unknown>;

  // Stream git patch artifacts as tool calls
  const artifacts = (activity as any)["artifacts"];
  if (Array.isArray(artifacts) && artifacts.length > 0) {
    for (const art of artifacts) {
      if (art.changeSet?.gitPatch?.unidiffPatch) {
        const jsonEvent = JSON.stringify({
          type: "tool_call",
          name: "gitPatch",
          data: art.changeSet.gitPatch.unidiffPatch,
          id: activity.id,
        });
        return jsonEvent + "\n[jules][" + ts + "] Changeset patch applied\n";
      }
    }
  }

  if (activity.planGenerated) {
    const steps = [...(activity.planGenerated.plan?.steps ?? [])]
      .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
      .map((step, idx) => "  " + ((step.index ?? idx) + 1) + ". " + step.title + (step.description ? " (" + step.description + ")" : ""))
      .join("\n");
    const jsonEvent = JSON.stringify({
      type: "thought",
      data: "Generated Plan:\n" + steps,
    });
    return jsonEvent + "\n[jules][" + ts + "] Generated Plan:\n" + steps + "\n";
  }

  if (activity.progressUpdated) {
    const desc = activity.progressUpdated.description?.trim();
    const title = activity.progressUpdated.title || "Update";
    const text = title + (desc ? " - " + desc : "");
    const jsonEvent = JSON.stringify({
      type: "text",
      data: text,
    });
    return jsonEvent + "\n[jules][" + ts + "] Progress: " + text + "\n";
  }

  if (activity.agentMessaged) {
    const jsonEvent = JSON.stringify({
      type: "text",
      data: activity.agentMessaged.agentMessage,
    });
    return jsonEvent + "\n[jules][" + ts + "] Agent: " + activity.agentMessaged.agentMessage + "\n";
  }

  if (activity.userMessaged) {
    return "[jules][" + ts + "] User input: " + activity.userMessaged.userMessage + "\n";
  }

  if (raw["bashCodeExecution"] || raw["commandExecution"] || raw["codeExecution"] || raw["toolExecution"]) {
    const b = (raw["bashCodeExecution"] ?? raw["commandExecution"] ?? raw["codeExecution"] ?? raw["toolExecution"]) as Record<string, unknown>;
    const cmd = String(b["command"] ?? b["code"] ?? b["cmd"] ?? "");
    const out = String(b["output"] ?? b["stdout"] ?? b["result"] ?? b["stderr"] ?? "");
    const jsonEvent = JSON.stringify({
      type: "tool_call",
      name: "bash",
      input: { command: cmd },
      output: out,
      id: activity.id,
    });
    return jsonEvent + "\n[jules][" + ts + "] $ " + cmd + "\n" + (out ? out.trim() + "\n" : "");
  }

  if (raw["changeSet"] || raw["fileModifications"] || raw["patch"] || raw["gitPatch"]) {
    const cs = raw["changeSet"] ?? raw["fileModifications"] ?? raw["patch"] ?? raw["gitPatch"];
    const csStr = typeof cs === "string" ? cs : JSON.stringify(cs, null, 2);
    const jsonEvent = JSON.stringify({
      type: "tool_call",
      name: "git_patch",
      input: { diff: csStr },
      id: activity.id,
    });
    return jsonEvent + "\n[jules][" + ts + "] Changeset applied:\n" + csStr + "\n";
  }

  if (activity.sessionCompleted) {
    return "[jules][" + ts + "] Session completed successfully.\n";
  }

  if (activity.sessionFailed) {
    return "[jules][" + ts + "] Session failed: " + activity.sessionFailed.reason + "\n";
  }

  if (activity.description) {
    return "[jules][" + ts + "] " + activity.description + "\n";
  }

  return "[jules][" + ts + "] Activity: " + activity.id + "\n";
}

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
    if (onLog) {
      const logLine = formatActivityForLog(activity);
      await onLog("stdout", logLine);
    }
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
          "stdout",
          `[jules-mirror] comment delivery skipped for activity ${activity.id}: ${String(commentError)}\n`,
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

  const extractedTask = ((): Record<string, unknown> | null => {
    if (rawCtx["task"] && typeof rawCtx["task"] === "object") return rawCtx["task"] as Record<string, unknown>;
    if (rawCtx["paperclipIssue"] && typeof rawCtx["paperclipIssue"] === "object") return rawCtx["paperclipIssue"] as Record<string, unknown>;
    if (rawCtx["issue"] && typeof rawCtx["issue"] === "object") return rawCtx["issue"] as Record<string, unknown>;
    const wake = rawCtx["paperclipWake"] as Record<string, unknown> | undefined;
    if (wake && typeof wake === "object") {
      if (wake["task"] && typeof wake["task"] === "object") return wake["task"] as Record<string, unknown>;
      if (wake["paperclipIssue"] && typeof wake["paperclipIssue"] === "object") return wake["paperclipIssue"] as Record<string, unknown>;
      if (wake["issue"] && typeof wake["issue"] === "object") return wake["issue"] as Record<string, unknown>;
    }
    const payload = rawCtx["payload"] as Record<string, unknown> | undefined;
    if (payload && typeof payload === "object") {
      if (payload["task"] && typeof payload["task"] === "object") return payload["task"] as Record<string, unknown>;
      if (payload["paperclipIssue"] && typeof payload["paperclipIssue"] === "object") return payload["paperclipIssue"] as Record<string, unknown>;
      if (payload["issue"] && typeof payload["issue"] === "object") return payload["issue"] as Record<string, unknown>;
    }
    return null;
  })();

  if (!extractedTask && !resumedSessionId) {
    if (ctx.onLog) {
      await ctx.onLog("stdout", "[jules] No task or paperclipIssue attached to this run context; heartbeat completed cleanly.\n");
    }
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "No task or paperclipIssue attached to this run; heartbeat completed.",
      sessionParams: null,
      clearSession: true,
    };
  }

  const contextForParse: Record<string, unknown> = {
    ...rawCtx,
    task: extractedTask ?? { id: `resumed:${resumedSessionId}`, title: "Resumed Jules session", description: "" },
  };
  const parsedCtxContext = CtxContextSchema.parse(contextForParse);
  const rawContext = parsedCtxContext as Record<string, unknown>;
  const rawWorkspace = readContextRecord(parsedCtxContext, "workspace") ?? readContextRecord(parsedCtxContext, "paperclipWorkspace");
  const issueOverride = rawContext["julesSettings"] ?? rawContext["adapterSettings"];
  let workspaceRepositoryUrl = readContextString(rawWorkspace, "repositoryUrl") ?? readContextString(rawWorkspace, "repoUrl");
  let workspaceDefaultBranch = readContextString(rawWorkspace, "defaultBranch") ?? readContextString(rawWorkspace, "defaultRef");

  let projectId = readContextString(parsedCtxContext, "projectId") ??
    readContextString(readContextRecord(parsedCtxContext, "contextSnapshot"), "projectId") ??
    readContextString(readContextRecord(parsedCtxContext, "task"), "projectId") ??
    readContextString(readContextRecord(parsedCtxContext, "paperclipIssue"), "projectId");

  const effectiveTaskId = asPaperclipId(String((extractedTask as { id?: unknown })?.id ?? parsedCtxContext.task.id));

  // Project lookup
  if (process.env["NODE_ENV"] !== "test" && !projectId && effectiveTaskId && !effectiveTaskId.startsWith("resumed:")) {
    try {
      const issueRes = await fetch(`http://127.0.0.1:3100/api/issues/${encodeURIComponent(effectiveTaskId)}`, {
        signal: AbortSignal.timeout(2000),
      });
      if (issueRes.ok) {
        const issueData = await issueRes.json();
        if (issueData.projectId) projectId = issueData.projectId;
      }
    } catch (e) {
      if (ctx.onLog) await ctx.onLog("stderr", `[jules] Issue fetch error: ${e}\n`);
    }
  }

  let workspaceCwd = readContextString(rawWorkspace, "cwd");

  if (process.env["NODE_ENV"] !== "test" && projectId) {
    try {
      const projectRes = await fetch(`http://127.0.0.1:3100/api/projects/${encodeURIComponent(projectId)}`, {
        signal: AbortSignal.timeout(2000),
      });
      if (projectRes.ok) {
        const projectData = await projectRes.json();
        const pRepo = projectData.primaryWorkspace?.repoUrl ?? projectData.codebase?.repoUrl;
        const pBranch = projectData.primaryWorkspace?.defaultRef ?? projectData.codebase?.defaultRef;
        const pCwd = projectData.primaryWorkspace?.cwd ?? projectData.codebase?.localFolder ?? projectData.codebase?.effectiveLocalFolder;
        if (pRepo) workspaceRepositoryUrl = pRepo;
        if (pBranch) workspaceDefaultBranch = pBranch;
        if (pCwd) {
          workspaceCwd = pCwd;
          const discovered = discoverLocalGitDefaultBranch(pCwd);
          if (discovered && !workspaceDefaultBranch) workspaceDefaultBranch = discovered;
        }
        if (ctx.onLog) await ctx.onLog("stdout", `[jules] Resolved project ${projectData.name} -> repo: ${workspaceRepositoryUrl}, branch: ${workspaceDefaultBranch}\n`);
      }
    } catch (e) {
      if (ctx.onLog) await ctx.onLog("stderr", `[jules] Project fetch error: ${e}\n`);
    }
  }
  const warnings: string[] = [];
  const config = validateConfig(ctx.agent.adapterConfig, {
    issueOverride,
    workspace: {
      ...(workspaceRepositoryUrl ? { repositoryUrl: workspaceRepositoryUrl } : {}),
      ...(workspaceDefaultBranch ? { defaultBranch: workspaceDefaultBranch } : {}),
      ...(workspaceCwd ? { cwd: workspaceCwd } : {}),
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

  const paperclipWake = readContextRecord(parsedCtxContext, "paperclipWake");
  const wakeSource = readContextString(parsedCtxContext, "wakeSource") ?? readContextString(paperclipWake, "wakeSource");
  const wakeReason = readContextString(parsedCtxContext, "wakeReason") ?? readContextString(paperclipWake, "wakeReason");
  const previousStatus = readContextString(parsedCtxContext, "previousStatus") ?? readContextString(paperclipWake, "previousStatus");

  const isTransitionFromBacklogOrReopened = Boolean(
    previousStatus === "backlog" ||
    previousStatus === "done" ||
    previousStatus === "cancelled" ||
    (wakeSource === "status_change" && previousStatus === "todo") ||
    (typeof wakeReason === "string" && /(backlog|reopened|archived)/i.test(wakeReason))
  );

  const forceFreshSession = Boolean(
    (parsedCtxContext as { forceFreshSession?: boolean })?.forceFreshSession ||
    (parsedCtxContext as { contextSnapshot?: { forceFreshSession?: boolean } })?.contextSnapshot?.forceFreshSession ||
    isTransitionFromBacklogOrReopened
  );

  if (forceFreshSession) {
    session = null;
    await deleteStoredSession(taskId, config.source, config.baseBranch).catch(() => {});
  }

  // Paperclip's external-adapter resume path normalizes persisted state to the
  // canonical `{ sessionId }` shape. Rebuild the adapter-local polling state
  // from that identity so a heartbeat resumes the remote Jules session rather
  // than creating another one.
  if (!session && canonicalSessionId && !forceFreshSession) {
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

  if (!session && !forceFreshSession) {
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

  // Fallback: If not found or still pending, check all interactions on the issue for an answered feedback card
  if (!storedPendingInteraction && pendingProviderInteraction) {
    try {
      const allInteractions = await listPaperclipInteractions(taskId, ctx.authToken, ctx.runId);
      const answeredFeedback = allInteractions.find(
        (i: PaperclipInteraction) => i.kind === "ask_user_questions" && i.status === "answered" && Boolean(feedbackAnswer(i.result))
      );
      if (answeredFeedback) {
        storedPendingInteraction = answeredFeedback;
      }
    } catch {}
  }
  const providerInteractionId = interactionId ??
    (storedPendingInteraction?.status !== "pending" ? pendingProviderInteraction?.paperclipInteractionId : null);
  const providerInteractionKind = interactionKind ?? storedPendingInteraction?.kind ?? null;
  const providerInteractionStatus = interactionStatus ?? storedPendingInteraction?.status ?? null;
  const isProviderResolution = providerInteractionStatus === "answered" ||
    (providerInteractionKind === "request_confirmation" &&
      (providerInteractionStatus === "accepted" || providerInteractionStatus === "rejected"));

  if (pendingProviderInteraction && (storedPendingInteraction?.status === "superseded" || storedPendingInteraction?.status === "cancelled")) {
    session!.pendingInteraction = undefined;
    await persistSessionBestEffort(session!, ctx.onLog);
  }

  if (pendingProviderInteraction && isProviderResolution) {
    if (providerInteractionId !== pendingProviderInteraction.paperclipInteractionId && storedPendingInteraction?.status !== "answered") {
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
            summary: "Jules feedback request awaits human response in Paperclip.",
            resultJson: { provider: "jules", issueStatus: "in_progress" },
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
        // Relay gate: only forward to Jules when the operator intends it.
        // Board-level replies (cleanup, status notes) are dismissed without
        // reaching the session. Default: relay (Jules feedback cards).
        if (session!.relayNextAnswerToJules !== false) {
          await client.sendMessage(session!.julesSessionId!, { prompt: answer });
        } else {
          session!.relayNextAnswerToJules = undefined;
        }
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
    } else if (isRetry && session!.julesSessionId) {
      // Check if remote Jules session is still alive before creating a new one
      try {
        const remoteSession = await client.getSession(session!.julesSessionId);
        if (remoteSession.state === "IN_PROGRESS" || remoteSession.state === "AWAITING_USER_FEEDBACK") {
          await ctx.onLog?.('stdout', `[jules] Remote session ${session!.julesSessionId} is active (${remoteSession.state}) - continuing polling.\n`);
          session!.phase = 'RUNNING';
          await persistSessionBestEffort(session!, ctx.onLog);
          return createPendingResult(session!, true);
        }
      } catch (err) {
        await ctx.onLog?.('stderr', `[jules] Could not query remote session status: ${sanitizeError(err)}\n`);
      }

      if (attempt <= MAX_SESSION_RESUME_ATTEMPTS) {
        await ctx.onLog?.('stdout', `[jules] Retrying by resuming session ${session!.julesSessionId} (attempt ${attempt}/${MAX_SESSION_RESUME_ATTEMPTS})\n`);
        try {
          await client.sendMessage(
              session!.julesSessionId as Parameters<typeof client.sendMessage>[0],
              { prompt: "Your previous run hit an error. Please retry the task from where you left off." },
          );
        } catch { /* ignore chat send error on retry */ }
        session!.phase = 'RUNNING';
        session!.pendingInteraction = undefined;
        try {
          await moveIssueToInProgress(taskId, ctx.authToken,
            `Jules session resumed for retry (attempt ${attempt}).`, ctx.runId);
        } catch { /* board unavailable */ }
        await persistSessionBestEffort(session!, ctx.onLog);
        return createPendingResult(session!, true);
      }
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
      await ctx.onLog("stdout", `[jules] Created session ${session.julesSessionId}; checkpointing before long polling.\n`);
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
      if (ctx.onLog) {
        const timeStr = new Date().toLocaleTimeString();
        const thoughtEvent = JSON.stringify({
          type: "thought",
          data: `Jules session ${session.julesSessionId} is ${state} in cloud sandbox (polled at ${timeStr})`,
        });
        await ctx.onLog("stdout", `${thoughtEvent}\n[jules][${timeStr}] Polled session status: ${state}\n`);
      }
      if (julesSession.url) {
          session.julesSessionUrl = julesSession.url;
      }
      let prUrl = extractPullRequestUrl(julesSession);
      if (prUrl) {
          if (session.currentPrUrl !== prUrl) {
            session.currentPrUrl = prUrl;
            if (ctx.onLog) {
              await ctx.onLog("stdout", `[jules] Discovered pull request created by Jules: ${prUrl}\n`);
            }
            try {
              await moveIssueToReview(taskId, prUrl, ctx.authToken, ctx.runId);
            } catch {
              /* best-effort early registration */
            }
          }

          const prDetails = await getPullRequestDetails(prUrl);
          if (prDetails.merged) {
            if (ctx.onLog) {
              await ctx.onLog("stdout", `[jules] Pull request ${prUrl} is merged on GitHub. Completing session.\n`);
            }
            await deleteStoredSession(taskId, config.source, config.baseBranch);
            return {
              exitCode: 0,
              signal: null,
              timedOut: false,
              sessionParams: serializeSession(session),
              sessionDisplayId: session.julesSessionId || null,
              summary: `Jules PR ${prUrl} is merged on GitHub. Session completed and recovery state cleared.`,
              resultJson: { provider: "jules", julesSessionId: session.julesSessionId, prUrl, issueStatus: "done", merged: true },
              clearSession: true
            };
          }
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
      // Only flip status if recovering from a non-in_progress state (e.g. was blocked)
      // Otherwise do not call PATCH /api/issues to avoid triggering spurious status events
      if (state === 'IN_PROGRESS' && session.phase !== 'RUNNING') {
        try { await moveIssueToInProgress(taskId, ctx.authToken, undefined, ctx.runId); }
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

             if (session.currentPrUrl) {
               const ciStatus = await getPullRequestCiStatus(session.currentPrUrl);
               if (ciStatus === "pending") {
                 if (ctx.onLog) {
                   await ctx.onLog(
                     "stdout",
                     `[jules] Pull request ${session.currentPrUrl} is awaiting CI build checks to pass before moving to review...\n`,
                   );
                 }
                 session.phase = "RUNNING";
                 await sleep(JULES_POLL_INTERVAL_MS, abortSignal);
                 continue;
               }
               if (ciStatus === "failed") {
                 if (ctx.onLog) {
                   await ctx.onLog(
                     "stderr",
                     `[jules] Pull request ${session.currentPrUrl} CI build checks failed.\n`,
                   );
                 }
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
          const existingInteractions = await listPaperclipInteractions(taskId, ctx.authToken, ctx.runId).catch(() => []);
          let rawQuestionText: string | undefined;
          if (session.phase === "WAITING_FOR_FEEDBACK") {
            let activity = latestAgentMessage(activities);
            if (!activity) {
              const allActivities = await listAllActivities(client, session.julesSessionId!);
              activity = latestAgentMessage(allActivities);
            }
            rawQuestionText = extractQuestionText(activity);
          } else if (session.phase === "WAITING_FOR_PLAN_APPROVAL") {
            const activity = latestPlan(activities);
            rawQuestionText = planMarkdown(activity);
          }

          const action = evaluateInteractionAction(session, state, existingInteractions, rawQuestionText);

          switch (action.type) {
            case "RELAY_FEEDBACK": {
              if (ctx.onLog) {
                await ctx.onLog("stdout", `[jules] Sending answered feedback to Jules: ${action.answer}\n`);
              }
              await client.sendMessage(session.julesSessionId!, { prompt: action.answer });
              session = recordFeedbackRelayed(session, action.interactionId);
              await persistSessionBestEffort(session, ctx.onLog);
              continue;
            }

            case "RELAY_PLAN_APPROVAL": {
              if (ctx.onLog) {
                await ctx.onLog("stdout", `[jules] Sending plan approval to Jules for revision: ${action.planRevisionId}\n`);
              }
              await client.approvePlan(session.julesSessionId!);
              session = recordPlanApprovalRelayed(session);
              await persistSessionBestEffort(session, ctx.onLog);
              continue;
            }

            case "CREATE_FEEDBACK_CARD": {
              let activity = latestAgentMessage(activities);
              if (!activity) {
                const allActivities = await listAllActivities(client, session.julesSessionId!);
                activity = latestAgentMessage(allActivities);
              }
              const activityId = activity?.id ?? "awaiting-user-feedback";
              const interaction = await createJulesFeedbackInteraction(
                taskId, session.julesSessionId!, activityId, action.question, ctx.authToken, action.attempt, ctx.runId,
              );
              session.feedbackInteractionAttempt = action.attempt;
              session.pendingInteraction = {
                type: "user_feedback",
                julesActivityId: asJulesActivityId(activityId),
                paperclipInteractionId: interaction.id,
                question: action.question,
                createdAt: new Date().toISOString(),
              };
              await persistSessionBestEffort(session, ctx.onLog);
              return {
                exitCode: 0,
                signal: null,
                timedOut: false,
                sessionParams: serializeSession(session),
                sessionDisplayId: session.julesSessionId ?? null,
                summary: `Jules session ${session.julesSessionId} awaits feedback in Paperclip.`,
                resultJson: { provider: "jules", issueStatus: "in_progress", interactionId: interaction.id },
                clearSession: false,
              };
            }

            case "CREATE_PLAN_CARD": {
              const activity = latestPlan(activities);
              const activityId = activity?.id ?? "awaiting-plan-approval";
              const interaction = await createJulesPlanApprovalInteraction(
                taskId, session.julesSessionId!, activityId, action.planMarkdown, ctx.authToken, ctx.runId,
              );
              session.pendingInteraction = {
                type: "plan_approval",
                julesActivityId: asJulesActivityId(activityId),
                paperclipInteractionId: interaction.id,
                question: action.planMarkdown,
                planDocumentId: interaction.planRevision.documentId,
                planRevisionId: interaction.planRevision.revisionId,
                planRevisionNumber: interaction.planRevision.revisionNumber,
                createdAt: new Date().toISOString(),
              };
              await persistSessionBestEffort(session, ctx.onLog);
              return {
                exitCode: 0,
                signal: null,
                timedOut: false,
                sessionParams: serializeSession(session),
                sessionDisplayId: session.julesSessionId ?? null,
                summary: `Jules session ${session.julesSessionId} awaits plan approval in Paperclip.`,
                resultJson: { provider: "jules", interactionId: interaction.id },
                clearSession: false,
              };
            }

            case "WAIT_FOR_HUMAN": {
              if (action.interactionId && !session.pendingInteraction) {
                session.pendingInteraction = {
                  type: "user_feedback",
                  julesActivityId: asJulesActivityId("awaiting-user-feedback"),
                  paperclipInteractionId: action.interactionId,
                  question: action.summary,
                  createdAt: new Date().toISOString(),
                };
                await persistSessionBestEffort(session, ctx.onLog);
              }
              return {
                exitCode: 0,
                signal: null,
                timedOut: false,
                sessionParams: serializeSession(session),
                sessionDisplayId: session.julesSessionId ?? null,
                summary: action.summary,
                resultJson: { provider: "jules", issueStatus: "in_progress", interactionId: action.interactionId },
                clearSession: false,
              };
            }

            case "RESET_PAUSED_SESSION": {
              if (ctx.onLog) {
                await ctx.onLog(
                  "stdout",
                  `[jules] Session ${action.sessionId} was paused/archived by operator. Creating fresh Jules session immediately.\n`,
                );
              }
              try {
                await addJulesActivityComment(
                  taskId,
                  "session-paused-reset",
                  `ℹ️ Previous Jules session \`${action.sessionId}\` was paused/archived by the operator. Launching fresh session for this issue.`,
                  session.julesSessionUrl,
                  ctx.authToken,
                  ctx.runId,
                );
              } catch {}
              await deleteStoredSession(taskId, config.source, config.baseBranch).catch(() => {});

              const promptContext = {
                issueId: taskId,
                runId: ctx.runId,
                title: taskTitle,
                description: taskDescription,
                isRetry: false,
                resumeAttempt: 0,
                priorPrUrls: [],
              };
              const prompt = buildPrompt(promptContext, config);
              const pHash = hashPromptIdentity(promptContext, config);

              const newJulesSession = await client.createSession({
                prompt,
                title: taskTitle,
                sourceContext: {
                  source: config.source,
                  githubRepoContext: {
                    startingBranch: config.baseBranch,
                  },
                },
                requirePlanApproval: config.requirePlanApproval,
                automationMode: config.automationMode,
              });

              const freshSession: JulesAdapterSessionV1 = {
                version: 1,
                paperclipIssueId: taskId,
                promptHash: pHash,
                promptHashVersion: PROMPT_IDENTITY_HASH_VERSION,
                repository: config.repository,
                source: config.source,
                baseBranch: config.baseBranch,
                phase: "RUNNING",
                sessionId: newJulesSession.id,
                julesSessionId: newJulesSession.id,
                julesSessionUrl: newJulesSession.url,
                attempt: 1,
                failedSessions: [{
                  sessionId: action.sessionId,
                  failedAt: new Date().toISOString(),
                  message: "Archived by operator",
                  classification: "task",
                }],
                createdAt: new Date().toISOString(),
              };

              session = freshSession;
              await persistSessionBestEffort(freshSession, ctx.onLog);
              if (freshSession.julesSessionUrl) {
                try { await postSessionLink(taskId, freshSession.julesSessionUrl, ctx.authToken, ctx.runId); }
                catch {}
              }
              return createPendingResult(freshSession, true);
            }

            case "CONTINUE_POLLING":
              break;
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
