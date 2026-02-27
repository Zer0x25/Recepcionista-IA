import "dotenv/config";
import { z } from "zod";
import { logger } from "../observability/logger.js";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().default(3000),
  ADMIN_API_KEY: z.string().min(8),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_WHATSAPP_FROM: z.string().optional(),
});

function validateEnv() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const missingVars = result.error.issues.map((i) => i.path.join(".")).join(", ");
    logger.error({
      eventType: "ENV_VALIDATION_FAILED",
      missingVars,
      errors: result.error.format(),
    });
    throw new Error(`Environment validation failed: ${missingVars}`);
  }
  return result.data;
}

export const env = validateEnv();

/**
 * Legacy helper for Twilio config.
 * Throws if Twilio vars are missing when called.
 */
export function getTwilioEnv() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const whatsappFrom = process.env.TWILIO_WHATSAPP_FROM;

  if (!accountSid || !authToken || !whatsappFrom) {
    throw new Error(
      "Missing Twilio configuration. Ensure TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_WHATSAPP_FROM are set.",
    );
  }
  return {
    accountSid,
    authToken,
    whatsappFrom,
  };
}
