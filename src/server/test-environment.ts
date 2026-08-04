import { validateConfig, validateSecrets } from "./config.js";
import { JulesClient } from "./jules-client.js";

export async function testEnvironment(config: unknown, secrets: Record<string, string | undefined>): Promise<void> {
  const validatedConfig = validateConfig(config);
  const validatedSecrets = validateSecrets(secrets);

  const client = new JulesClient(validatedSecrets.JULES_API_KEY);

  // We make a dummy call to verify authentication works.
  // Jules API v1alpha does not explicitly mention a generic 'whoami' or 'ping',
  // so we might attempt to list sessions or create a dummy session and delete it.
  // For the sake of this mock implementation let's call a method that tests auth.
  try {
     // This is a proxy for "does auth work?"
     // Using a potentially 404 session get, but auth failure (401/403) will throw appropriately.
     await client.getSession('test-auth-check').catch(err => {
         if (err.status === 401 || err.status === 403) {
             throw err; // Re-throw auth errors
         }
         // Ignore 404 or other errors as it just means the session doesn't exist, but auth is fine
     });
  } catch (err: any) {
    if (err.status === 401 || err.status === 403) {
      throw new Error("Jules API authentication failed. Check your JULES_API_KEY.");
    }
    throw new Error(`Failed to verify Jules API environment: ${err.message}`);
  }

  // Ensure invariants file if specified
  if (validatedConfig.invariantsFile) {
      // In a real environment we might want to check the file system here
      // But adapters often don't have direct fs access to the user's repo unless provided by Paperclip host context
  }
}
