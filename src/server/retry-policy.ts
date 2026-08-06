import { FailureClassification } from './failure-classifier.js';
import { AdapterConfig } from './config.js';

export function getRetryNotBefore(failedAttemptCount: number): number {
  const delays = [2, 10, 30]; // Minutes

  // Example counting based on explicit feedback requesting failure counting:
  // attempt 1 fails -> failedAttemptCount = 1 -> delay 2 min
  // attempt 2 fails -> failedAttemptCount = 2 -> delay 10 min
  // attempt 3 fails -> failedAttemptCount = 3 -> delay 30 min
  const index = Math.max(0, failedAttemptCount - 1);
  const delayMinutes = delays[Math.min(index, delays.length - 1)] ?? 30;

  return Date.now() + delayMinutes * 60 * 1000;
}

export function shouldRetry(
  classification: FailureClassification,
  failedAttemptCount: number,
  config: AdapterConfig
): boolean {
  if (classification === "configuration" || classification === "task") {
    return false;
  }

  if (classification === "unknown") {
    // Allows 1 retry
    return failedAttemptCount < 2; // if attempt 1 fails, failedAttemptCount is 1 -> < 2 -> true.
  }

  if (classification === "transient") {
    return failedAttemptCount <= config.maxAutomaticRestarts;
  }

  return false;
}
