import { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { AdapterConfig, validateConfig, requireJulesApiKey } from "./config.js";
import { JulesAdapterSessionV1, sessionCodec, serializeSession } from "./session.js";
import { JulesClient, extractPullRequestUrl } from "./jules-client.js";
import { buildPrompt, hashPrompt } from "./prompt-builder.js";
import { handleJulesState } from "./state-machine.js";
import { classifyFailure, toErrorFamily, summarizeJulesFailure } from "./failure-classifier.js";
import { shouldRetry, getRetryNotBefore } from "./retry-policy.js";
import { asPaperclipId } from "./brands.js";
import { CtxContextSchema, HostContextSchema } from "./context-schemas.js";
import { sanitizeError } from "./error-sanitizer.js";

function createAcknowledgeQuestion(sessionId: string) {
    return {
        prompt: `Jules session ${sessionId} completed but did not create a PR. Check the Jules UI for details.`,
        choices: [{ key: "ack", label: "Acknowledge" }]
    };
}

function createPrReviewQuestion(prUrl: string) {
    return {
        prompt: `Jules created a PR: ${prUrl}. Please review and merge it. This task will remain in progress until manually completed or canceled.`,
        choices: [{ key: "ack", label: "Acknowledge (keeps task active)" }]
    };
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
  const config = validateConfig(ctx.agent.adapterConfig);
  const parsedCtxContext = CtxContextSchema.parse(ctx.context || {});
  const parsedHostCtx = HostContextSchema.parse(ctx);

  const apiKey = requireJulesApiKey();
  const client = new JulesClient(apiKey);

  let session = ctx.runtime.sessionParams ? sessionCodec.decode(ctx.runtime.sessionParams) : null;
  const pollInterval = config.pollIntervalSeconds * 1000;
  const heartbeatDeadline = Date.now() + (config.heartbeatPollWindowSeconds * 1000);

  const abortSignal = parsedHostCtx.abortSignal || new AbortController().signal;

  const rawTaskId = parsedCtxContext.task.id;
  const taskId = asPaperclipId(rawTaskId);
  const taskTitle = parsedCtxContext.task.title;
  const taskDescription = parsedCtxContext.task.description;

  if (!session || session.phase === 'RETRY_SCHEDULED') {
    const isRetry = session?.phase === 'RETRY_SCHEDULED';
    const failedSessions = session?.failedSessions || [];
    const attempt = (isRetry && session) ? (session.attempt + 1) : 1;

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
      failedSessionUrl: failedSessionId ? `Session ID: ${failedSessionId}` : undefined,
      failedSessionMessage
    };

    const prompt = buildPrompt(promptContext, config);
    const pHash = hashPrompt(prompt);

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
        repository: config.repository,
        source: config.source,
        baseBranch: config.baseBranch,
        phase: 'RUNNING',
        julesSessionId: julesSession.id,
        attempt,
        failedSessions,
        createdAt: new Date().toISOString()
      };

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
          retryNotBefore: new Date(getRetryNotBefore(attempt)).toISOString(),
          sessionParams: serializeSession({
            version: 1,
            paperclipIssueId: taskId,
            promptHash: pHash,
            repository: config.repository,
            source: config.source,
            baseBranch: config.baseBranch,
            phase: 'RETRY_SCHEDULED',
            attempt,
            failedSessions: [
              ...failedSessions,
              { failedAt: new Date().toISOString(), message: sanitizeError(error), classification }
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

  const currentPromptContext = {
    issueId: taskId,
    runId: ctx.runId,
    title: taskTitle,
    description: taskDescription,
    isRetry: false
  };
  const currentHash = hashPrompt(buildPrompt(currentPromptContext, config));
  if (session.promptHash !== currentHash && session.attempt === 1) {
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
      const prUrl = extractPullRequestUrl(julesSession);
      if (prUrl) {
          session.currentPrUrl = prUrl;
      }

      const stateMachineRes = handleJulesState(state, !!session.currentPrUrl);
      session.phase = stateMachineRes.nextPhase;

      if (stateMachineRes.isTerminal) {
         if (session.phase === 'COMPLETED') {
             if (!stateMachineRes.isSuccess) {
                 return {
                     exitCode: 0,
                     signal: null,
                     timedOut: false,
                     sessionParams: serializeSession(session),
                     question: createAcknowledgeQuestion(session.julesSessionId),
                     clearSession: false
                 };
             }

             return {
                 exitCode: 0,
                 signal: null,
                 timedOut: false,
                 sessionParams: serializeSession(session),
                 sessionDisplayId: session.julesSessionId || null,
                 summary: `Jules created PR: ${session.currentPrUrl}`,
                 resultJson: { provider: "jules", julesSessionId: session.julesSessionId, prUrl: session.currentPrUrl },
                 question: createPrReviewQuestion(session.currentPrUrl!),
                 clearSession: false
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
                     classification
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
          return {
             exitCode: 0,
             signal: null,
             timedOut: false,
             sessionParams: serializeSession(session),
             question: {
                 prompt: `Jules session ${session.julesSessionId} requires feedback (${session.phase}). Please review in Google Jules UI.`,
                 choices: [{ key: "ack", label: "Acknowledge" }]
             },
             clearSession: false
          };
      }

      await sleep(pollInterval, abortSignal);

    } catch (error) {
      const classification = classifyFailure(error);

      if (classification === 'transient') {
         await sleep(pollInterval, abortSignal);
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

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    sessionParams: serializeSession(session),
    clearSession: false
  };
}
