import { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { AdapterConfig, validateConfig, validateSecrets } from "./config.js";
import { JulesAdapterSessionV1, sessionCodec } from "./session.js";
import { JulesClient } from "./jules-client.js";
import { buildPrompt, hashPrompt } from "./prompt-builder.js";
import { handleJulesState } from "./state-machine.js";
import { classifyFailure } from "./failure-classifier.js";
import { shouldRetry, getRetryNotBefore } from "./retry-policy.js";
import { handleAwaitingUserFeedback, handleAwaitingPlanApproval, processResolvedInteraction } from "./interactions.js";
import { asPaperclipId } from "./brands.js";
import { CtxContextSchema, ResolvedInteractionSchema } from "./context-schemas.js";
import { z } from "zod";

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

// In some integrations resolved interactions are passed on ctx root.
const HostContextSchema = z.object({
  abortSignal: z.instanceof(AbortSignal).optional(),
  resolvedInteractions: z.array(ResolvedInteractionSchema).optional().default([])
}).catchall(z.unknown());

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const config = validateConfig(ctx.agent.adapterConfig);

  // Strict parsing of context
  const parsedCtxContext = CtxContextSchema.parse(ctx.context || {});
  const parsedHostCtx = HostContextSchema.parse(ctx);

  const secrets = validateSecrets(parsedCtxContext.secrets);
  const client = new JulesClient(secrets.JULES_API_KEY);

  let session = ctx.runtime.sessionParams ? sessionCodec.decode(ctx.runtime.sessionParams) : null;
  const pollInterval = config.pollIntervalSeconds * 1000;
  const heartbeatDeadline = Date.now() + (config.heartbeatPollWindowSeconds * 1000);

  const abortSignal = parsedHostCtx.abortSignal || new AbortController().signal;
  const resolvedInteractions = parsedHostCtx.resolvedInteractions;

  const rawTaskId = parsedCtxContext.task?.id || ctx.runtime.taskKey || 'unknown';
  const taskId = asPaperclipId(rawTaskId);
  const taskTitle = parsedCtxContext.task?.title || 'Jules Task';
  const taskDescription = parsedCtxContext.task?.description || '';

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
          repository: config.repository,
          source: config.source,
          baseBranch: config.baseBranch
      });

      session = {
        version: 1,
        paperclipIssueId: taskId,
        promptHash: pHash,
        repository: config.repository,
        source: config.source,
        baseBranch: config.baseBranch,
        phase: 'RUNNING',
        julesSessionId: julesSession.name,
        julesSessionUrl: julesSession.url,
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
          errorFamily: "transient_upstream",
          errorMessage: error instanceof Error ? error.message : "Unknown error",
          retryNotBefore: new Date(getRetryNotBefore(attempt)).toISOString(),
          sessionParams: sessionCodec.encode({
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
              { sessionId: 'unknown', failedAt: new Date().toISOString(), message: error instanceof Error ? error.message : "Unknown error", classification }
            ],
            createdAt: new Date().toISOString()
          }) as Record<string, unknown>,
          clearSession: false
        };
      }

      return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorCode: "jules_create_failure",
          errorFamily: classification === 'transient' ? 'transient_upstream' : null,
          errorMessage: error instanceof Error ? error.message : "Unknown error",
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

  if (session.pendingInteraction && resolvedInteractions.length) {
    if (!session.julesSessionId) throw new Error("Missing julesSessionId during interaction processing");
    const processed = await processResolvedInteraction(client, session.julesSessionId, session.pendingInteraction, resolvedInteractions);
    if (processed) {
      session.pendingInteraction = undefined;
      session.phase = 'RUNNING';
    }
  }

  while (!abortSignal.aborted && Date.now() < heartbeatDeadline) {
    if (!session.julesSessionId) throw new Error("Missing julesSessionId during polling loop");

    try {
      const julesSession = await client.getSession(session.julesSessionId);
      const state = julesSession.state || 'UNKNOWN';
      session.julesState = state;
      session.lastPolledAt = new Date().toISOString();
      if (julesSession.currentPrUrl) {
          session.currentPrUrl = julesSession.currentPrUrl;
      }

      const stateMachineRes = handleJulesState(state, !!julesSession.currentPrUrl);
      session.phase = stateMachineRes.nextPhase;

      if (stateMachineRes.isTerminal) {
         if (session.phase === 'COMPLETED') {
             if (!stateMachineRes.isSuccess) {
                 return {
                     exitCode: 0,
                     signal: null,
                     timedOut: false,
                     sessionParams: sessionCodec.encode(session) as Record<string, unknown>,
                     question: {
                         prompt: `Jules session ${session.julesSessionId} completed but did not create a PR. Check the Jules UI for details.`,
                         choices: [{ key: "ack", label: "Acknowledge" }]
                     },
                     clearSession: false
                 };
             }

             return {
                 exitCode: 0,
                 signal: null,
                 timedOut: false,
                 sessionParams: sessionCodec.encode(session) as Record<string, unknown>,
                 sessionDisplayId: session.julesSessionId || null,
                 summary: `Jules created PR: ${session.currentPrUrl}`,
                 resultJson: { provider: "jules", julesSessionId: session.julesSessionId, prUrl: session.currentPrUrl },
                 clearSession: true
             };
         } else if (session.phase === 'FAILED') {
             const classification = classifyFailure(julesSession.errorInfo || new Error("Explicit Jules Failure"));
             const willRetry = shouldRetry(classification, session.attempt, config);

             if (willRetry) {
                 session.failedSessions.push({
                     sessionId: session.julesSessionId,
                     failedAt: new Date().toISOString(),
                     message: "Jules session failed explicitly",
                     classification
                 });
                 session.phase = 'RETRY_SCHEDULED';
                 return {
                     exitCode: 1,
                     signal: null,
                     timedOut: false,
                     errorCode: "jules_transient_failure",
                     errorFamily: "transient_upstream",
                     errorMessage: "Jules session failed",
                     retryNotBefore: new Date(getRetryNotBefore(session.attempt)).toISOString(),
                     sessionParams: sessionCodec.encode(session) as Record<string, unknown>,
                     clearSession: false
                 };
             } else {
                 return {
                     exitCode: 1,
                     signal: null,
                     timedOut: false,
                     errorCode: "jules_task_failure",
                     errorFamily: null,
                     errorMessage: "Jules session failed and exhausted retries",
                     sessionParams: sessionCodec.encode(session) as Record<string, unknown>,
                     clearSession: false
                 };
             }
         }
      }

      if (stateMachineRes.requiresReturn) {
          let interaction = null;
          if (session.phase === 'WAITING_FOR_FEEDBACK') {
              interaction = await handleAwaitingUserFeedback(client, session.julesSessionId, session);
          } else if (session.phase === 'WAITING_FOR_PLAN_APPROVAL') {
              interaction = await handleAwaitingPlanApproval(client, session.julesSessionId, session);
          }

          if (interaction) {
              if (!interaction.pendingInteraction) throw new Error("Interaction missing pending data");
              session.pendingInteraction = interaction.pendingInteraction;
              return {
                  exitCode: 0,
                  signal: null,
                  timedOut: false,
                  sessionParams: sessionCodec.encode(session) as Record<string, unknown>,
                  question: {
                      prompt: interaction.pendingInteraction.question,
                      choices: [{ key: "answer", label: "Answer (via context)" }]
                  },
                  clearSession: false
              };
          }
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
             errorFamily: classification === 'configuration' ? null : 'transient_upstream',
             errorMessage: error instanceof Error ? error.message : "Unknown error",
             sessionParams: sessionCodec.encode(session) as Record<string, unknown>,
             clearSession: false
          };
      }
    }
  }

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    sessionParams: sessionCodec.encode(session) as Record<string, unknown>,
    clearSession: false
  };
}
