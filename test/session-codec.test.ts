import { describe, it, expect } from 'vitest';
import { sessionCodec } from '../src/server/session';

describe('sessionCodec coverage', () => {
    it('deserialize handles nulls and data correctly', () => {
        expect(sessionCodec.deserialize(null)).toBeNull();
        expect(sessionCodec.deserialize(undefined)).toBeNull();

        const validData = {
           version: 1,
           paperclipIssueId: 't',
           promptHash: 'h',
           repository: 'r',
           source: 's',
           baseBranch: 'master',
           phase: 'RUNNING',
           attempt: 1,
           failedSessions: [],
           createdAt: new Date().toISOString()
       };
       expect(sessionCodec.deserialize(validData)).toMatchObject({ version: 1 });
    });

    it('serialize handles nulls and data correctly', () => {
        expect(sessionCodec.serialize(null)).toBeNull();
        expect(sessionCodec.serialize(undefined as any)).toBeNull();

        const validData = {
           version: 1,
           paperclipIssueId: 't',
           promptHash: 'h',
           repository: 'r',
           source: 's',
           baseBranch: 'master',
           phase: 'RUNNING',
           attempt: 1,
           failedSessions: [],
           createdAt: new Date().toISOString()
       };
       expect(sessionCodec.serialize(validData)).toMatchObject({ version: 1 });
    });

    it('getDisplayId handles nulls and defined sessions correctly', () => {
        expect(sessionCodec.getDisplayId(null)).toBeNull();
        expect(sessionCodec.getDisplayId({ julesSessionId: 'sess' })).toBe('sess');
        expect(sessionCodec.getDisplayId({ })).toBeNull();
    });
});
