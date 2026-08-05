import { validateConfig, validateSecrets } from "./config.js";
import { JulesClient } from "./jules-client.js";
import { asJulesSessionId } from "./brands.js";
import { AdapterEnvironmentTestContext, AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";

export async function testEnvironment(ctx: AdapterEnvironmentTestContext & { authToken?: string }): Promise<AdapterEnvironmentTestResult> {
  const config = ctx.config || {};

  let validatedConfig;
  let validatedSecrets;
  try {
     validatedConfig = validateConfig(config);
     validatedSecrets = validateSecrets(ctx.authToken);
  } catch (err: unknown) {
      return {
          adapterType: "jules",
          status: "fail",
          testedAt: new Date().toISOString(),
          checks: [{
              code: "config_validation_failed",
              level: "error",
              message: [
                  err instanceof Error ? err.message : String(err),
                  `Received config keys: ${Object.keys(config).sort().join(", ") || "(none)"}`
              ].join(" - ")
          }]
      };
  }

  const client = new JulesClient(validatedSecrets.JULES_API_KEY);

  try {
     await client.getSession(asJulesSessionId('test-auth-check')).catch((err: unknown) => {
         throw err;
     });
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
             const message = err instanceof Error ? err.message : String(err);
             return {
                 adapterType: "jules",
                 status: "fail",
                 testedAt: new Date().toISOString(),
                 checks: [{
                     code: "jules_env_failed",
                     level: "error",
                     message: `Failed to verify Jules API environment: ${message}`
                 }]
             };
        }
    } else {
         const message = err instanceof Error ? err.message : String(err);
         return {
             adapterType: "jules",
             status: "fail",
             testedAt: new Date().toISOString(),
             checks: [{
                 code: "jules_env_failed",
                 level: "error",
                 message: `Failed to verify Jules API environment: ${message}`
             }]
         };
    }
  }

  if (validatedConfig.invariantsFile) {
  }

  return {
      adapterType: "jules",
      status: "pass",
      testedAt: new Date().toISOString(),
      checks: []
  };
}
