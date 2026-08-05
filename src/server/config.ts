import { z } from "zod";

export const AdapterConfigSchema = z.object({
  source: z.string().min(1, "Source is required"),
  repository: z.string().min(1, "Repository is required"),
  baseBranch: z.string().default("master"),
  automationMode: z.enum(["AUTO_CREATE_PR", "AUTOMATION_MODE_UNSPECIFIED"]).default("AUTO_CREATE_PR"),
  requirePlanApproval: z.boolean().default(false),
  pollIntervalSeconds: z.number().min(10).max(300).default(45),
  heartbeatPollWindowSeconds: z.number().min(30).max(600).default(120),
  maxSessionAgeHours: z.number().min(1).default(168),
  maxAutomaticRestarts: z.number().min(0).max(10).default(3),
  invariantsFile: z.string().optional(),
}).refine(data => {
  return data.source.length > 0;
}, "Source is invalid");

export type AdapterConfig = z.infer<typeof AdapterConfigSchema>;

export interface AdapterSecrets {
  JULES_API_KEY: string;
}

export function validateConfig(config: unknown): AdapterConfig {
  return AdapterConfigSchema.parse(config);
}

export function validateSecrets(authToken: string | undefined): AdapterSecrets {
  if (!authToken) {
    throw new Error("Missing JULES_API_KEY authentication token (passed as ctx.authToken)");
  }
  return {
    JULES_API_KEY: authToken
  };
}
