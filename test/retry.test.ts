import { describe, it, expect } from 'vitest';
import { shouldRetry, getRetryNotBefore } from '../src/server/retry-policy';
import { AdapterConfig } from '../src/server/config';

describe('Failure Recovery & Retry Policy', () => {
  const config = { maxAutomaticRestarts: 3 } as AdapterConfig;

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

    it('retries transient errors up to maxAutomaticRestarts bounds precisely tracking attempt counts', () => {
      // 1st failure (attempt 1) -> retry? yes
      expect(shouldRetry('transient', 1, config)).toBe(true);
      // 3rd failure (attempt 3) -> retry? yes (max is 3)
      expect(shouldRetry('transient', 3, config)).toBe(true);
      // 4th failure (attempt 4) -> retry? no
      expect(shouldRetry('transient', 4, config)).toBe(false);
    });
  });

  describe('getRetryNotBefore accounting tracking delays accurately', () => {
    it('returns correct delay for attempt 1', () => {
      const now = Date.now();
      const notBefore = getRetryNotBefore(1);
      const delayMinutes = (notBefore - now) / 1000 / 60;
      expect(Math.round(delayMinutes)).toBe(2);
    });

    it('returns correct delay for attempt 2', () => {
        const now = Date.now();
        const notBefore = getRetryNotBefore(2);
        const delayMinutes = (notBefore - now) / 1000 / 60;
        expect(Math.round(delayMinutes)).toBe(10);
    });

    it('returns correct delay for attempt 3', () => {
      const now = Date.now();
      const notBefore = getRetryNotBefore(3);
      const delayMinutes = (notBefore - now) / 1000 / 60;
      expect(Math.round(delayMinutes)).toBe(30);
    });

    it('caps maximum retry delay correctly on large attempts', () => {
        const now = Date.now();
        const notBefore = getRetryNotBefore(99);
        const delayMinutes = (notBefore - now) / 1000 / 60;
        expect(Math.round(delayMinutes)).toBe(30);
    });
  });
});
