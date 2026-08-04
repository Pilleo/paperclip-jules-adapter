import { FailureClassification } from './failure-classifier.js';
import { AdapterConfig } from './config.js';

export function getRetryNotBefore(attempt: number): number {
  const delays = [2, 10, 30]; // Minutes
  const delayMinutes = delays[Math.min(attempt - 1, delays.length - 1)] ?? 30;
  return Date.now() + delayMinutes * 60 * 1000;
}

export function shouldRetry(
  classification: FailureClassification,
  attempt: number,
  config: AdapterConfig
): boolean {
  if (classification === "configuration" || classification === "task") {
    return false;
  }

  if (classification === "unknown") {
    return attempt <= 1;
  }

  if (classification === "transient") {
    return attempt <= config.maxAutomaticRestarts;
  }

  return false;
}
