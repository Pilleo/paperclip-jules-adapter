import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sessionCodec } from '../src/server/session';

beforeAll(() => {
    process.env['JULES_API_KEY'] = 'test-key';
  });

  afterAll(() => {
    delete process.env['JULES_API_KEY'];
  });

  describe('Session Codec', () => {
    it.each([
      [null],
      [undefined],
      [{}],
    ])("treats %p as no persisted session", (raw) => {
      expect(sessionCodec.deserialize(raw)).toBeNull();
      expect(sessionCodec.decode(raw)).toBeNull();
    });

    it('rejects malformed non-empty persisted sessions', () => {
        expect(() => sessionCodec.decode({ version: 1, paperclipIssueId: 'issue-1' })).toThrow();
        expect(() => sessionCodec.deserialize({ version: 1, paperclipIssueId: 'issue-1' })).toThrow();
    });

    it('successfully decodes a valid session state', () => {
        const payload = {
            version: 1,
            paperclipIssueId: 'i',
            promptHash: 'h',
            repository: 'r',
            source: 's',
            baseBranch: 'b',
            phase: 'RUNNING',
            attempt: 1,
            failedSessions: [],
            createdAt: '2020'
        };
        const res = sessionCodec.decode(payload);
        expect(res).toBeDefined();
        expect(res!.phase).toBe('RUNNING');
    });

    it('successfully extracts display id from encoded structure', () => {
        const payload = {
            version: 1,
            paperclipIssueId: 'i',
            promptHash: 'h',
            repository: 'r',
            source: 's',
            baseBranch: 'b',
            phase: 'RUNNING',
            attempt: 1,
            failedSessions: [],
            createdAt: '2020',
            julesSessionId: 'j-1'
        };
        expect(sessionCodec.getDisplayId(payload)).toBe('j-1');
        expect(sessionCodec.getDisplayId(null)).toBeNull();
    });
});
describe('Session Codec serialization coverage', () => {
   it('correctly maps null outputs for encode and serialize boundaries', () => {
      expect(sessionCodec.serialize(null)).toBeNull();
   });
});
