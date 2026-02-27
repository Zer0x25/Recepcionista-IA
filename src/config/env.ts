import { z } from "zod";
import { logger } from "../observability/logger.js";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().default(3000),
  ADMIN_API_KEY: z.string().min(8),
});

function validateEnv() {
  try {
    return envSchema.parse(process.env);
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      const missingVars = err.issues.map((i) => i.path.join(".")).join(", ");
      logger.error({
        eventType: "ENV_VALIDATION_FAILED",
        missingVars,
        errors: err.format(),
      });
    } else {
      logger.error({
        msg: "Unknown environment validation error",
        error: err?.message,
      });
    }
    process.exit(1);
  }
}

export const env = validateEnv();
