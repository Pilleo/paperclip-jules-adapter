import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sessionCodec, JulesAdapterSessionV1 } from '../src/server/session';

beforeAll(() => {
    process.env['JULES_API_KEY'] = 'test-key';
  });

  afterAll(() => {
    delete process.env['JULES_API_KEY'];
  });

  describe('sessionCodec', () => {
  const validSession: JulesAdapterSessionV1 = {
    version: 1,
    paperclipIssueId: 'issue-123',
    promptHash: 'hash-abc',
    repository: 'Pilleo/paperclip-jules-adapter',
    source: 'github',
    baseBranch: 'master',
    phase: 'RUNNING',
    julesSessionId: 'sess-456',
    attempt: 1,
    failedSessions: [],
    createdAt: new Date().toISOString()
  };

  it('decodes a valid session correctly', () => {
    const decoded = sessionCodec.decode(validSession);
    expect(decoded).toEqual(validSession);
  });

  it('encodes a valid session correctly', () => {
    const encoded = sessionCodec.encode(validSession);
    expect(encoded).toEqual(validSession);
  });

  it('rejects invalid version', () => {
    const invalidSession = { ...validSession, version: 2 };
    expect(() => sessionCodec.decode(invalidSession)).toThrow(/Unsupported session version/);
  });

  it('rejects malformed session data', () => {
    const malformedSession = { ...validSession, attempt: -1 };
    expect(() => sessionCodec.decode(malformedSession)).toThrow();
  });

  it('returns display id', () => {
    expect(sessionCodec.getDisplayId(validSession)).toBe('sess-456');
  });

  it('preserves unknown Jules state safely', () => {
     const sessionWithUnknownState = { ...validSession, julesState: 'SOME_WEIRD_STATE_XYZ' };
     const decoded = sessionCodec.decode(sessionWithUnknownState);
     expect(decoded.julesState).toBe('SOME_WEIRD_STATE_XYZ');
  });
});
