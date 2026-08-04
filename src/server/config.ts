import { z } from "zod";

export const AdapterConfigSchema = z.object({
  source: z.string().min(1, "Source is required"),
  repository: z.string().min(1, "Repository is required"),
  baseBranch: z.string().default("master"),
  automationMode: z.enum(["AUTO_CREATE_PR", "MANUAL", "WAIT_FOR_APPROVAL"]).default("AUTO_CREATE_PR"),
  requirePlanApproval: z.boolean().default(false),
  pollIntervalSeconds: z.number().min(10).max(300).default(45),
  heartbeatPollWindowSeconds: z.number().min(30).max(600).default(120),
  maxSessionAgeHours: z.number().min(1).default(168),
  maxAutomaticRestarts: z.number().min(0).max(10).default(3),
  invariantsFile: z.string().optional(),
}).refine(data => {
  // Simple check to ensure source and repository match conceptually or are valid
  // This could be expanded based on specific allowlist requirements
  return data.source.length > 0;
}, "Source is invalid");

export type AdapterConfig = z.infer<typeof AdapterConfigSchema>;

export interface AdapterSecrets {
  JULES_API_KEY: string;
  PAPERCLIP_API_TOKEN?: string;
}

export function validateConfig(config: unknown): AdapterConfig {
  return AdapterConfigSchema.parse(config);
}

export function validateSecrets(env: Record<string, string | undefined>): AdapterSecrets {
  const JULES_API_KEY = env.JULES_API_KEY;
  if (!JULES_API_KEY) {
    throw new Error("Missing JULES_API_KEY secret");
  }
  return {
    JULES_API_KEY,
    PAPERCLIP_API_TOKEN: env.PAPERCLIP_API_TOKEN
  };
}
