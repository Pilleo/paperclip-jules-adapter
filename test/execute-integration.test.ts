import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execute } from '../src/server/execute';
import { AdapterExecutionContext } from '@paperclipai/adapter-utils';
import { sessionCodec } from '../src/server/session';
import { JulesClient } from '../src/server/jules-client';

vi.mock('../src/server/jules-client');

describe('Full Paperclip Continuation Lifecycle Integration', () => {
    const baseCtx: AdapterExecutionContext = {
        agent: {
            id: '1', companyId: '1', name: 'agent', adapterType: 'jules',
            adapterConfig: {
              source: 'github', repository: 'test', baseBranch: 'master', pollIntervalSeconds: 10, heartbeatPollWindowSeconds: 30
            }
        },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: 'task-1' },
        config: {},
        context: {
            secrets: { JULES_API_KEY: 'test-key' },
            task: { id: 'task-1', title: 'Task' }
        },
        runId: 'run-1',
        abortSignal: new AbortController().signal,
        resolvedInteractions: [],
        onLog: vi.fn()
    } as any;

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('Lifecycle: First beat -> Wait feedback -> Resumes -> Completes PR', async () => {
        let step = 1;
        (JulesClient.prototype.createSession as any).mockResolvedValue({ name: 'sess-1' });
        (JulesClient.prototype.getSession as any).mockImplementation(() => {
           if (step === 1) return Promise.resolve({ name: 'sess-1', state: 'QUEUED' });
           if (step === 2) return Promise.resolve({ name: 'sess-1', state: 'AWAITING_USER_FEEDBACK' });
           if (step === 3) return Promise.resolve({ name: 'sess-1', state: 'COMPLETED', currentPrUrl: 'https://pr' });
        });
        (JulesClient.prototype.getActivities as any).mockImplementation(() => {
            return Promise.resolve({
                activities: [{ id: 'q1', type: 'QUESTION', questionText: 'q1?', answered: false }]
            });
        });
        (JulesClient.prototype.sendMessage as any).mockResolvedValue(null);

        const abortCtrl1 = new AbortController();
        setTimeout(() => abortCtrl1.abort(), 10);

        let res = await execute({ ...baseCtx, abortSignal: abortCtrl1.signal } as any);
        expect(res.exitCode).toBe(0);
        let session = sessionCodec.decode(res.sessionParams!);
        expect(session.julesSessionId).toBe('sess-1');
        expect(session.phase).toBe('RUNNING');

        step = 2;

        const abortCtrl2 = new AbortController();
        setTimeout(() => abortCtrl2.abort(), 10);

        res = await execute({
            ...baseCtx,
            runtime: { ...baseCtx.runtime, sessionParams: res.sessionParams },
            abortSignal: abortCtrl2.signal
        } as any);

        expect(res.question).toBeDefined();
        session = sessionCodec.decode(res.sessionParams!);
        expect(session.phase).toBe('WAITING_FOR_FEEDBACK');

        // At this point pendingInteraction must be set
        expect(session.pendingInteraction).toBeDefined();
        expect(session.pendingInteraction!.julesActivityId).toBe('q1');

        step = 3;

        const abortCtrl3 = new AbortController();
        setTimeout(() => abortCtrl3.abort(), 10);

        // Crucial context update - ensure resolvedInteractions goes in AND sessionParams includes pendingInteraction
        const ctx3 = {
            ...baseCtx,
            runtime: { ...baseCtx.runtime, sessionParams: res.sessionParams },
            resolvedInteractions: [{ questionId: 'q1', answer: 'val' }], // Needs to match property read
            abortSignal: abortCtrl3.signal
        } as any;
        res = await execute(ctx3);

        expect(JulesClient.prototype.sendMessage).toHaveBeenCalledWith('sess-1', { message: 'val' });
        expect(res.exitCode).toBe(0);
        expect(res.summary).toContain('Jules created PR: https://pr');
        expect(res.clearSession).toBe(true);
    });
});
