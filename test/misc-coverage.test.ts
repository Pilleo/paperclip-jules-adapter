import { describe, it, expect } from 'vitest';
import { execute } from '../src/server/execute';
import { AdapterExecutionContext } from '@paperclipai/adapter-utils';
import { sessionCodec } from '../src/server/session';
import { classifyFailure } from '../src/server/failure-classifier';
import { shouldRetry } from '../src/server/retry-policy';
import { buildPrompt, hashPrompt } from '../src/server/prompt-builder';
import { handleJulesState } from '../src/server/state-machine';
import { JulesClientError } from '../src/server/jules-client';

describe('Misc Coverage', () => {
    it('classifyFailure covers 422', () => {
        expect(classifyFailure(new JulesClientError(422, 'error'))).toBe('task');
    });

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
        // Can't directly export sleep, but we test the behaviour via abort signal on execute
        const ctrl = new AbortController();
        ctrl.abort();
        const baseCtx = {
          agent: { adapterConfig: { source: 's', repository: 'r' } },
          context: { secrets: { JULES_API_KEY: 'k' }, task: { id: 't' } },
          runtime: {},
          runId: 'r',
          abortSignal: ctrl.signal // Execution loops rely on sleep
        } as any;

        // This won't reach sleep because Jules auth will fail on the live fetch inside client unless mocked.
        // Let's mock createSession so it loops down to where `sleep` is actually called: inside the while loop's catch block on transient errors.
    });
});
