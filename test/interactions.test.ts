import { describe, it, expect, vi } from 'vitest';
import { handleAwaitingUserFeedback, handleAwaitingPlanApproval, processResolvedInteraction } from '../src/server/interactions';
import { JulesClient } from '../src/server/jules-client';
import { JulesAdapterSessionV1 } from '../src/server/session';

describe('Interactions', () => {
  const mockClient = {
    getActivities: vi.fn(),
    sendMessage: vi.fn(),
    approvePlan: vi.fn()
  } as unknown as JulesClient;

  const mockSession = {} as JulesAdapterSessionV1;

  describe('handleAwaitingUserFeedback', () => {
    it('returns null if no questions', async () => {
      vi.mocked(mockClient.getActivities).mockResolvedValueOnce({ activities: [] });
      const res = await handleAwaitingUserFeedback(mockClient, 'sess-1', mockSession);
      expect(res).toBeNull();
    });

    it('returns interaction for latest unanswered question', async () => {
      vi.mocked(mockClient.getActivities).mockResolvedValueOnce({
        activities: [
          { type: 'QUESTION', id: 'act-1', questionText: 'Q1?', answered: true },
          { type: 'QUESTION', id: 'act-2', questionText: 'Q2?', answered: false }
        ]
      });
      const res = await handleAwaitingUserFeedback(mockClient, 'sess-1', mockSession);
      expect(res?.pendingInteraction.question).toBe('Q2?');
      expect(res?.paperclipInteraction.questions[0].text).toBe('Q2?');
    });

    it('deduplicates existing pending interaction', async () => {
      vi.mocked(mockClient.getActivities).mockResolvedValueOnce({
        activities: [{ type: 'QUESTION', id: 'act-2', questionText: 'Q2?', answered: false }]
      });
      const res = await handleAwaitingUserFeedback(mockClient, 'sess-1', {
         ...mockSession, pendingInteraction: { julesActivityId: 'act-2', type: 'user_feedback', question: 'Q2?', createdAt: '' }
      });
      expect(res).toBeNull();
    });
  });

  describe('handleAwaitingPlanApproval', () => {
     it('returns null if no plans', async () => {
       vi.mocked(mockClient.getActivities).mockResolvedValueOnce({ activities: [] });
       const res = await handleAwaitingPlanApproval(mockClient, 'sess-1', mockSession);
       expect(res).toBeNull();
     });

     it('returns interaction for latest unapproved plan', async () => {
       vi.mocked(mockClient.getActivities).mockResolvedValueOnce({
         activities: [
           { type: 'PLAN_PROPOSAL', id: 'act-1', planSummary: 'Plan 1', approved: true },
           { type: 'PLAN_PROPOSAL', id: 'act-2', planSummary: 'Plan 2', approved: false }
         ]
       });
       const res = await handleAwaitingPlanApproval(mockClient, 'sess-1', mockSession);
       expect(res?.pendingInteraction.question).toBe('Plan 2');
     });
  });

  describe('processResolvedInteraction', () => {
      it('processes user feedback', async () => {
          const processed = await processResolvedInteraction(
              mockClient,
              'sess-1',
              { type: 'user_feedback', julesActivityId: 'act-1', question: 'Q1', createdAt: '' },
              [{ questionId: 'act-1', answer: 'My answer' }]
          );
          expect(processed).toBe(true);
          expect(mockClient.sendMessage).toHaveBeenCalledWith('sess-1', { message: 'My answer' });
      });

      it('processes plan approval', async () => {
          const processed = await processResolvedInteraction(
              mockClient,
              'sess-1',
              { type: 'plan_approval', julesActivityId: 'act-1', question: 'P1', createdAt: '' },
              [{ questionId: 'act-1', approved: true }]
          );
          expect(processed).toBe(true);
          expect(mockClient.approvePlan).toHaveBeenCalledWith('sess-1', { approved: true, reason: undefined });
      });

      it('returns false if not found', async () => {
           const processed = await processResolvedInteraction(
               mockClient,
               'sess-1',
               { type: 'plan_approval', julesActivityId: 'act-1', question: 'P1', createdAt: '' },
               [{ questionId: 'act-2', approved: true }]
           );
           expect(processed).toBe(false);
      });
  });
});
