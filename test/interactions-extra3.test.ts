import { describe, it, expect, vi } from 'vitest';
import { handleAwaitingUserFeedback, handleAwaitingPlanApproval, processResolvedInteraction } from '../src/server/interactions';
import { JulesClient } from '../src/server/jules-client';
import { JulesAdapterSessionV1 } from '../src/server/session';
import { asJulesSessionId } from '../src/server/brands';

describe('Interactions Extra Branch Coverage 3', () => {
  const mockClient = {
    getActivities: vi.fn(),
    sendMessage: vi.fn(),
    approvePlan: vi.fn()
  } as unknown as JulesClient;

  const mockSession = {} as JulesAdapterSessionV1;

  it('handleAwaitingUserFeedback ignores null activities', async () => {
    vi.mocked(mockClient.getActivities).mockResolvedValueOnce(null as any);
    const res = await handleAwaitingUserFeedback(mockClient, asJulesSessionId('sess-1'), mockSession);
    expect(res).toBeNull();
  });
});
