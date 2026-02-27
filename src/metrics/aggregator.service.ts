import { prisma } from "../persistence/prisma.js";
import { JobStatus } from "@prisma/client";
import { logger } from "../observability/logger.js";

/**
 * Floors a date to the start of its minute.
 */
export function floorToMinute(date: Date): Date {
  const d = new Date(date);
  d.setSeconds(0, 0);
  d.setMilliseconds(0);
  return d;
}

/**
 * Service to aggregate job metrics into windowed persistent records.
 */
export const AggregatorService = {
  /**
   * Aggregates jobs updated within the 60s window starting at `date` (floored).
   * Persists results into JobMetricAggregate.
   */
  async aggregateWindow(date: Date): Promise<void> {
    const windowStart = floorToMinute(date);
    const windowEnd = new Date(windowStart.getTime() + 60_000);

    const startTime = Date.now();

    // Query jobs updated in this window
    // We rely on status and updatedAt (even if updatedAt isn't indexed, it's required for windowing)
    const jobs = await prisma.job.findMany({
      where: {
        updatedAt: {
          gte: windowStart,
          lt: windowEnd,
        },
      },
      select: {
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (jobs.length === 0) {
      // Still create empty aggregates or just skip?
      // Requirement: "Persist real aggregates". If nothing happened, skip is safer/cleaner.
      return;
    }

    // Group jobs by status
    const statsByStatus = jobs.reduce(
      (acc, job) => {
        if (!acc[job.status]) {
          acc[job.status] = {
            count: 0,
            sendSuccess: 0,
            sendFail: 0,
            // collision and ttlExpired are difficult to infer from Job table alone
            // without specific flags. We initialize at 0.
            collision: 0,
            ttlExpired: 0,
          };
        }
        acc[job.status].count++;

        if (job.status === JobStatus.DONE) {
          acc[job.status].sendSuccess++;
        }
        if (job.status === JobStatus.FAILED) {
          acc[job.status].sendFail++;
        }

        return acc;
      },
      {} as Record<
        JobStatus,
        {
          count: number;
          sendSuccess: number;
          sendFail: number;
          collision: number;
          ttlExpired: number;
        }
      >,
    );

    // Persist in transaction for atomicity and idempotency
    await prisma.$transaction(async (tx) => {
      for (const [status, stats] of Object.entries(statsByStatus)) {
        const jobStatus = status as JobStatus;

        // Idempotency check
        const existing = await tx.jobMetricAggregate.findFirst({
          where: {
            windowStart,
            status: jobStatus,
          },
        });

        if (existing) {
          continue;
        }

        await tx.jobMetricAggregate.create({
          data: {
            windowStart,
            windowEnd,
            status: jobStatus,
            count: stats.count,
            collisionCount: stats.collision,
            ttlExpiredCount: stats.ttlExpired,
            sendSuccessCount: stats.sendSuccess,
            sendFailCount: stats.sendFail,
          },
        });
      }
    });

    const durationMs = Date.now() - startTime;
    logger.info({
      eventType: "METRICS_WINDOW_AGGREGATED",
      windowStart: windowStart.toISOString(),
      jobsCount: jobs.length,
      durationMs,
    });
  },
};
