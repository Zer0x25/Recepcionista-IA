import { Prisma, OperationalEventType } from "@prisma/client";
import { prisma } from "../persistence/prisma.js";
import { logger } from "../observability/logger.js";
import { recordOperationalEvent } from "../metrics/events.repository.js";

export const LOCK_TTL_MS = 60_000;
export const DEFAULT_BATCH_SIZE = 10;

/**
 * Atomically claim the next batch of PENDING jobs for processing.
 *
 * Uses FOR UPDATE SKIP LOCKED so two concurrent workers running this exact
 * statement at the same time will each get a disjoint set of rows.
 */
export async function claimNextJobs(
  workerId: string,
  batchSize: number = DEFAULT_BATCH_SIZE,
): Promise<any[]> {
  const claimed = await prisma.$transaction(async (tx) => {
    // Single atomic UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)
    const rows = await tx.$queryRaw<any[]>(Prisma.sql`
      UPDATE "Job"
      SET
        status      = 'PROCESSING',
        "lockedAt"  = now(),
        "lockedBy"  = ${workerId},
        "updatedAt" = now()
      WHERE id IN (
        SELECT id FROM "Job"
        WHERE status = 'PENDING'
          AND "nextRunAt" <= now()
          AND (
            "lockedAt" IS NULL
            OR "lockedAt" < now() - (${LOCK_TTL_MS} * interval '1 millisecond')
          )
        ORDER BY "nextRunAt" ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `);
    return rows;
  });

  if (claimed.length > 0) {
    logger.info({
      eventType: "JOB_CLAIMED",
      workerId,
      count: claimed.length,
    });
  } else {
    // Check for CLAIM_COLLISION: if no jobs claimed but there are PENDING jobs ready
    // it means they are all locked by other workers (SKIP LOCKED).
    const pendingReadyCount = await prisma.job.count({
      where: {
        status: "PENDING",
        nextRunAt: { lte: new Date() },
      },
    });

    if (pendingReadyCount > 0) {
      recordOperationalEvent({ type: OperationalEventType.CLAIM_COLLISION });
    }
  }

  return claimed;
}
