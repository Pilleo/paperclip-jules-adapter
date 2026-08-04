export interface CreateSessionRequest {
  title?: string;
  prompt: string;
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
      'X-Goog-Api-Key': this.apiKey, // Assuming Jules API uses this header based on typical Google Cloud APIs
      ...options.headers,
    };

    const response = await fetch(url, { ...options, headers });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new JulesClientError(response.status, `Jules API error (${response.status}): ${errorText}`);
    }

    // Handle 204 No Content
    if (response.status === 204) {
      return null;
    }

    return response.json();
  }

  async createSession(request: CreateSessionRequest) {
    return this.fetchApi('/sessions', {
      method: 'POST',
      body: JSON.stringify(request)
    });
  }

  async getSession(sessionId: string) {
    return this.fetchApi(`/sessions/${encodeURIComponent(sessionId)}`);
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
