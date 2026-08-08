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

Required configuration:

- source: Jules source resource, for example sources/github/Pilleo/mazewall
- repository: GitHub owner/repository, for example Pilleo/mazewall
- baseBranch: branch Jules starts from
Timing is intentionally fixed: the adapter checkpoints a new Jules session
immediately, polls every five minutes, and watches resumed work for up to six
hours per Paperclip run. Active work is continued through Paperclip's durable
retry path instead of being reported as successfully completed.
`,
        getConfigSchema: () => julesConfigSchema,
    };
}
