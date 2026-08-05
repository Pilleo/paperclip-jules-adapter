import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { execute } from '../src/server/execute';
import { AdapterExecutionContext } from '@paperclipai/adapter-utils';
import { JulesClient } from '../src/server/jules-client';
import { sessionCodec } from '../src/server/session';

vi.mock('../src/server/jules-client', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/server/jules-client')>();
  const MockedJulesClient = vi.fn();
  MockedJulesClient.prototype.createSession = vi.fn().mockResolvedValue({ id: '123', name: 'sessions/123' });
  MockedJulesClient.prototype.getSession = vi.fn().mockResolvedValue({ state: 'IN_PROGRESS' });
  MockedJulesClient.prototype.getActivities = vi.fn().mockResolvedValue({ activities: [] });
  MockedJulesClient.prototype.sendMessage = vi.fn();
  MockedJulesClient.prototype.approvePlan = vi.fn();
  return {
    ...mod,
    JulesClient: MockedJulesClient
  };
});

beforeAll(() => {
    process.env['JULES_API_KEY'] = 'test-key';
  });

  afterAll(() => {
    delete process.env['JULES_API_KEY'];
  });

  describe('execute', () => {
  const baseCtx: AdapterExecutionContext = {
    agent: {
        id: '1', companyId: '1', name: 'agent', adapterType: 'jules',
        adapterConfig: {
          source: 'github',
          repository: 'pilleo/test',
          baseBranch: 'master',
          pollIntervalSeconds: 10,
          heartbeatPollWindowSeconds: 30
        }
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: 'task-1' },
    config: {},
    context: {

        task: { id: 'task-1', title: 'Test Task', description: 'Test desc' }
    },
    runId: 'run-1',
    abortSignal: new AbortController().signal,
    onLog: vi.fn(),
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates new session on first heartbeat', async () => {
    const abortCtrl = new AbortController();
    abortCtrl.abort();

    const res = await execute({ ...baseCtx, abortSignal: abortCtrl.signal } as any);
    expect(res.exitCode).toBe(0);
    expect(res.clearSession).toBe(false);
    expect(res.sessionParams).toBeDefined();

    const session = sessionCodec.decode(res.sessionParams!);
    expect(session.julesSessionId).toBe('123');
    expect(session.phase).toBe('RUNNING');
  });

  it('returns blocking PR review question on COMPLETED state with PR', async () => {
    (JulesClient.prototype.getSession as any).mockResolvedValueOnce({
        state: 'COMPLETED',
        rawOutputs: [{ pullRequest: { url: 'http://pr/1' } }]
    });

    const res = await execute(baseCtx);
    expect(res.exitCode).toBe(0);
    expect(res.clearSession).toBe(false);
    expect(res.question).toBeDefined();
    expect(res.question!.prompt).toContain('Please review and merge it');
    expect(res.resultJson?.prUrl).toBe('http://pr/1');
  });

  it('handles AWAITING_USER_FEEDBACK by returning question', async () => {
    (JulesClient.prototype.getSession as any).mockResolvedValueOnce({ state: 'AWAITING_USER_FEEDBACK' });

    const res = await execute(baseCtx);
    expect(res.exitCode).toBe(0);
    expect(res.question).toBeDefined();
    expect(res.question!.prompt).toContain('requires feedback');
  });
});
