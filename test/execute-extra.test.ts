import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execute } from '../src/server/execute';
import { AdapterExecutionContext } from '@paperclipai/adapter-utils';
import { sessionCodec } from '../src/server/session';
import { JulesClient } from '../src/server/jules-client';
import { processResolvedInteraction, handleAwaitingPlanApproval } from '../src/server/interactions';

vi.mock('../src/server/jules-client');
vi.mock('../src/server/interactions', async (importOriginal) => {
    const mod = await importOriginal<typeof import('../src/server/interactions')>();
    return {
        ...mod,
        processResolvedInteraction: vi.fn((c, s, pi, ri) => mod.processResolvedInteraction(c, s, pi, ri)),
        handleAwaitingPlanApproval: vi.fn((c, s, curr) => mod.handleAwaitingPlanApproval(c, s, curr))
    };
});

describe('execute extra branch coverage', () => {
  const baseCtx: AdapterExecutionContext = {
    adapterConfig: {
      source: 'github', repository: 'test', baseBranch: 'master', pollIntervalSeconds: 10, heartbeatPollWindowSeconds: 30
    },
    secrets: { JULES_API_KEY: 'test' },
    task: { id: 'task-1', title: 'Task', state: 'open', sourceBranch: '' },
    runId: 'run-1',
    abortSignal: new AbortController().signal,
    resolvedInteractions: [],
    runNumber: 1
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates prompt hash if task identity changed but not retry', async () => {
       (JulesClient.prototype.getSession as any).mockResolvedValueOnce({ state: 'IN_PROGRESS' });

       const session = {
           version: 1,
           paperclipIssueId: 'task-1',
           promptHash: 'old-hash',
           repository: 'test',
           source: 'github',
           baseBranch: 'master',
           phase: 'RUNNING',
           julesSessionId: 'sess-1',
           attempt: 1,
           failedSessions: [],
           createdAt: new Date().toISOString()
       };

       const abortCtrl = new AbortController();
       setTimeout(() => abortCtrl.abort(), 10);

       const res = await execute({ ...baseCtx, sessionParams: sessionCodec.encode(session as any), abortSignal: abortCtrl.signal });
       const decoded = sessionCodec.decode(res.sessionParams!);

       expect(decoded.promptHash).not.toBe('old-hash'); // Hash should have updated to current task
  });

  it('processes resolved interaction and continues', async () => {
        (JulesClient.prototype.getSession as any).mockResolvedValueOnce({ state: 'IN_PROGRESS' });
        vi.mocked(processResolvedInteraction).mockResolvedValueOnce(true);

        const session = {
            version: 1,
            paperclipIssueId: 'task-1',
            promptHash: 'some-hash',
            repository: 'test',
            source: 'github',
            baseBranch: 'master',
            phase: 'WAITING_FOR_FEEDBACK',
            julesSessionId: 'sess-1',
            attempt: 1,
            failedSessions: [],
            pendingInteraction: { type: 'user_feedback', julesActivityId: 'act-1', question: 'q', createdAt: '' },
            createdAt: new Date().toISOString()
        };

        const abortCtrl = new AbortController();
        setTimeout(() => abortCtrl.abort(), 10);

        const res = await execute({
           ...baseCtx,
           resolvedInteractions: [{ questionId: 'act-1', answer: 'a' }],
           sessionParams: sessionCodec.encode(session as any),
           abortSignal: abortCtrl.signal
        });

        const decoded = sessionCodec.decode(res.sessionParams!);
        expect(decoded.pendingInteraction).toBeUndefined();
        expect(decoded.phase).toBe('RUNNING'); // should have changed back to running
  });

  it('handles WAITING_FOR_PLAN_APPROVAL by returning interaction', async () => {
      (JulesClient.prototype.getSession as any).mockResolvedValueOnce({ state: 'AWAITING_PLAN_APPROVAL' });
      vi.mocked(handleAwaitingPlanApproval).mockResolvedValueOnce({
          pendingInteraction: { type: 'plan_approval', julesActivityId: 'p-1', question: 'p', createdAt: '' },
          paperclipInteraction: { type: 'ask_user_questions', questions: [] }
      });

      const session = {
          version: 1,
          paperclipIssueId: 'task-1',
          promptHash: 'some-hash',
          repository: 'test',
          source: 'github',
          baseBranch: 'master',
          phase: 'RUNNING',
          julesSessionId: 'sess-1',
          attempt: 1,
          failedSessions: [],
          createdAt: new Date().toISOString()
      };

      const res = await execute({ ...baseCtx, sessionParams: sessionCodec.encode(session as any) });
      expect(res.interactions).toBeDefined();
      const decoded = sessionCodec.decode(res.sessionParams!);
      expect(decoded.pendingInteraction?.type).toBe('plan_approval');
  });
});
