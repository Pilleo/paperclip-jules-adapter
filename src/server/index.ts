import { execute } from "./execute.js";
import { testEnvironment } from "./test-environment.js";
import { AdapterConfigSchema } from "./config.js";
import { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { sessionCodec } from "./session.js";
import { julesConfigSchema } from "./config-schema.js";

export const type = "jules";
export const label = "Google Jules";
export const models = [];

export {
  execute,
  testEnvironment,
  AdapterConfigSchema as configSchema
};
export { checkJulesCredentials, checkLocalState } from "./health.js";
export { createTelemetry, redactTelemetry } from "./telemetry.js";

export function createServerAdapter(): ServerAdapterModule {
    return {
        type: "jules",
        execute,
        testEnvironment,
        sessionCodec,
        supportsLocalAgentJwt: true,
        models: [],
        agentConfigurationDoc: `
# Google Jules adapter

Runs long-lived Google Jules sessions against a configured GitHub repository.

Repository and base branch are derived from the Paperclip workspace when possible.
Otherwise configure repository (owner/repo) and baseBranch. See docs/settings.md
for typed policies, bounds, precedence, examples, and legacy migration behavior.
`,
        getConfigSchema: () => julesConfigSchema,
    };
}
