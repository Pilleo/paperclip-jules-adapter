import { execute } from "./execute.js";
import { testEnvironment } from "./test-environment.js";
import { AdapterConfigSchema } from "./config.js";

export const type = "jules";
export const label = "Google Jules";
export const models = [];

export {
  execute,
  testEnvironment,
  AdapterConfigSchema as configSchema
};
