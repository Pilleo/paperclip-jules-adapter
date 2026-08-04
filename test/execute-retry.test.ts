import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execute } from '../src/server/execute';
import { AdapterExecutionContext } from '@paperclipai/adapter-utils';
import { sessionCodec } from '../src/server/session';
import { JulesClient } from '../src/server/jules-client';
import { classifyFailure } from '../src/server/failure-classifier';
import { shouldRetry } from '../src/server/retry-policy';

vi.mock('../src/server/jules-client');
vi.mock('../src/server/failure-classifier', async (importOriginal) => {
    const mod = await importOriginal<typeof import('../src/server/failure-classifier')>();
    return {
        ...mod,
        classifyFailure: vi.fn((err) => mod.classifyFailure(err))
    };
});
vi.mock('../src/server/retry-policy', async (importOriginal) => {
    const mod = await importOriginal<typeof import('../src/server/retry-policy')>();
    return {
        ...mod,
        shouldRetry: vi.fn((c, a, config) => mod.shouldRetry(c, a, config))
    };
});

describe('execute retry policies', () => {
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

  it('handles create session failure (transient) and returns RETRY_SCHEDULED', async () => {
      (JulesClient.prototype.createSession as any).mockRejectedValueOnce({ status: 500, message: 'Server error' });
      vi.mocked(classifyFailure).mockReturnValueOnce('transient');
      vi.mocked(shouldRetry).mockReturnValueOnce(true);

      const res = await execute(baseCtx);

      expect(res.exitCode).toBe(1);
      expect(res.errorCode).toBe('jules_transient_failure');
      expect(res.sessionParams).toBeDefined();

      const session = sessionCodec.decode(res.sessionParams!);
      expect(session.phase).toBe('RETRY_SCHEDULED');
      expect(session.attempt).toBe(1);
      expect(session.failedSessions.length).toBe(1);
  });

  it('handles polling failure (transient) within heartbeat and loop limits', async () => {
      (JulesClient.prototype.createSession as any).mockResolvedValueOnce({ name: 'sess-1' });
      (JulesClient.prototype.getSession as any).mockRejectedValueOnce({ status: 500, message: 'Poll failed' });
      vi.mocked(classifyFailure).mockReturnValueOnce('transient');

      const abortCtrl = new AbortController();
      setTimeout(() => abortCtrl.abort(), 10);

      const res = await execute({ ...baseCtx, abortSignal: abortCtrl.signal });
      expect(res.exitCode).toBe(0); // Ends via abort signal returning 0 with state
      const session = sessionCodec.decode(res.sessionParams!);
      expect(session.julesSessionId).toBe('sess-1');
  });

  it('handles polling failure (fatal)', async () => {
      (JulesClient.prototype.createSession as any).mockResolvedValueOnce({ name: 'sess-1' });
      (JulesClient.prototype.getSession as any).mockRejectedValueOnce({ status: 401, message: 'Auth error' });
      vi.mocked(classifyFailure).mockReturnValueOnce('configuration');

      const abortCtrl = new AbortController();

      const res = await execute({ ...baseCtx, abortSignal: abortCtrl.signal });
      expect(res.exitCode).toBe(1);
      expect(res.errorCode).toBe('jules_polling_error');
  });

  it('handles COMPLETED state with false success (no PR)', async () => {
       (JulesClient.prototype.createSession as any).mockResolvedValueOnce({ name: 'sess-1' });
       (JulesClient.prototype.getSession as any).mockResolvedValueOnce({ state: 'COMPLETED' });

       const res = await execute(baseCtx);
       expect(res.exitCode).toBe(0);
       expect(res.summary).toBe('Jules completed without a PR');
  });

  it('handles FAILED jules state with retry', async () => {
        (JulesClient.prototype.createSession as any).mockResolvedValueOnce({ name: 'sess-1' });
        (JulesClient.prototype.getSession as any).mockResolvedValueOnce({ state: 'FAILED' });
        vi.mocked(shouldRetry).mockReturnValueOnce(true); // Retry the explicitly failed session

        const res = await execute(baseCtx);

        expect(res.exitCode).toBe(1);
        expect(res.errorCode).toBe('jules_transient_failure');
        const session = sessionCodec.decode(res.sessionParams!);
        expect(session.phase).toBe('RETRY_SCHEDULED');
  });

  it('handles FAILED jules state without retry (exhausted)', async () => {
        (JulesClient.prototype.createSession as any).mockResolvedValueOnce({ name: 'sess-1' });
        (JulesClient.prototype.getSession as any).mockResolvedValueOnce({ state: 'FAILED' });
        vi.mocked(shouldRetry).mockReturnValueOnce(false);

        const res = await execute(baseCtx);

        expect(res.exitCode).toBe(1);
        expect(res.errorCode).toBe('jules_task_failure');
        expect(res.clearSession).toBe(false);
  });

  it('resumes from RETRY_SCHEDULED by creating new session', async () => {
      let created = false;
      (JulesClient.prototype.createSession as any).mockImplementationOnce(() => {
         created = true;
         return Promise.resolve({ name: 'sess-2' });
      });
      (JulesClient.prototype.getSession as any).mockResolvedValueOnce({ state: 'IN_PROGRESS' });

      const session = {
          version: 1,
          paperclipIssueId: 'task-1',
          promptHash: 'old-hash',
          repository: 'test',
          source: 'github',
          baseBranch: 'master',
          phase: 'RETRY_SCHEDULED',
          attempt: 1,
          failedSessions: [{ sessionId: 'sess-1', failedAt: new Date().toISOString(), message: 'failed', classification: 'transient' }],
          createdAt: new Date().toISOString()
      };

      const abortCtrl = new AbortController();
      setTimeout(() => abortCtrl.abort(), 10);

      const res = await execute({ ...baseCtx, sessionParams: session as any, abortSignal: abortCtrl.signal });

      expect(created).toBe(true);
      const newSession = sessionCodec.decode(res.sessionParams!);
      expect(newSession.julesSessionId).toBe('sess-2');
  });
});
