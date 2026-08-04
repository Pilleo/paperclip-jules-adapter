import { JulesClient } from './jules-client.js';
import { JulesAdapterSessionV1 } from './session.js';

export async function handleAwaitingUserFeedback(
  client: JulesClient,
  sessionId: string,
  currentSession: JulesAdapterSessionV1
): Promise<{ pendingInteraction: JulesAdapterSessionV1['pendingInteraction'], paperclipInteraction: any } | null> {
  const activities = await client.getActivities(sessionId);
  // Extract latest unanswered question. Assume Jules API returns activities with a type and question text
  const questions = activities?.activities?.filter((a: any) => a.type === 'QUESTION' && !a.answered) || [];
  const latestQuestion = questions[questions.length - 1];

  if (!latestQuestion) {
    return null;
  }

  // Deduplicate using Jules activity ID
  if (currentSession.pendingInteraction?.julesActivityId === latestQuestion.id) {
    return null; // Already pending
  }

  const pendingInteraction = {
    type: "user_feedback" as const,
    julesActivityId: latestQuestion.id,
    question: latestQuestion.questionText || "Jules needs your feedback.",
    createdAt: new Date().toISOString()
  };

  const paperclipInteraction = {
    type: 'ask_user_questions',
    questions: [
      {
        id: latestQuestion.id, // Using Jules activity ID as interaction ID initially
        text: pendingInteraction.question
      }
    ]
  };

  return { pendingInteraction, paperclipInteraction };
}

export async function handleAwaitingPlanApproval(
  client: JulesClient,
  sessionId: string,
  currentSession: JulesAdapterSessionV1
): Promise<{ pendingInteraction: JulesAdapterSessionV1['pendingInteraction'], paperclipInteraction: any } | null> {
  const activities = await client.getActivities(sessionId);
  const plans = activities?.activities?.filter((a: any) => a.type === 'PLAN_PROPOSAL' && !a.approved) || [];
  const latestPlan = plans[plans.length - 1];

  if (!latestPlan) {
    return null;
  }

  if (currentSession.pendingInteraction?.julesActivityId === latestPlan.id) {
    return null;
  }

  const pendingInteraction = {
    type: "plan_approval" as const,
    julesActivityId: latestPlan.id,
    question: latestPlan.planSummary || "Please approve the plan.",
    createdAt: new Date().toISOString()
  };

  const paperclipInteraction = {
    type: 'ask_user_questions', // Could be 'confirm' if Paperclip supports it
    questions: [
      {
        id: latestPlan.id,
        text: `Approve plan: ${pendingInteraction.question}`
      }
    ]
  };

  return { pendingInteraction, paperclipInteraction };
}

export async function processResolvedInteraction(
  client: JulesClient,
  sessionId: string,
  pendingInteraction: Exclude<JulesAdapterSessionV1['pendingInteraction'], undefined>,
  resolvedInteractions: any[]
): Promise<boolean> {
  // Find if our pending interaction was resolved
  const resolution = resolvedInteractions?.find(ri =>
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
