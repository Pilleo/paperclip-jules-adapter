const PAPERCLIP_API_URL_ENV = "PAPERCLIP_API_URL";

export class PaperclipClientError extends Error {
  constructor(public readonly status: number | null, message: string) {
    super(message);
    this.name = "PaperclipClientError";
  }
}

export interface PaperclipInteraction {
  id: string;
  status: string;
  kind?: string;
  result?: unknown;
}

function paperclipApiBaseUrl(): string {
  return (process.env[PAPERCLIP_API_URL_ENV] ?? "http://127.0.0.1:3100").replace(/\/+$/, "");
}

function requireAuthToken(authToken: string | undefined): string {
  if (!authToken) throw new PaperclipClientError(null, "Paperclip local agent token is unavailable");
  return authToken;
}

async function paperclipRequest(
  path: string,
  authToken: string | undefined,
  init: RequestInit,
  runId?: string,
): Promise<Response> {
  const token = requireAuthToken(authToken);
  let response: Response;
  try {
    response = await fetch(`${paperclipApiBaseUrl()}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(runId ? { "X-Paperclip-Run-Id": runId } : {}),
        ...init.headers,
      },
      signal: init.signal ?? AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new PaperclipClientError(null, `Paperclip API request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    const detail = typeof response.text === "function" ? await response.text().catch(() => "") : "";
    const suffix = detail.trim() ? ": " + detail.trim().slice(0, 500) : "";
    throw new PaperclipClientError(response.status, "Paperclip API request failed (" + response.status + ")" + suffix);
  }
  return response;
}

async function moveIssue(
  issueId: string,
  status: "blocked" | "done" | "in_review",
  authToken: string | undefined,
  comment?: string,
  runId?: string,
): Promise<void> {
  await paperclipRequest(`/api/issues/${encodeURIComponent(issueId)}`, authToken, {
    method: "PATCH",
    body: JSON.stringify({ status, ...(comment ? { comment } : {}) }),
  }, runId);
}

export async function moveIssueToReview(
  issueId: string,
  prUrl: string,
  authToken: string | undefined,
  runId?: string,
): Promise<void> {
  await moveIssue(issueId, "in_review", authToken, `Jules completed this task and created PR: ${prUrl}`, runId);
}

export async function moveIssueToBlocked(
  issueId: string,
  authToken: string | undefined,
  runId?: string,
): Promise<void> {
  await moveIssue(issueId, "blocked", authToken, undefined, runId);
}

export async function moveIssueToDone(
  issueId: string,
  sessionId: string,
  authToken: string | undefined,
  runId?: string,
): Promise<void> {
  await moveIssue(issueId, "done", authToken, `Confirmed completion of Jules session ${sessionId} without a PR.`, runId);
}

function interactionFromResponse(raw: unknown, status: number): PaperclipInteraction {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new PaperclipClientError(status, "Paperclip returned an invalid interaction response");
  }
  const record = raw as Record<string, unknown>;
  const id = record["id"];
  const interactionStatus = record["status"];
  if (typeof id !== "string" || id.length === 0 || typeof interactionStatus !== "string") {
    throw new PaperclipClientError(status, "Paperclip returned an invalid interaction response");
  }
  return {
    id,
    status: interactionStatus,
    result: record["result"],
    ...(typeof record["kind"] === "string" ? { kind: record["kind"] } : {}),
  };
}

export async function addJulesActivityComment(
  issueId: string,
  activityId: string,
  body: string,
  sessionUrl: string | undefined,
  authToken: string | undefined,
  runId?: string,
): Promise<void> {
  const details = sessionUrl ? `\n\n[Open Jules session](${sessionUrl})` : "";
  await paperclipRequest(`/api/issues/${encodeURIComponent(issueId)}/comments`, authToken, {
    method: "POST",
    body: JSON.stringify({
      body: `${body}${details}`,
      authorType: "agent",
    }),
  }, runId);
}

