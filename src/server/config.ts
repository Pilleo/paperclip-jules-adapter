import { execSync } from "node:child_process";

export function discoverLocalGitRepository(cwd?: string): string | undefined {
  try {
    const remoteUrl = execSync("git config --get remote.origin.url", {
      cwd: cwd || process.cwd(),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
    if (remoteUrl) return remoteUrl;
  } catch {
    // git command unavailable or not a git repository
  }
  return undefined;
}

export function discoverLocalGitDefaultBranch(cwd?: string): string | undefined {
  try {
    // 1. Try origin/HEAD symbolic ref
    const ref = execSync("git symbolic-ref --short refs/remotes/origin/HEAD", {
      cwd: cwd || process.cwd(),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
    if (ref) return ref.replace(/^origin\//, "");
  } catch {
    // ignore
  }
  try {
    // 2. Fallback to current HEAD branch
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: cwd || process.cwd(),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
    if (branch && branch !== "HEAD") return branch;
  } catch {
    // ignore
  }
  return "master";
}
import { z } from "zod";

const RepositorySchema = z.string().trim().min(1).transform((value, ctx) => {
  const sshNormalized = value.replace(/^git@github\.com:/i, "github.com/");
  const withoutCredentials = sshNormalized.replace(/^[a-z]+:\/\/[^/@]+@/i, "https://");
  const match = withoutCredentials.match(/(?:github\.com[/:]|^)([^/\s]+)\/([^/#\s]+?)(?:\.git)?$/i);
  if (!match) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "repository must be owner/repo or a canonical GitHub URL" });
    return z.NEVER;
  }
  return `${match[1]}/${match[2]}`;
});

const SettingsSchema = z.object({
  repository: z.string().trim().min(1).optional(),
  source: z.string().trim().min(1).optional(), // legacy
  baseBranch: z.string().trim().min(1).optional(),
  defaultBranch: z.string().trim().min(1).optional(),
  repositoryUrl: z.string().trim().min(1).optional(),
  planApprovalPolicy: z.enum(["required", "trusted_opt_out"]).optional(),
  prPolicy: z.enum(["auto", "always", "never"]).optional(),
  pollCadenceSeconds: z.number().int().min(30).max(3_600).optional(),
  requestTimeoutSeconds: z.number().int().min(5).max(300).optional(),
  retryBudget: z.number().int().min(0).max(10).optional(),
  sessionDeadlineMinutes: z.number().int().min(15).max(7 * 24 * 60).optional(),
  progressVerbosity: z.enum(["quiet", "normal", "verbose"]).optional(),
  automationMode: z.enum(["AUTO_CREATE_PR", "AUTOMATION_MODE_UNSPECIFIED"]).optional(),
  requirePlanApproval: z.boolean().optional(), // legacy
  maxAutomaticRestarts: z.number().int().min(0).max(10).optional(), // legacy
  pollIntervalMinutes: z.number().min(1).max(60).optional(),
  heartbeatPollWindowMinutes: z.number().min(1).max(180).optional(),
  pollIntervalSeconds: z.number().min(10).max(3_600).optional(),
  heartbeatPollWindowSeconds: z.number().min(30).max(10_800).optional(),
  maxSessionAgeHours: z.number().min(1).optional(),
  invariantsFile: z.string().optional(),
}).passthrough();

export interface ConfigResolutionContext {
  issueOverride?: unknown;
  workspace?: { repositoryUrl?: string; defaultBranch?: string; hasRemote?: boolean };
  codeChanging?: boolean;
  warn?: (message: string) => void;
}

export interface AdapterConfig {
  repository: string;
  source: string;
  baseBranch: string;
  planApprovalPolicy: "required" | "trusted_opt_out";
  prPolicy: "auto" | "always" | "never";
  pollCadenceSeconds: number;
  requestTimeoutSeconds: number;
  retryBudget: number;
  sessionDeadlineMinutes: number;
  progressVerbosity: "quiet" | "normal" | "verbose";
  requirePlanApproval: boolean;
  automationMode: "AUTO_CREATE_PR" | "AUTOMATION_MODE_UNSPECIFIED";
  maxAutomaticRestarts: number;
  [key: string]: unknown;
}

export const SAFE_DEFAULTS = {
  planApprovalPolicy: "required",
  prPolicy: "auto",
  pollCadenceSeconds: 45,
  requestTimeoutSeconds: 30,
  retryBudget: 3,
  sessionDeadlineMinutes: 360,
  progressVerbosity: "normal",
} as const;

function sourceRepository(source?: string): string | undefined {
  const match = source?.match(/^sources\/github\/([^/]+)\/([^/]+)$/);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

export function redactConfigError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/g, "https://[REDACTED]@")
    .replace(/\b(?:ghp_|github_pat_|AIza)[A-Za-z0-9_-]+\b/g, "[REDACTED]");
}

export function validateConfig(config: unknown, context: ConfigResolutionContext = {}): AdapterConfig {
  try {
    const adapter = SettingsSchema.parse(config);
    const override = SettingsSchema.partial().parse(context.issueOverride ?? {});
    const merged = { ...adapter, ...override };
    const warnings: string[] = [];
    const warn = (message: string) => { warnings.push(message); context.warn?.(message); };

    const fromSource = sourceRepository(merged.source);
    const discoveredRepo = context.workspace?.repositoryUrl ?? discoverLocalGitRepository();
    const repositoryInput = merged.repository ?? fromSource ?? merged.repositoryUrl ?? discoveredRepo;
    const repository = merged.repository && !merged.repository.includes("/") && merged.source
      ? merged.repository
      : RepositorySchema.parse(repositoryInput);
    if (merged.repository && !merged.repository.includes("/") && merged.source) warn("Legacy non-canonical `repository` is retained for compatibility; migrate it to owner/repo.");
    if (merged.source) warn("`source` is deprecated; use the canonical `repository` setting instead.");
    if (merged.repository && fromSource && RepositorySchema.parse(merged.repository) !== fromSource) {
      throw new Error("Legacy `source` and `repository` identify different repositories; remove the conflict explicitly");
    }
    const baseBranch = merged.baseBranch ?? merged.defaultBranch ?? context.workspace?.defaultBranch ?? (merged.source ? "master" : undefined);
    if (!merged.baseBranch && !merged.defaultBranch && !context.workspace?.defaultBranch && merged.source) warn("Legacy configuration omitted baseBranch; retaining its historical `master` intent. Configure provider metadata or an explicit branch.");
    if (!baseBranch) throw new Error("baseBranch could not be derived; configure repository provider metadata or set baseBranch explicitly (for example `main`)");
    if (merged.requirePlanApproval !== undefined) warn("`requirePlanApproval` is deprecated; use `planApprovalPolicy`.");
    if (merged.maxAutomaticRestarts !== undefined) warn("`maxAutomaticRestarts` is deprecated; use `retryBudget`.");
    if (merged.pollIntervalSeconds !== undefined) warn("`pollIntervalSeconds` is deprecated; use `pollCadenceSeconds`.");

    const planApprovalPolicy = merged.planApprovalPolicy ?? (merged.requirePlanApproval === false ? "trusted_opt_out" : SAFE_DEFAULTS.planApprovalPolicy);
    const prPolicy = merged.prPolicy ?? SAFE_DEFAULTS.prPolicy;
    const hasRemote = context.workspace?.hasRemote ?? Boolean(merged.repository ?? merged.repositoryUrl ?? context.workspace?.repositoryUrl ?? fromSource);
    if (prPolicy === "always" && !hasRemote) throw new Error("prPolicy `always` requires a remote repository; configure a canonical repository or use `auto`");
    const createPr = prPolicy === "always" || (prPolicy === "auto" && hasRemote);
    const retryBudget = merged.retryBudget ?? merged.maxAutomaticRestarts ?? SAFE_DEFAULTS.retryBudget;

    return {
      ...merged,
      repository,
      source: `sources/github/${repository}`,
      baseBranch,
      planApprovalPolicy,
      prPolicy,
      pollCadenceSeconds: merged.pollCadenceSeconds ?? merged.pollIntervalSeconds ?? SAFE_DEFAULTS.pollCadenceSeconds,
      requestTimeoutSeconds: merged.requestTimeoutSeconds ?? SAFE_DEFAULTS.requestTimeoutSeconds,
      retryBudget,
      sessionDeadlineMinutes: merged.sessionDeadlineMinutes ?? (merged.maxSessionAgeHours ? merged.maxSessionAgeHours * 60 : SAFE_DEFAULTS.sessionDeadlineMinutes),
      progressVerbosity: merged.progressVerbosity ?? SAFE_DEFAULTS.progressVerbosity,
      requirePlanApproval: context.codeChanging === false ? false : planApprovalPolicy === "required",
      automationMode: createPr ? "AUTO_CREATE_PR" : "AUTOMATION_MODE_UNSPECIFIED",
      maxAutomaticRestarts: retryBudget,
      compatibilityWarnings: warnings,
    };
  } catch (error) {
    throw new Error(`Invalid Jules settings: ${redactConfigError(error)}. Correct the named field in the issue override or adapter settings.`);
  }
}

export const AdapterConfigSchema = SettingsSchema;

export function requireJulesApiKey(runtimeConfig: unknown): string {
  const env = typeof runtimeConfig === "object" && runtimeConfig !== null && !Array.isArray(runtimeConfig) ? (runtimeConfig as Record<string, unknown>)["env"] : undefined;
  const rawKey = typeof env === "object" && env !== null && !Array.isArray(env) ? (env as Record<string, unknown>)["JULES_API_KEY"] : undefined;
  const key = typeof rawKey === "string" ? rawKey.trim() : "";
  if (!key) throw new Error("JULES_API_KEY did not resolve. Bind the shared secret to the Jules agent at env.JULES_API_KEY as {type:\"secret_ref\", secretId:<secret uuid>, version:\"latest\"} (record key spelling - jules-api-key or jules_api_key - is irrelevant; resolution is id-based).");
  return key;
}
