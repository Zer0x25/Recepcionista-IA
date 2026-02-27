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
    // Uses index on updatedAt (added in Sprint 3.2)
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
      return;
    }

    // Group jobs by status and calculate latency
    const statsByStatus = jobs.reduce(
      (acc, job) => {
        const s = job.status;
        if (!acc[s]) {
          acc[s] = {
            count: 0,
            sendSuccess: 0,
            sendFail: 0,
            collision: 0,
            ttlExpired: 0,
            totalLatencyMs: 0,
            latencyCount: 0,
          };
        }
        acc[s].count++;

        // Latency only for terminal states
        if (s === JobStatus.DONE || s === JobStatus.FAILED) {
          const latency = job.updatedAt.getTime() - job.createdAt.getTime();
          acc[s].totalLatencyMs += latency;
          acc[s].latencyCount++;
        }

        if (s === JobStatus.DONE) {
          acc[s].sendSuccess++;
        }
        if (s === JobStatus.FAILED) {
          acc[s].sendFail++;
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
          totalLatencyMs: number;
          latencyCount: number;
        }
      >,
    );

    let totalAvgLatency: number | null = null;
    let totalLatencyCount = 0;
    let totalLatencySum = 0;

    // Persist in transaction for atomicity and idempotency
    await prisma.$transaction(async (tx) => {
      for (const [status, stats] of Object.entries(statsByStatus)) {
        const jobStatus = status as JobStatus;

        const avgLatency =
          stats.latencyCount > 0
            ? Math.round(stats.totalLatencyMs / stats.latencyCount)
            : null;

        if (avgLatency !== null) {
          totalLatencySum += stats.totalLatencyMs;
          totalLatencyCount += stats.latencyCount;
        }

        // Atomic upsert relying on @@unique([windowStart, status])
        await tx.jobMetricAggregate.upsert({
          where: {
            windowStart_status: {
              windowStart,
              status: jobStatus,
            },
          },
          update: {}, // No overwrite if already exists
          create: {
            windowStart,
            windowEnd,
            status: jobStatus,
            count: stats.count,
            collisionCount: stats.collision,
            ttlExpiredCount: stats.ttlExpired,
            sendSuccessCount: stats.sendSuccess,
            sendFailCount: stats.sendFail,
            avgProcessingLatencyMs: avgLatency,
          },
        });
      }
    });

    if (totalLatencyCount > 0) {
      totalAvgLatency = Math.round(totalLatencySum / totalLatencyCount);
    }

    const durationMs = Date.now() - startTime;
    logger.info({
      eventType: "METRICS_WINDOW_AGGREGATED",
      windowStart: windowStart.toISOString(),
      jobCount: jobs.length,
      avgLatency: totalAvgLatency,
      durationMs,
    });
  },
};
