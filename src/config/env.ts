/**
 * src/config/env.ts
 *
 * Validates required environment variables at import time.
 * Import this module before any infrastructure that depends on these vars.
 *
 * Does NOT log sensitive values.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `[env] Missing required environment variable: ${name}. ` +
        `Set it before starting the worker.`,
    );
  }
  return value;
}

/**
 * Twilio credentials — lazy-validated so tests can set process.env before import.
 * Call getTwilioEnv() at runtime (not module-level) to allow tests to inject vars.
 */
export function getTwilioEnv(): {
  accountSid: string;
  authToken: string;
  whatsappFrom: string;
} {
  return {
    accountSid: requireEnv("TWILIO_ACCOUNT_SID"),
    authToken: requireEnv("TWILIO_AUTH_TOKEN"),
    whatsappFrom: requireEnv("TWILIO_WHATSAPP_FROM"),
  };
}
