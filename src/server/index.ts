import { execute } from "./execute.js";
import { testEnvironment } from "./test-environment.js";
import { AdapterConfigSchema } from "./config.js";
import { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { sessionCodec } from "./session.js";

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
        sessionCodec
    };
}
