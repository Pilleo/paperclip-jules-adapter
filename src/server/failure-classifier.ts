import { JulesClientError } from './jules-client.js';

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
      return "task"; // Bad request or unprocessable entity - likely task related issue
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
