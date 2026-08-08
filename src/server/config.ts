import { z } from "zod";

export const AdapterConfigSchema = z.object({
  source: z.string().min(1, "Source is required"),
  repository: z.string().min(1, "Repository is required"),
  baseBranch: z.string().default("master"),
  automationMode: z.enum(["AUTO_CREATE_PR", "AUTOMATION_MODE_UNSPECIFIED"]).default("AUTO_CREATE_PR"),
  requirePlanApproval: z.boolean().default(false),
  // Deprecated timing fields are accepted so existing saved agents continue
  // to load, but execution uses fixed Jules-appropriate timing.
  pollIntervalMinutes: z.number().min(1).max(60).optional(),
  heartbeatPollWindowMinutes: z.number().min(1).max(180).optional(),
  pollIntervalSeconds: z.number().min(10).max(3_600).optional(),
  heartbeatPollWindowSeconds: z.number().min(30).max(10_800).optional(),
  maxSessionAgeHours: z.number().min(1).optional(),
  maxAutomaticRestarts: z.number().min(0).max(10).default(3),
  invariantsFile: z.string().optional(),
});

export type AdapterConfig = z.infer<typeof AdapterConfigSchema>;

export function validateConfig(config: unknown): AdapterConfig {
  return AdapterConfigSchema.parse(config);
}

export function requireJulesApiKey(runtimeConfig: unknown): string {
  const env = typeof runtimeConfig === "object" && runtimeConfig !== null && !Array.isArray(runtimeConfig)
    ? (runtimeConfig as Record<string, unknown>)["env"]
    : undefined;
  const rawKey = typeof env === "object" && env !== null && !Array.isArray(env)
    ? (env as Record<string, unknown>)["JULES_API_KEY"]
    : undefined;
  const key = typeof rawKey === "string" ? rawKey.trim() : "";
  if (!key) {
    throw new Error(
      "JULES_API_KEY is missing from the Paperclip runtime configuration. " +
      "Create the shared secret as jules-api-key and bind it to the Jules agent at env.JULES_API_KEY.",
    );
  }
  return key;
}