export async function createJulesFeedbackInteraction(
  issueId: string,
  sessionId: string,
  activityId: string,
  question: string,
  authToken: string | undefined,
  attempt = 1,
  runId?: string,
): Promise<PaperclipInteraction> {
  const response = await paperclipRequest(
    `/api/issues/${encodeURIComponent(issueId)}/interactions`, authToken, {
      method: "POST",
      body: JSON.stringify({
        kind: "ask_user_questions",
        idempotencyKey: `jules:user-feedback:${issueId}:${sessionId}:${activityId}:${attempt}`,
        title: "Reply to Jules",
        summary: "Jules is waiting for feedback.",
        continuationPolicy: "wake_assignee",
        payload: {
          version: 1,
          title: "Reply to Jules",
          submitLabel: "Send to Jules",
          questions: [{
            id: "reply",
            prompt: question.slice(0, 500),
            helpText: "Enter your response in the Other field.",
            selectionMode: "single",
            required: true,
            options: [{ id: "other", label: "Write a response" }],
          }],
        },
      }),
    },
    runId,
  );
  return interactionFromResponse(await response.json(), response.status);
}

export async function createJulesPlanApprovalInteraction(
  issueId: string,
  sessionId: string,
  activityId: string,
  planMarkdown: string,
  authToken: string | undefined,
  runId?: string,
): Promise<PaperclipInteraction> {
  const response = await paperclipRequest(
    `/api/issues/${encodeURIComponent(issueId)}/interactions`, authToken, {
      method: "POST",
      body: JSON.stringify({
        kind: "request_confirmation",
        idempotencyKey: `jules:plan-approval:${issueId}:${sessionId}:${activityId}`,
        title: "Approve Jules plan",
        summary: "Jules is waiting for plan approval.",
        continuationPolicy: "wake_assignee",
        payload: {
          version: 1,
          prompt: "Approve this Jules plan?",
          acceptLabel: "Approve plan",
          rejectLabel: "Keep blocked",
          rejectRequiresReason: true,
          rejectReasonLabel: "Reason for keeping the plan blocked",
          detailsMarkdown: planMarkdown,
        },
      }),
    },
    runId,
  );
  return interactionFromResponse(await response.json(), response.status);
}

export async function getPaperclipInteraction(
  issueId: string,
  interactionId: string,
  authToken: string | undefined,
  runId?: string,
): Promise<PaperclipInteraction | null> {
  const response = await paperclipRequest(`/api/issues/${encodeURIComponent(issueId)}/interactions`, authToken, {
    method: "GET",
  }, runId);
  const raw: unknown = await response.json();
  if (!Array.isArray(raw)) throw new PaperclipClientError(response.status, "Paperclip returned an invalid interactions response");
  const match = raw.find((value) => typeof value === "object" && value !== null && (value as Record<string, unknown>)["id"] === interactionId);
  return match ? interactionFromResponse(match, response.status) : null;
}

export async function createNoPrCompletionInteraction(
  issueId: string,
  sessionId: string,
  sessionUrl: string | undefined,
  authToken: string | undefined,
  runId?: string,
): Promise<PaperclipInteraction> {
  const details = [
    `Jules session: \`${sessionId}\``,
    sessionUrl ? `[Open the Jules session](${sessionUrl})` : null,
    "Accept to mark this task done. Reject to keep it blocked for manual follow-up.",
  ].filter((value): value is string => value !== null).join("\n\n");
  const response = await paperclipRequest(
    `/api/issues/${encodeURIComponent(issueId)}/interactions`,
    authToken,
    {
      method: "POST",
      body: JSON.stringify({
        kind: "request_confirmation",
        idempotencyKey: `jules:no-pr-completion:${issueId}:${sessionId}`,
        title: "Confirm Jules completion without a PR",
        summary: `Jules session ${sessionId} completed without creating a pull request.`,
        continuationPolicy: "wake_assignee",
        payload: {
          version: 1,
          prompt: "Jules completed without a PR. Is this task complete?",
          acceptLabel: "Mark done",
          rejectLabel: "Keep blocked",
          rejectRequiresReason: false,
          detailsMarkdown: details,
        },
      }),
    },
    runId,
  );
  return interactionFromResponse(await response.json(), response.status);
}
