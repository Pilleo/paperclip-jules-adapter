import { JulesClient } from './jules-client.js';
import { JulesAdapterSessionV1 } from './session.js';
import { JulesSessionId, asJulesActivityId } from './brands.js';

export async function handleAwaitingUserFeedback(
  client: JulesClient,
  sessionId: JulesSessionId,
  currentSession: JulesAdapterSessionV1
): Promise<{ pendingInteraction: JulesAdapterSessionV1['pendingInteraction'], paperclipInteraction: Record<string, unknown> } | null> {
  const activities = await client.getActivities(sessionId);
  if (!activities || !activities.activities) return null;

  const questions = activities.activities.filter(a => a.type === 'QUESTION' && !a.answered);
  const latestQuestion = questions[questions.length - 1];

  if (!latestQuestion) {
    return null;
  }

  if (currentSession.pendingInteraction?.julesActivityId === latestQuestion.id) {
    return null;
  }

  const pendingInteraction = {
    type: "user_feedback" as const,
    julesActivityId: asJulesActivityId(latestQuestion.id),
    question: latestQuestion.questionText || "Jules needs your feedback.",
    createdAt: new Date().toISOString()
  };

  const paperclipInteraction = {
    type: 'ask_user_questions',
    questions: [
      {
        id: latestQuestion.id,
        text: pendingInteraction.question
      }
    ]
  };

  return { pendingInteraction, paperclipInteraction };
}

export async function handleAwaitingPlanApproval(
  client: JulesClient,
  sessionId: JulesSessionId,
  currentSession: JulesAdapterSessionV1
): Promise<{ pendingInteraction: JulesAdapterSessionV1['pendingInteraction'], paperclipInteraction: Record<string, unknown> } | null> {
  const activities = await client.getActivities(sessionId);
  if (!activities || !activities.activities) return null;

  const plans = activities.activities.filter(a => a.type === 'PLAN_PROPOSAL' && !a.approved);
  const latestPlan = plans[plans.length - 1];

  if (!latestPlan) {
    return null;
  }

  if (currentSession.pendingInteraction?.julesActivityId === latestPlan.id) {
    return null;
  }

  const pendingInteraction = {
    type: "plan_approval" as const,
    julesActivityId: asJulesActivityId(latestPlan.id),
    question: latestPlan.planSummary || "Please approve the plan.",
    createdAt: new Date().toISOString()
  };

  const paperclipInteraction = {
    type: 'ask_user_questions',
    questions: [
      {
        id: latestPlan.id,
        text: `Approve plan: ${pendingInteraction.question}`
      }
    ]
  };

  return { pendingInteraction, paperclipInteraction };
}

export interface ResolvedInteractionPayload {
    interactionId?: string | undefined;
    questionId?: string | undefined;
    answer?: string | undefined;
    text?: string | undefined;
    approved?: boolean | undefined;
    reason?: string | undefined;
}

export async function processResolvedInteraction(
  client: JulesClient,
  sessionId: JulesSessionId,
  pendingInteraction: Exclude<JulesAdapterSessionV1['pendingInteraction'], undefined>,
  resolvedInteractions: ResolvedInteractionPayload[]
): Promise<boolean> {
  const resolution = resolvedInteractions.find(ri =>
    (ri.interactionId && ri.interactionId === pendingInteraction.paperclipInteractionId) ||
    (ri.questionId && ri.questionId === pendingInteraction.julesActivityId)
  );

  if (!resolution) {
    return false;
  }

  if (pendingInteraction.type === 'user_feedback') {
    const answer = resolution.answer || resolution.text;
    if (answer) {
      await client.sendMessage(sessionId, { message: answer });
      return true;
    }
  } else if (pendingInteraction.type === 'plan_approval') {
    const approved = resolution.approved ?? (resolution.answer?.toLowerCase() === 'yes' || resolution.answer?.toLowerCase() === 'approve');
    const reason = resolution.reason || (!approved ? resolution.answer : undefined);

    await client.approvePlan(sessionId, { approved, reason });
    return true;
  }

  return false;
}
