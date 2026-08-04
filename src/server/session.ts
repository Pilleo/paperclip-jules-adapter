import { z } from "zod";

export const JulesSessionStateSchema = z.string(); // Accepts any state string for diagnostics
export type JulesSessionState = z.infer<typeof JulesSessionStateSchema>;

export const SessionPhaseSchema = z.enum([
  "STARTING",
  "RUNNING",
  "WAITING_FOR_FEEDBACK",
  "WAITING_FOR_PLAN_APPROVAL",
  "RETRY_SCHEDULED",
  "PR_CREATED",
  "COMPLETED",
  "FAILED"
]);

export const FailedSessionSchema = z.object({
  sessionId: z.string(),
  failedAt: z.string(),
  message: z.string(),
  classification: z.enum(["transient", "configuration", "task", "unknown"])
});

export const PendingInteractionSchema = z.object({
  type: z.enum(["user_feedback", "plan_approval"]),
  julesActivityId: z.string(),
  paperclipInteractionId: z.string().optional(),
  question: z.string(),
  createdAt: z.string()
});

export const JulesAdapterSessionV1Schema = z.object({
  version: z.literal(1),
  paperclipIssueId: z.string(),
  promptHash: z.string(),
  repository: z.string(),
  source: z.string(),
  baseBranch: z.string(),
  phase: SessionPhaseSchema,
  julesSessionId: z.string().optional(),
  julesSessionUrl: z.string().optional(),
  julesState: JulesSessionStateSchema.optional(),
  attempt: z.number().int().min(1),
  failedSessions: z.array(FailedSessionSchema),
  currentPrUrl: z.string().optional(),
  pendingInteraction: PendingInteractionSchema.optional(),
  lastActivityId: z.string().optional(),
  createdAt: z.string(),
  lastPolledAt: z.string().optional()
});

export type JulesAdapterSessionV1 = z.infer<typeof JulesAdapterSessionV1Schema>;

export const sessionCodec = {
  decode(data: unknown): JulesAdapterSessionV1 {
    if (typeof data !== 'object' || data === null) {
      throw new Error('Invalid session data format');
    }

    const obj = data as any;
    if (obj.version !== 1) {
      throw new Error(`Unsupported session version: ${obj.version}. Only version 1 is supported.`);
    }

    return JulesAdapterSessionV1Schema.parse(data);
  },

  encode(session: JulesAdapterSessionV1): unknown {
    return JulesAdapterSessionV1Schema.parse(session);
  },

  getDisplayId(session: JulesAdapterSessionV1): string | undefined {
    return session.julesSessionId;
  }
};
