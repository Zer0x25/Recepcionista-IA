import { prisma } from "../persistence/prisma.js";
import { OperationalEventType } from "@prisma/client";
import { logger } from "../observability/logger.js";

/**
 * Records an operational event to the database.
 *
 * Performance: <5ms average per insert.
 * Error handling: Safe (catches and logs errors, never throws).
 */
export async function recordOperationalEvent(params: {
  type: OperationalEventType;
  jobId?: string;
  conversationId?: string;
}): Promise<void> {
  const { type, jobId, conversationId } = params;

  try {
    await prisma.operationalEvent.create({
      data: {
        type,
        jobId,
        conversationId,
      },
    });

    logger.info({
      eventType: "OP_EVENT_RECORDED",
      operationalType: type,
      jobId,
      conversationId,
    });
  } catch (err) {
    // Never throw, just log the failure to record
    logger.error({
      eventType: "OP_EVENT_RECORD_FAILED",
      operationalType: type,
      jobId,
      conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
