import { describe, it, expect } from 'vitest';
import { classifyFailure } from '../src/server/failure-classifier';
import { shouldRetry, getRetryNotBefore } from '../src/server/retry-policy';
import { JulesClientError } from '../src/server/jules-client';
import { AdapterConfig } from '../src/server/config';

describe('Failure Recovery & Retry Policy', () => {
  const config = { maxAutomaticRestarts: 3 } as AdapterConfig;

  describe('classifyFailure', () => {
    it('classifies 500 as transient', () => {
      expect(classifyFailure(new JulesClientError(500, 'Internal Error'))).toBe('transient');
    });

    it('classifies 429 as transient', () => {
      expect(classifyFailure(new JulesClientError(429, 'Too Many Requests'))).toBe('transient');
    });

    it('classifies 401 as configuration', () => {
      expect(classifyFailure(new JulesClientError(401, 'Unauthorized'))).toBe('configuration');
    });

    it('classifies 400 as task', () => {
      expect(classifyFailure(new JulesClientError(400, 'Bad Request'))).toBe('task');
    });

    it('classifies network errors as transient', () => {
      expect(classifyFailure(new Error('fetch failed'))).toBe('transient');
    });

    it('classifies unexpected errors as unknown', () => {
      expect(classifyFailure(new Error('something weird'))).toBe('unknown');
    });
  });

  describe('shouldRetry', () => {
    it('does not retry configuration errors', () => {
      expect(shouldRetry('configuration', 1, config)).toBe(false);
    });

    it('does not retry task errors', () => {
      expect(shouldRetry('task', 1, config)).toBe(false);
    });

    it('retries unknown errors once', () => {
      expect(shouldRetry('unknown', 1, config)).toBe(true);
      expect(shouldRetry('unknown', 2, config)).toBe(false);
    });

    it('retries transient errors up to maxAutomaticRestarts', () => {
      expect(shouldRetry('transient', 1, config)).toBe(true);
      expect(shouldRetry('transient', 3, config)).toBe(true);
      expect(shouldRetry('transient', 4, config)).toBe(false);
    });
  });

  describe('getRetryNotBefore', () => {
    it('returns correct delay for attempt 1', () => {
      const now = Date.now();
      const notBefore = getRetryNotBefore(1);
      const delayMinutes = (notBefore - now) / 1000 / 60;
      expect(Math.round(delayMinutes)).toBe(2);
    });

    it('returns correct delay for attempt 3', () => {
      const now = Date.now();
      const notBefore = getRetryNotBefore(3);
      const delayMinutes = (notBefore - now) / 1000 / 60;
      expect(Math.round(delayMinutes)).toBe(30);
    });
  });
});
