import { describe, it, expect, vi } from 'vitest';
import { handleAwaitingUserFeedback, handleAwaitingPlanApproval, processResolvedInteraction } from '../src/server/interactions';
import { JulesClient } from '../src/server/jules-client';
import { JulesAdapterSessionV1 } from '../src/server/session';

describe('Interactions Extra Branch Coverage', () => {
  const mockClient = {
    getActivities: vi.fn(),
    sendMessage: vi.fn(),
    approvePlan: vi.fn()
  } as unknown as JulesClient;

  const mockSession = {} as JulesAdapterSessionV1;

  it('handleAwaitingUserFeedback ignores null activities', async () => {
    vi.mocked(mockClient.getActivities).mockResolvedValueOnce(null as any);
    const res = await handleAwaitingUserFeedback(mockClient, 'sess-1', mockSession);
    expect(res).toBeNull();
  });

  it('handleAwaitingUserFeedback handles missing questionText fallback', async () => {
    vi.mocked(mockClient.getActivities).mockResolvedValueOnce({
      activities: [{ type: 'QUESTION', id: 'act-1', answered: false }]
    });
    const res = await handleAwaitingUserFeedback(mockClient, 'sess-1', mockSession);
    expect(res?.pendingInteraction.question).toBe('Jules needs your feedback.');
  });

  it('handleAwaitingPlanApproval ignores null activities', async () => {
    vi.mocked(mockClient.getActivities).mockResolvedValueOnce(null as any);
    const res = await handleAwaitingPlanApproval(mockClient, 'sess-1', mockSession);
    expect(res).toBeNull();
  });

  it('handleAwaitingPlanApproval handles missing planSummary fallback', async () => {
    vi.mocked(mockClient.getActivities).mockResolvedValueOnce({
      activities: [{ type: 'PLAN_PROPOSAL', id: 'act-1', approved: false }]
    });
    const res = await handleAwaitingPlanApproval(mockClient, 'sess-1', mockSession);
    expect(res?.pendingInteraction.question).toBe('Please approve the plan.');
  });

  it('handleAwaitingPlanApproval deduplicates existing pending interaction', async () => {
     vi.mocked(mockClient.getActivities).mockResolvedValueOnce({
       activities: [{ type: 'PLAN_PROPOSAL', id: 'act-2', planSummary: 'P2', approved: false }]
     });
     const res = await handleAwaitingPlanApproval(mockClient, 'sess-1', {
        ...mockSession, pendingInteraction: { julesActivityId: 'act-2', type: 'plan_approval', question: 'P2', createdAt: '' }
     });
     expect(res).toBeNull();
  });

  it('processResolvedInteraction skips without text/answer for feedback', async () => {
       const processed = await processResolvedInteraction(
           mockClient,
           'sess-1',
           { type: 'user_feedback', julesActivityId: 'act-1', question: 'Q1', createdAt: '' },
           [{ questionId: 'act-1', answer: '' }]
       );
       expect(processed).toBe(false);
       expect(mockClient.sendMessage).not.toHaveBeenCalled();
  });

  it('processResolvedInteraction interprets "yes" or "approve" as approved', async () => {
      const processed = await processResolvedInteraction(
          mockClient,
          'sess-1',
          { type: 'plan_approval', julesActivityId: 'act-1', question: 'P1', createdAt: '' },
          [{ questionId: 'act-1', answer: 'yes' }]
      );
      expect(processed).toBe(true);
      expect(mockClient.approvePlan).toHaveBeenCalledWith('sess-1', { approved: true, reason: undefined });
  });

  it('processResolvedInteraction interprets arbitrary text as rejected and includes reason', async () => {
      const processed = await processResolvedInteraction(
          mockClient,
          'sess-1',
          { type: 'plan_approval', julesActivityId: 'act-1', question: 'P1', createdAt: '' },
          [{ questionId: 'act-1', answer: 'I disagree with step 2' }]
      );
      expect(processed).toBe(true);
      expect(mockClient.approvePlan).toHaveBeenCalledWith('sess-1', { approved: false, reason: 'I disagree with step 2' });
  });

  it('processResolvedInteraction finds by interactionId', async () => {
       const processed = await processResolvedInteraction(
           mockClient,
           'sess-1',
           { type: 'user_feedback', julesActivityId: 'act-1', paperclipInteractionId: 'paper-1', question: 'Q1', createdAt: '' },
           [{ interactionId: 'paper-1', text: 'My answer' }]
       );
       expect(processed).toBe(true);
       expect(mockClient.sendMessage).toHaveBeenCalledWith('sess-1', { message: 'My answer' });
  });
});
