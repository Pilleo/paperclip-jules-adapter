import { z } from 'zod';
import { JulesSessionId, JulesActivityId, PrUrl, asJulesSessionId, asPrUrl } from './brands.js';

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

export const JulesSessionSchema = z.object({
  name: z.string().min(1),
  url: z.string().optional(),
  state: JulesStateSchema.optional(),
  currentPrUrl: z.string().url().optional(),
  errorInfo: z.unknown().optional()
});

export const JulesActivitySchema = z.object({
  id: z.string().min(1),
  type: z.string(),
  questionText: z.string().optional(),
  answered: z.boolean().optional(),
  planSummary: z.string().optional(),
  approved: z.boolean().optional()
});

export const JulesActivitiesResponseSchema = z.object({
  activities: z.array(JulesActivitySchema).optional()
});

export type JulesSessionRaw = z.infer<typeof JulesSessionSchema>;
export interface JulesSession {
    name: JulesSessionId;
    url?: string | undefined;
    state?: string | undefined;
    currentPrUrl?: PrUrl | undefined;
    errorInfo?: unknown | undefined;
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
      return {
          name: asJulesSessionId(raw.name),
          url: raw.url,
          state: raw.state,
          currentPrUrl: raw.currentPrUrl ? asPrUrl(raw.currentPrUrl) : undefined,
          errorInfo: raw.errorInfo
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
