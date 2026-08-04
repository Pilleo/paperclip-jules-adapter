import { describe, it, expect } from 'vitest';
import { getRetryNotBefore } from '../src/server/retry-policy';

describe('getRetryNotBefore bounds', () => {
   it('caps maximum retry delay correctly on large attempts', () => {
       const now = Date.now();
       const notBefore = getRetryNotBefore(99);
       const delayMinutes = (notBefore - now) / 1000 / 60;
       expect(Math.round(delayMinutes)).toBe(30);
   });
});
