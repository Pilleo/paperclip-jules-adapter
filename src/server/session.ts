import { z } from "zod";
import { JulesSessionId, PaperclipId, JulesActivityId, PrUrl, asJulesSessionId, asPaperclipId, asJulesActivityId, asPrUrl } from "./brands.js";
import { AdapterExecutionResult } from "@paperclipai/adapter-utils";

export const JulesSessionStateSchema = z.string();
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
  sessionId: z.string().optional(),
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

export interface JulesAdapterSessionV1 {
  version: 1;
  paperclipIssueId: PaperclipId;
  promptHash: string;
  repository: string;
  source: string;
  baseBranch: string;
  phase: z.infer<typeof SessionPhaseSchema>;
  julesSessionId?: JulesSessionId | undefined;
  julesSessionUrl?: string | undefined;
  julesState?: string | undefined;
  attempt: number;
  failedSessions: Array<{
    sessionId?: string | undefined;
    failedAt: string;
    message: string;
    classification: "transient" | "configuration" | "task" | "unknown";
  }>;
  currentPrUrl?: PrUrl | undefined;
  pendingInteraction?: {
    type: "user_feedback" | "plan_approval";
    julesActivityId: JulesActivityId;
    paperclipInteractionId?: string | undefined;
    question: string;
    createdAt: string;
  } | undefined;
  lastActivityId?: string | undefined;
  createdAt: string;
  lastPolledAt?: string | undefined;
}

export type SerializedSessionParams = NonNullable<AdapterExecutionResult["sessionParams"]>;

function isEmptyRecord(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

export const sessionCodec = {
  deserialize(data: unknown): Record<string, unknown> | null {
      if (data == null || isEmptyRecord(data)) return null;
      return JulesAdapterSessionV1Schema.parse(data) as Record<string, unknown>;
  },
  serialize(session: Record<string, unknown> | null): Record<string, unknown> | null {
      if (session == null) return null;
      return JulesAdapterSessionV1Schema.parse(session) as Record<string, unknown>;
  },
  decode(data: unknown): JulesAdapterSessionV1 | null {
    if (data == null || isEmptyRecord(data)) return null;

    if (typeof data !== 'object') {
      throw new Error('Invalid session data format');
    }

    const obj = data as Record<string, unknown>;
    if (obj['version'] !== 1) {
      throw new Error(`Unsupported session version: ${obj['version']}. Only version 1 is supported.`);
    }

    const raw = JulesAdapterSessionV1Schema.parse(data);
    return {
        ...raw,
        paperclipIssueId: asPaperclipId(raw.paperclipIssueId),
        julesSessionId: raw.julesSessionId ? asJulesSessionId(raw.julesSessionId) : undefined,
        currentPrUrl: raw.currentPrUrl ? asPrUrl(raw.currentPrUrl) : undefined,
        pendingInteraction: raw.pendingInteraction ? {
            ...raw.pendingInteraction,
            julesActivityId: asJulesActivityId(raw.pendingInteraction.julesActivityId)
        } : undefined
    } as JulesAdapterSessionV1;
  },

  encode(session: JulesAdapterSessionV1): unknown {
    return JulesAdapterSessionV1Schema.parse(session);
  },

  getDisplayId(session: Record<string, unknown> | null): string | null {
    if (!session) return null;
    const parsed = this.deserialize(session);
    return parsed?.['julesSessionId'] as string || null;
  }
};
export function serializeSession(session: JulesAdapterSessionV1): SerializedSessionParams {
  return sessionCodec.encode(session) as SerializedSessionParams;
}
