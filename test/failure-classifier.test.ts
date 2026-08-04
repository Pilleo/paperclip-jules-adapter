import { describe, it, expect } from 'vitest';
import { classifyFailure, toErrorFamily } from '../src/server/failure-classifier';
import { JulesClientError } from '../src/server/jules-client';

describe('classifyFailure extra', () => {
   it('handles generic unidentifiable errors securely', () => {
       expect(classifyFailure({})).toBe('unknown');
   });

   it('handles string errors securely', () => {
       expect(classifyFailure("A weird crash message")).toBe('unknown');
   });

   it('maps to correct error family exhaustively', () => {
       expect(toErrorFamily('transient')).toBe('transient_upstream');
       expect(toErrorFamily('configuration')).toBe(null);
       expect(toErrorFamily('task')).toBe(null);
       expect(toErrorFamily('unknown')).toBe(null);
   });
});
