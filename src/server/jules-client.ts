import { z } from 'zod';
import { JulesSessionName, JulesSessionId, JulesActivityId, PrUrl, parseJulesSessionName, toJulesSessionId, asPrUrl } from './brands.js';

export interface CreateSessionRequest {
  title?: string | undefined;
  prompt: string;
  repository?: string | undefined;
  source?: string | undefined;
  baseBranch?: string | undefined;
}

export interface SendMessageRequest {
  message: string;
}

export interface ApprovePlanRequest {
  approved: boolean;
  reason?: string | undefined;
}

export class JulesClientError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'JulesClientError';
  }
}

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
  state: JulesStateSchema.optional(),
  outputs: z.array(z.unknown()).optional(),
  errorInfo: z.unknown().optional()
}).catchall(z.unknown());

export const JulesActivitySchema = z.object({
  id: z.string().min(1),
  type: z.string(),
  questionText: z.string().optional(),
  answered: z.boolean().optional(),
  planSummary: z.string().optional(),
  approved: z.boolean().optional()
}).catchall(z.unknown());

export const JulesActivitiesResponseSchema = z.object({
  activities: z.array(JulesActivitySchema).optional()
}).catchall(z.unknown());

export type JulesSessionRaw = z.infer<typeof JulesSessionSchema>;

export interface JulesSession {
    name: JulesSessionName;
    id: JulesSessionId;
    state?: string | undefined;
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

    const response = await fetch(url, { ...options, headers });

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

    const data = await response.json();
    return data;
  }

  private mapSession(raw: JulesSessionRaw): JulesSession {
      const name = parseJulesSessionName(raw.name);
      return {
          name,
          id: toJulesSessionId(name),
          state: raw.state,
          errorInfo: raw.errorInfo ? toJulesFailure(raw.errorInfo) : undefined,
          rawOutputs: raw.outputs
      };
  }

  async createSession(request: CreateSessionRequest): Promise<JulesSession> {
    const data = await this.fetchApi('/sessions', {
      method: 'POST',
      body: JSON.stringify(request)
    });
    return this.mapSession(JulesSessionSchema.parse(data));
  }

  async getSession(sessionId: JulesSessionId): Promise<JulesSession> {
    const data = await this.fetchApi(`/sessions/${encodeURIComponent(sessionId)}`);
    return this.mapSession(JulesSessionSchema.parse(data));
  }

  async getActivities(sessionId: JulesSessionId, pageToken?: string) {
    const url = new URL(`${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}/activities`);
    if (pageToken) {
        url.searchParams.append('pageToken', pageToken);
    }
    const data = await this.fetchApi(url.pathname + url.search);
    return JulesActivitiesResponseSchema.parse(data);
  }

  async sendMessage(sessionId: JulesSessionId, request: SendMessageRequest) {
    return this.fetchApi(`/sessions/${encodeURIComponent(sessionId)}:sendMessage`, {
      method: 'POST',
      body: JSON.stringify(request)
    });
  }

  async approvePlan(sessionId: JulesSessionId, request: ApprovePlanRequest) {
    return this.fetchApi(`/sessions/${encodeURIComponent(sessionId)}:approvePlan`, {
      method: 'POST',
      body: JSON.stringify(request)
    });
  }
}
