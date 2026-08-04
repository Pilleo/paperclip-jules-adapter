import { validateConfig, validateSecrets } from "./config.js";
import { JulesClient } from "./jules-client.js";
import { asJulesSessionId } from "./brands.js";

export async function testEnvironment(config: unknown, secrets: Record<string, string | undefined>): Promise<void> {
  const validatedConfig = validateConfig(config);
  const validatedSecrets = validateSecrets(secrets);

  const client = new JulesClient(validatedSecrets.JULES_API_KEY);

  try {
     await client.getSession(asJulesSessionId('test-auth-check')).catch((err: unknown) => {
         if (err && typeof err === 'object' && 'status' in err) {
             const status = (err as { status: number }).status;
             if (status === 401 || status === 403) {
                 throw err;
             }
         }
     });
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'status' in err) {
        const status = (err as { status: number }).status;
        if (status === 401 || status === 403) {
          throw new Error("Jules API authentication failed. Check your JULES_API_KEY.");
        }
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to verify Jules API environment: ${message}`);
  }

  if (validatedConfig.invariantsFile) {
  }
}
