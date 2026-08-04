import { describe, it, expect } from 'vitest';
import { classifyFailure } from '../src/server/failure-classifier';
import { JulesClientError } from '../src/server/jules-client';

describe('classifyFailure extra', () => {
   it('handles generic unidentifiable errors securely', () => {
       expect(classifyFailure({})).toBe('unknown');
   });

   it('handles string errors securely', () => {
       expect(classifyFailure("A weird crash message")).toBe('unknown');
   });
});
