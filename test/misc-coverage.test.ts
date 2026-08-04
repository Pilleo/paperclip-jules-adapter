import { describe, it, expect, vi } from 'vitest';
import { execute } from '../src/server/execute';
import { sessionCodec } from '../src/server/session';
import { shouldRetry } from '../src/server/retry-policy';
import { buildPrompt } from '../src/server/prompt-builder';
import { handleJulesState } from '../src/server/state-machine';
import { JulesClient } from '../src/server/jules-client';
import { classifyFailure } from '../src/server/failure-classifier';

vi.mock('../src/server/jules-client');
vi.mock('../src/server/failure-classifier', async (importOriginal) => {
    const mod = await importOriginal<typeof import('../src/server/failure-classifier')>();
    return {
        ...mod,
        classifyFailure: vi.fn((err) => mod.classifyFailure(err))
    };
});

describe('Misc Coverage', () => {
    it('retry-policy shouldRetry handles transient failure outside loop limit', () => {
        expect(shouldRetry('transient', 99, { maxAutomaticRestarts: 2 } as any)).toBe(false);
    });

    it('sessionCodec decode invalid type', () => {
        expect(() => sessionCodec.decode(null)).toThrow('Invalid session data format');
        expect(() => sessionCodec.decode('string')).toThrow('Invalid session data format');
    });

    it('state-machine QUEUED state', () => {
        expect(handleJulesState('QUEUED', false).nextPhase).toBe('RUNNING');
    });

    it('prompt builder with failedSession message but no url', () => {
        const prompt = buildPrompt({
            issueId: '1', runId: '1', title: 't', description: 'd', isRetry: true, failedSessionMessage: 'crash'
        }, { source: 's', baseBranch: 'b' } as any);
        expect(prompt).toContain('Previous session: Unknown');
    });

    it('sleep early resolves if already aborted', async () => {
        const ctrl = new AbortController();
        const baseCtx = {
          agent: { adapterConfig: { source: 's', repository: 'r' } },
          context: { secrets: { JULES_API_KEY: 'k' }, task: { id: 't', title: 't' } },
          runtime: {},
          runId: 'r',
          abortSignal: ctrl.signal
        } as any;

        (JulesClient.prototype.createSession as any).mockResolvedValueOnce({ id: '1', name: 'sessions/1' });
        (JulesClient.prototype.getSession as any).mockRejectedValueOnce({ status: 500, message: 'Poll failed' });
        vi.mocked(classifyFailure).mockReturnValueOnce('transient');

        setTimeout(() => ctrl.abort(), 10);

        const res = await execute(baseCtx);
        expect(res.exitCode).toBe(0);
    });
});
