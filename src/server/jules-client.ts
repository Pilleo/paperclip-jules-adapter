import { z } from 'zod';
import { JulesSessionName, JulesSessionId, JulesActivityId, PrUrl, parseJulesSessionName, toJulesSessionId, asPrUrl } from './brands.js';

export const JulesCreateSessionRequestSchema = z.object({
  title: z.string().optional(),
  prompt: z.string(),
  sourceContext: z.object({
    source: z.string(),
    githubRepoContext: z.object({
      startingBranch: z.string()
    }).optional() // We make this optional or dynamic if there are other source contexts, but for now we expect github
  }),
  requirePlanApproval: z.boolean().optional(),
  automationMode: z.string().optional()
});

export type CreateSessionRequest = z.infer<typeof JulesCreateSessionRequestSchema>;

export interface SendMessageRequest {
  prompt: string;
}

export class JulesClientError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'JulesClientError';
  }
}

// A provider request should never hold a Paperclip heartbeat indefinitely.
// Long-running work happens inside Jules; the control-plane calls themselves
// are expected to return promptly.
const JULES_API_REQUEST_TIMEOUT_MS = 30_000;

export const JulesStateSchema = z.enum([
  'QUEUED',
  'PLANNING',
  'IN_PROGRESS',
  'PAUSED',
  'AWAITING_USER_FEEDBACK',
  'AWAITING_PLAN_APPROVAL',
  'COMPLETED',
  'FAILED'
]).or(z.string());

const PullRequestOutputSchema = z.object({
  pullRequest: z.object({
    url: z.string().url()
  }).catchall(z.unknown())
}).catchall(z.unknown());

export const JulesFailureSchema = z.object({
  code: z.number().or(z.string()).optional(),
  message: z.string().optional(),
  status: z.string().optional()
}).catchall(z.unknown());

export type JulesFailure = z.infer<typeof JulesFailureSchema>;

export const JulesSessionSchema = z.object({
  name: z.string().min(1),
  title: z.string().optional(),
  prompt: z.string().optional(),
  sourceContext: z.object({
    source: z.string(),
    githubRepoContext: z.object({
      startingBranch: z.string()
    }).optional()
  }).optional(),
  createTime: z.string().optional(),
  updateTime: z.string().optional(),
  url: z.string().url().optional(),
  state: JulesStateSchema.optional(),
  outputs: z.array(z.unknown()).optional(),
  errorInfo: z.unknown().optional()
}).catchall(z.unknown());

export const JulesSessionsResponseSchema = z.object({
  sessions: z.array(JulesSessionSchema).optional(),
  nextPageToken: z.string().optional()
}).catchall(z.unknown());

const JulesPlanStepSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  description: z.string().optional(),
  // Live Jules responses may omit this output-only field; their array order
  // remains the canonical plan order.
  index: z.number().int().optional(),
}).catchall(z.unknown());

const JulesActivityContentSchema = z.object({
  agentMessaged: z.object({ agentMessage: z.string() }).optional(),
  userMessaged: z.object({ userMessage: z.string() }).optional(),
  planGenerated: z.object({
    plan: z.object({
      id: z.string().min(1),
      steps: z.array(JulesPlanStepSchema),
      createTime: z.string().optional(),
    }).catchall(z.unknown()),
  }).optional(),
  planApproved: z.object({ planId: z.string().min(1) }).optional(),
  progressUpdated: z.object({ title: z.string(), description: z.string().optional() }).optional(),
  sessionCompleted: z.unknown().optional(),
  sessionFailed: z.object({ reason: z.string() }).optional(),
}).catchall(z.unknown());

export const JulesActivitySchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  createTime: z.string().optional(),
  originator: z.string().optional(),
}).merge(JulesActivityContentSchema).catchall(z.unknown());

export const JulesActivitiesResponseSchema = z.object({
  activities: z.array(JulesActivitySchema).optional(),
  nextPageToken: z.string().optional(),
}).catchall(z.unknown());

export type JulesActivity = z.infer<typeof JulesActivitySchema>;

export type JulesSessionRaw = z.infer<typeof JulesSessionSchema>;

export interface JulesSession {
    name: JulesSessionName;
    id: JulesSessionId;
    state?: string | undefined;
    title?: string | undefined;
    prompt?: string | undefined;
    source?: string | undefined;
    baseBranch?: string | undefined;
    createTime?: string | undefined;
    updateTime?: string | undefined;
    url?: string | undefined;
    errorInfo?: JulesFailure | undefined;
    rawOutputs?: unknown[] | undefined;
}

