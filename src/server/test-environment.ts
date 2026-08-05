import { AdapterConfig, requireJulesApiKey, validateConfig } from "./config.js";
import { JulesClient } from "./jules-client.js";
import { asJulesSessionId } from "./brands.js";
import { AdapterEnvironmentTestContext, AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { sanitizeError } from "./error-sanitizer.js";

export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const config = ctx.config?.['adapterSchemaValues'] || ctx.config || {};

  let validatedConfig: AdapterConfig;
  let apiKey: string;
  try {
     validatedConfig = validateConfig(config);
     apiKey = requireJulesApiKey();
  } catch (err: unknown) {
      const diagnosticKeys = Object.keys(config).sort().join(", ") || "(none)";
      return {
          adapterType: "jules",
          status: "fail",
          testedAt: new Date().toISOString(),
          checks: [{
              code: "config_validation_failed",
              level: "error",
              message: `Jules adapter configuration is invalid. Received config keys: ${diagnosticKeys}. Details: ${sanitizeError(err)}`
          }]
      };
  }

  const client = new JulesClient(apiKey);

  try {
     await client.getSession(asJulesSessionId('test-auth-check'));
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'status' in err) {
        const status = (err as { status: number }).status;
        if (status === 401 || status === 403) {
          return {
              adapterType: "jules",
              status: "fail",
              testedAt: new Date().toISOString(),
              checks: [{
                  code: "jules_auth_failed",
                  level: "error",
                  message: "Jules API authentication failed. Check your JULES_API_KEY."
              }]
          };
        } else if (status === 404 || status === 400 || status === 422) {
           // Not found is fine for auth checking a fake string
        } else {
             return {
                 adapterType: "jules",
                 status: "fail",
                 testedAt: new Date().toISOString(),
                 checks: [{
                     code: "jules_env_failed",
                     level: "error",
                     message: `Failed to verify Jules API environment: ${sanitizeError(err)}`
                 }]
             };
        }
    } else {
         return {
             adapterType: "jules",
             status: "fail",
             testedAt: new Date().toISOString(),
             checks: [{
                 code: "jules_env_failed",
                 level: "error",
                 message: `Failed to verify Jules API environment: ${sanitizeError(err)}`
             }]
         };
    }
  }

  return {
      adapterType: "jules",
      status: "pass",
      testedAt: new Date().toISOString(),
      checks: []
  };
}
