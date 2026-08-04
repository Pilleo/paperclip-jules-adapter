import { JulesClientError } from './jules-client.js';

export type AdapterExecutionErrorFamily = "transient_upstream" | "provider_quota" | "model_refusal" | "refresh_token_reused" | "refresh_token_expired" | "refresh_token_invalidated";

export type FailureClassification = "transient" | "configuration" | "task" | "unknown";

export function classifyFailure(error: unknown): FailureClassification {
  if (error instanceof JulesClientError) {
    if (error.status === 429 || error.status >= 500) {
      return "transient";
    }
    if (error.status === 401 || error.status === 403) {
      return "configuration";
    }
    if (error.status === 400 || error.status === 422) {
      return "task"; // Bad request or unprocessable entity
    }
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase();

    if (message.includes('network') || message.includes('timeout') || message.includes('fetch failed')) {
      return "transient";
    }

    if (message.includes('unauthorized') || message.includes('forbidden') || message.includes('api key')) {
        return "configuration";
    }
  }

  return "unknown";
}

export function toErrorFamily(classification: FailureClassification): AdapterExecutionErrorFamily | null {
  switch (classification) {
    case "transient":
      return "transient_upstream";
    case "configuration":
    case "task":
    case "unknown":
      return null;
  }
}