export function extractPullRequestUrl(session: JulesSession): PrUrl | undefined {
    if (!session.rawOutputs || !Array.isArray(session.rawOutputs)) {
        return undefined;
    }
    for (const output of session.rawOutputs) {
        const parsed = PullRequestOutputSchema.safeParse(output);
        if (parsed.success && parsed.data.pullRequest.url) {
            return asPrUrl(parsed.data.pullRequest.url);
        }
    }
    return undefined;
}

export function toJulesFailure(errorInfo: unknown): JulesFailure {
    if (!errorInfo) return {};
    const parsed = JulesFailureSchema.safeParse(errorInfo);
    return parsed.success ? parsed.data : {};
}

export class JulesClient {
  private baseUrl = 'https://jules.googleapis.com/v1alpha';

  constructor(private apiKey: string) {
    if (!apiKey) {
      throw new Error("Jules API key is required");
    }
  }

  private async fetchApi(path: string, options: RequestInit = {}) {
    const url = `${this.baseUrl}${path}`;
    const headers = {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': this.apiKey,
      ...options.headers,
    };

    const response = await fetch(url, {
      ...options,
      headers,
      signal: options.signal ?? AbortSignal.timeout(JULES_API_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      let errorText: unknown = 'Unknown error';
      try {
        errorText = await response.text();
      } catch (err) {
        // parsing failed
      }
      throw new JulesClientError(response.status, `Jules API error (${response.status}): ${typeof errorText === 'string' ? errorText : 'Unknown error'}`);
    }

    if (response.status === 204) {
      return null;
    }

    try {
      return await response.json();
    } catch {
      // approvePlan and sendMessage deliberately return an empty response body.
      return null;
    }
  }

  private mapSession(raw: JulesSessionRaw): JulesSession {
      const name = parseJulesSessionName(raw.name);
      return {
          name,
          id: toJulesSessionId(name),
          state: raw.state,
          title: raw.title,
          prompt: raw.prompt,
          source: raw.sourceContext?.source,
          baseBranch: raw.sourceContext?.githubRepoContext?.startingBranch,
          createTime: raw.createTime,
          updateTime: raw.updateTime,
          url: raw.url,
          errorInfo: raw.errorInfo ? toJulesFailure(raw.errorInfo) : undefined,
          rawOutputs: raw.outputs
      };
  }

  async createSession(request: CreateSessionRequest): Promise<JulesSession> {
    const payload = JulesCreateSessionRequestSchema.parse(request);
    const data = await this.fetchApi('/sessions', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    return this.mapSession(JulesSessionSchema.parse(data));
  }

  async getSession(sessionId: JulesSessionId): Promise<JulesSession> {
    const data = await this.fetchApi(`/sessions/${encodeURIComponent(sessionId)}`);
    return this.mapSession(JulesSessionSchema.parse(data));
  }

  async listSessions(pageSize = 100, pageToken?: string): Promise<{
    sessions: JulesSession[];
    nextPageToken?: string | undefined;
  }> {
    const searchParams = new URLSearchParams({ pageSize: String(pageSize) });
    if (pageToken) searchParams.set('pageToken', pageToken);

    const data = JulesSessionsResponseSchema.parse(
      await this.fetchApi(`/sessions?${searchParams.toString()}`)
    );
    return {
      sessions: (data.sessions ?? []).map((raw) => this.mapSession(raw)),
      nextPageToken: data.nextPageToken
    };
  }

  async getActivities(sessionId: JulesSessionId, pageToken?: string, pageSize = 100) {
    const searchParams = new URLSearchParams({ pageSize: String(pageSize) });
    if (pageToken) searchParams.set('pageToken', pageToken);
    const data = await this.fetchApi(
      `/sessions/${encodeURIComponent(sessionId)}/activities?${searchParams.toString()}`,
    );
    return JulesActivitiesResponseSchema.parse(data);
  }

  async sendMessage(sessionId: JulesSessionId, request: SendMessageRequest) {
    return this.fetchApi(`/sessions/${encodeURIComponent(sessionId)}:sendMessage`, {
      method: 'POST',
      body: JSON.stringify(request)
    });
  }

  async approvePlan(sessionId: JulesSessionId) {
    return this.fetchApi(`/sessions/${encodeURIComponent(sessionId)}:approvePlan`, {
      method: 'POST',
    });
  }
}
