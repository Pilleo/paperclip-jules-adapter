import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execute } from '../src/server/execute';
import { JulesClient } from '../src/server/jules-client';
import { sessionCodec } from '../src/server/session';

vi.mock('../src/server/jules-client');

describe('Required Edge Cases Tests', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('handles malformed host context safely', async () => {
       const badCtx = {} as any;
       await expect(execute(badCtx)).rejects.toThrow();
    });

    it('handles malformed jules payloads safely via api schema throws', async () => {
       const baseCtx = {
         agent: { adapterConfig: { source: 's', repository: 'r' } },
         context: { secrets: { JULES_API_KEY: 'k' }, task: { id: 't' } },
         runtime: {},
         runId: 'r'
       } as any;

       (JulesClient.prototype.createSession as any).mockRejectedValueOnce(new Error('Invalid payload validation'));
       const res = await execute(baseCtx);
       expect(res.exitCode).toBe(1);
    });

    it('handles unknown state successfully mapping to RUNNING loop', async () => {
       const baseCtx = {
         agent: { adapterConfig: { source: 's', repository: 'r' } },
         context: { secrets: { JULES_API_KEY: 'k' }, task: { id: 't' } },
         runtime: {},
         runId: 'r'
       } as any;

       (JulesClient.prototype.createSession as any).mockResolvedValueOnce({ name: 'sess' });
       (JulesClient.prototype.getSession as any).mockResolvedValueOnce({ name: 'sess', state: 'NEW_UNSEEN_STATE' });

       const abortCtrl = new AbortController();
       setTimeout(() => abortCtrl.abort(), 10);

       const res = await execute({ ...baseCtx, abortSignal: abortCtrl.signal });
       expect(res.exitCode).toBe(0);
       const decoded = sessionCodec.decode(res.sessionParams!);
       expect(decoded.phase).toBe('RUNNING');
    });

    it('handles absent session ID gracefully with invariant throw', async () => {
       const baseCtx = {
         agent: { adapterConfig: { source: 's', repository: 'r' } },
         context: { secrets: { JULES_API_KEY: 'k' }, task: { id: 't' } },
         runtime: {},
         runId: 'r'
       } as any;

       const sessionParams = sessionCodec.encode({
           version: 1,
           paperclipIssueId: 't',
           promptHash: 'some-hash',
           repository: 'r',
           source: 's',
           baseBranch: 'master',
           phase: 'RUNNING',
           julesSessionId: undefined, // Absent session id
           attempt: 1,
           failedSessions: [],
           createdAt: new Date().toISOString()
       } as any);

       await expect(execute({ ...baseCtx, runtime: { ...baseCtx.runtime, sessionParams }})).rejects.toThrow("Missing julesSessionId during polling loop");
    });

    it('handles duplicate interaction data securely mapping and processing', async () => {
        const baseCtx = {
          agent: { adapterConfig: { source: 's', repository: 'r', pollIntervalSeconds: 10, heartbeatPollWindowSeconds: 30 } },
          context: { secrets: { JULES_API_KEY: 'k' }, task: { id: 't' } },
          runtime: {},
          runId: 'r',
          resolvedInteractions: [
             { questionId: 'act-1', answer: 'a' },
             { questionId: 'act-1', answer: 'a' }
          ]
        } as any;

        (JulesClient.prototype.sendMessage as any).mockClear();
        (JulesClient.prototype.sendMessage as any).mockResolvedValue(null);
        (JulesClient.prototype.getSession as any).mockResolvedValue({ name: 'sess', state: 'IN_PROGRESS' });

        const sessionParams = sessionCodec.encode({
            version: 1,
            paperclipIssueId: 't',
            promptHash: 'some-hash',
            repository: 'r',
            source: 's',
            baseBranch: 'master',
            phase: 'WAITING_FOR_FEEDBACK',
            julesSessionId: 'sess',
            attempt: 1,
            failedSessions: [],
            pendingInteraction: { type: 'user_feedback', julesActivityId: 'act-1', question: 'q', createdAt: '' },
            createdAt: new Date().toISOString()
        } as any);

        const abortCtrl = new AbortController();
        setTimeout(() => abortCtrl.abort(), 10);

        const res = await execute({
           ...baseCtx,
           abortSignal: abortCtrl.signal,
           runtime: { ...baseCtx.runtime, sessionParams }
        });

        expect(JulesClient.prototype.sendMessage).toHaveBeenCalledTimes(1);
    });
});
