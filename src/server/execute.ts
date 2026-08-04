import { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { AdapterConfig, validateConfig, validateSecrets } from "./config.js";
import { JulesAdapterSessionV1, sessionCodec } from "./session.js";
import { JulesClient, JulesClientError } from "./jules-client.js";
import { buildPrompt, hashPrompt } from "./prompt-builder.js";
import { handleJulesState } from "./state-machine.js";
import { classifyFailure } from "./failure-classifier.js";
import { shouldRetry, getRetryNotBefore } from "./retry-policy.js";
import { handleAwaitingUserFeedback, handleAwaitingPlanApproval, processResolvedInteraction } from "./interactions.js";

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}

export async function execute(ctx: any): Promise<any> {
  const config = validateConfig(ctx.adapterConfig);
  const secrets = validateSecrets(ctx.secrets || {});
  const client = new JulesClient(secrets.JULES_API_KEY);

  let session = ctx.sessionParams ? sessionCodec.decode(ctx.sessionParams) : null;
  const pollInterval = config.pollIntervalSeconds * 1000;
  const heartbeatDeadline = Date.now() + (config.heartbeatPollWindowSeconds * 1000);

  if (!session || session.phase === 'RETRY_SCHEDULED') {
    const issueId = ctx.task.id;
    const runId = ctx.runId;
    const isRetry = session?.phase === 'RETRY_SCHEDULED';
    const failedSessions = session?.failedSessions || [];
    const attempt = isRetry ? (session!.attempt + 1) : 1;

    let failedSessionUrl, failedSessionMessage;
    if (isRetry && failedSessions.length > 0) {
       const lastFailed = failedSessions[failedSessions.length - 1];
       failedSessionUrl = lastFailed.sessionId;
       failedSessionMessage = lastFailed.message;
    }

    const promptContext = {
      issueId,
      runId,
      title: ctx.task.title,
      description: ctx.task.description || '',
      isRetry,
      failedSessionUrl,
      failedSessionMessage
    };

    const prompt = buildPrompt(promptContext, config);
    const pHash = hashPrompt(prompt);

    try {
      const julesSession = await client.createSession({ prompt });

      session = {
        version: 1,
        paperclipIssueId: issueId,
        promptHash: pHash,
        repository: config.repository,
        source: config.source,
        baseBranch: config.baseBranch,
        phase: 'RUNNING',
        julesSessionId: julesSession.name, // Assuming API returns `name` as ID
        julesSessionUrl: julesSession.url, // If available
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
          retryNotBefore: getRetryNotBefore(attempt),
          sessionParams: sessionCodec.encode({
            version: 1,
            paperclipIssueId: issueId,
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
          }),
          clearSession: false
        };
      }
      throw error;
    }
  }

  // Ensure prompt hash matches if it's not a retry
  const currentPromptContext = {
    issueId: ctx.task.id,
    runId: ctx.runId,
    title: ctx.task.title,
    description: ctx.task.description || '',
    isRetry: false
  };
  const currentHash = hashPrompt(buildPrompt(currentPromptContext, config));
  if (session.promptHash !== currentHash && session.attempt === 1) {
    // Task identity changed in Paperclip
    session.promptHash = currentHash; // In reality might want to restart, but following spec
  }

  // Handle resolved interactions
  if (session.pendingInteraction && ctx.resolvedInteractions?.length) {
    const processed = await processResolvedInteraction(client, session.julesSessionId!, session.pendingInteraction, ctx.resolvedInteractions);
    if (processed) {
      session.pendingInteraction = undefined;
      session.phase = 'RUNNING';
    }
  }

  // Bounded Polling Loop
  while (!ctx.abortSignal?.aborted && Date.now() < heartbeatDeadline) {
    try {
      const julesSession = await client.getSession(session.julesSessionId!);
      const state = julesSession.state || 'UNKNOWN';
      session.julesState = state;
      session.lastPolledAt = new Date().toISOString();
      session.currentPrUrl = julesSession.currentPrUrl;

      const stateMachineRes = handleJulesState(state, !!julesSession.currentPrUrl);
      session.phase = stateMachineRes.nextPhase;

      if (stateMachineRes.isTerminal) {
         if (session.phase === 'COMPLETED') {
             return {
                 exitCode: 0,
                 signal: null,
                 timedOut: false,
                 sessionParams: sessionCodec.encode(session),
                 sessionDisplayId: session.julesSessionId,
                 summary: stateMachineRes.isSuccess ? `Jules created PR: ${session.currentPrUrl}` : `Jules completed without a PR`,
                 resultJson: { provider: "jules", julesSessionId: session.julesSessionId, prUrl: session.currentPrUrl },
                 clearSession: true
             };
         } else if (session.phase === 'FAILED') {
             // Handle Jules FAILED state with retry policy
             const classification = "task"; // Jules explicit failure usually means task failure, adjust based on real API
             const willRetry = shouldRetry(classification, session.attempt, config);

             if (willRetry) {
                 session.failedSessions.push({
                     sessionId: session.julesSessionId!,
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
                     retryNotBefore: getRetryNotBefore(session.attempt),
                     sessionParams: sessionCodec.encode(session),
                     clearSession: false
                 };
             } else {
                 return {
                     exitCode: 1,
                     signal: null,
                     timedOut: false,
                     errorCode: "jules_task_failure",
                     errorFamily: "client",
                     errorMessage: "Jules session failed and exhausted retries",
                     sessionParams: sessionCodec.encode(session),
                     clearSession: false // Retain for manual intervention
                 };
             }
         }
      }

      if (stateMachineRes.requiresReturn) {
          let interaction = null;
          if (session.phase === 'WAITING_FOR_FEEDBACK') {
              interaction = await handleAwaitingUserFeedback(client, session.julesSessionId!, session);
          } else if (session.phase === 'WAITING_FOR_PLAN_APPROVAL') {
              interaction = await handleAwaitingPlanApproval(client, session.julesSessionId!, session);
          }

          if (interaction) {
              session.pendingInteraction = interaction.pendingInteraction;
              return {
                  exitCode: 0,
                  signal: null,
                  timedOut: false,
                  sessionParams: sessionCodec.encode(session),
                  interactions: [interaction.paperclipInteraction],
                  clearSession: false
              };
          }
      }

      // Wait for next poll inside heartbeat
      await sleep(pollInterval, ctx.abortSignal);

    } catch (error) {
      const classification = classifyFailure(error);

      if (classification === 'transient') {
         // If transient during poll, we can just let it loop if time permits, or return retry
         await sleep(pollInterval, ctx.abortSignal);
         continue; // Try again in loop
      } else {
          // Unrecoverable polling error (e.g., config error)
          return {
             exitCode: 1,
             signal: null,
             timedOut: false,
             errorCode: "jules_polling_error",
             errorFamily: "client",
             errorMessage: error instanceof Error ? error.message : "Unknown error",
             sessionParams: sessionCodec.encode(session),
             clearSession: false
          };
      }
    }
  }

  // Heartbeat deadline reached or aborted, return current state
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    sessionParams: sessionCodec.encode(session),
    clearSession: false
  };
}
