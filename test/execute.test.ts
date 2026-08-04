import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execute } from '../src/server/execute';
import { AdapterExecutionContext } from '@paperclipai/adapter-utils';
import { JulesClient } from '../src/server/jules-client';
import { sessionCodec } from '../src/server/session';

// Mock JulesClient
vi.mock('../src/server/jules-client', () => {
  const MockedJulesClient = vi.fn();
  MockedJulesClient.prototype.createSession = vi.fn().mockResolvedValue({ name: 'sess-123' });
  MockedJulesClient.prototype.getSession = vi.fn().mockResolvedValue({ state: 'IN_PROGRESS' });
  MockedJulesClient.prototype.getActivities = vi.fn().mockResolvedValue({ activities: [] });
  MockedJulesClient.prototype.sendMessage = vi.fn();
  MockedJulesClient.prototype.approvePlan = vi.fn();
  return { JulesClient: MockedJulesClient };
});

describe('execute', () => {
  const baseCtx: AdapterExecutionContext = {
    adapterConfig: {
      source: 'github',
      repository: 'pilleo/test',
      baseBranch: 'master',
      pollIntervalSeconds: 10,
      heartbeatPollWindowSeconds: 30
    },
    secrets: { JULES_API_KEY: 'test-key' },
    task: { id: 'task-1', title: 'Test Task', description: 'Test desc', state: 'open', sourceBranch: '' },
    runId: 'run-1',
    abortSignal: new AbortController().signal, // Needs to be aborted for the polling loop to exit early in tests
    resolvedInteractions: [],
    runNumber: 1
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates new session on first heartbeat', async () => {
    const abortCtrl = new AbortController();
    abortCtrl.abort(); // Abort immediately so loop doesn't block

    const res = await execute({ ...baseCtx, abortSignal: abortCtrl.signal });
    expect(res.exitCode).toBe(0);
    expect(res.clearSession).toBe(false);
    expect(res.sessionParams).toBeDefined();

    const session = sessionCodec.decode(res.sessionParams!);
    expect(session.julesSessionId).toBe('sess-123');
    expect(session.phase).toBe('RUNNING');
  });

  it('returns terminal result on COMPLETED state', async () => {
    (JulesClient.prototype.getSession as any).mockResolvedValueOnce({ state: 'COMPLETED', currentPrUrl: 'http://pr/1' });

    const res = await execute(baseCtx);
    expect(res.exitCode).toBe(0);
    expect(res.clearSession).toBe(true);
    expect(res.resultJson?.prUrl).toBe('http://pr/1');
  });

  it('handles AWAITING_USER_FEEDBACK by returning interaction', async () => {
    (JulesClient.prototype.getSession as any).mockResolvedValueOnce({ state: 'AWAITING_USER_FEEDBACK' });
    (JulesClient.prototype.getActivities as any).mockResolvedValueOnce({
       activities: [{ id: 'act-1', type: 'QUESTION', questionText: 'What color?', answered: false }]
    });

    const res = await execute(baseCtx);
    expect(res.exitCode).toBe(0);
    expect(res.interactions).toHaveLength(1);
    expect(res.interactions![0].type).toBe('ask_user_questions');
    expect(res.interactions![0].questions[0].text).toBe('What color?');
  });
});
