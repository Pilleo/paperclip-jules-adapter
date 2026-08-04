import { z } from 'zod';

export interface CreateSessionRequest {
  title?: string;
  prompt: string;
  repository?: string;
  source?: string;
  baseBranch?: string;
}

export interface SendMessageRequest {
  message: string;
}

export interface ApprovePlanRequest {
  approved: boolean;
  reason?: string;
}

export class JulesClientError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'JulesClientError';
  }
}

// Ensure strict Zod shapes for API models returned by Jules to avoid guessed fields
export const JulesSessionSchema = z.object({
  name: z.string().min(1),
  url: z.string().optional(),
  state: z.string().optional(),
  currentPrUrl: z.string().optional(),
  errorInfo: z.any().optional()
});
export type JulesSession = z.infer<typeof JulesSessionSchema>;

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
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new JulesClientError(response.status, `Jules API error (${response.status}): ${errorText}`);
    }

    if (response.status === 204) {
      return null;
    }

    const data = await response.json();
    return data;
  }

  async createSession(request: CreateSessionRequest): Promise<JulesSession> {
    const data = await this.fetchApi('/sessions', {
      method: 'POST',
      body: JSON.stringify(request)
    });
    return JulesSessionSchema.parse(data);
  }

  async getSession(sessionId: string): Promise<JulesSession> {
    const data = await this.fetchApi(`/sessions/${encodeURIComponent(sessionId)}`);
    return JulesSessionSchema.parse(data);
  }

  async getActivities(sessionId: string, pageToken?: string) {
    const url = new URL(`${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}/activities`);
    if (pageToken) {
        url.searchParams.append('pageToken', pageToken);
    }
    return this.fetchApi(url.pathname + url.search);
  }

  async sendMessage(sessionId: string, request: SendMessageRequest) {
    return this.fetchApi(`/sessions/${encodeURIComponent(sessionId)}:sendMessage`, {
      method: 'POST',
      body: JSON.stringify(request)
    });
  }

  async approvePlan(sessionId: string, request: ApprovePlanRequest) {
    return this.fetchApi(`/sessions/${encodeURIComponent(sessionId)}:approvePlan`, {
      method: 'POST',
      body: JSON.stringify(request)
    });
  }
}
