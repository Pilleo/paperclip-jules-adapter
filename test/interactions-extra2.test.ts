import { describe, it, expect, vi } from 'vitest';
import { processResolvedInteraction } from '../src/server/interactions';
import { JulesClient } from '../src/server/jules-client';

describe('Interactions Extra Branch Coverage 2', () => {
  const mockClient = {
    getActivities: vi.fn(),
    sendMessage: vi.fn(),
    approvePlan: vi.fn()
  } as unknown as JulesClient;

  it('processResolvedInteraction interprets empty answer for plan as rejected', async () => {
      const processed = await processResolvedInteraction(
          mockClient,
          'sess-1',
          { type: 'plan_approval', julesActivityId: 'act-1', question: 'P1', createdAt: '' },
          [{ questionId: 'act-1' }]
      );
      expect(processed).toBe(true);
      expect(mockClient.approvePlan).toHaveBeenCalledWith('sess-1', { approved: false, reason: undefined });
  });

  it('processResolvedInteraction matches by questionId when interactionId exists on pending but not resolved', async () => {
      const processed = await processResolvedInteraction(
          mockClient,
          'sess-1',
          { type: 'user_feedback', julesActivityId: 'act-1', paperclipInteractionId: 'p-1', question: 'Q1', createdAt: '' },
          [{ questionId: 'act-1', answer: 'val' }]
      );
      expect(processed).toBe(true);
  });
});
