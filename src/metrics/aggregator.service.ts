import { prisma } from "../persistence/prisma.js";
import { JobStatus, OperationalEventType } from "@prisma/client";
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

    // 1. Query jobs updated in this window (for status counts and latency)
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

    // 2. Query operational events in this window
    const events = await prisma.operationalEvent.groupBy({
      by: ["type"],
      where: {
        createdAt: {
          gte: windowStart,
          lt: windowEnd,
        },
      },
      _count: true,
    });

    if (jobs.length === 0 && events.length === 0) {
      return;
    }

    const eventCounts = events.reduce(
      (acc, e) => {
        acc[e.type] = e._count;
        return acc;
      },
      {} as Record<OperationalEventType, number>,
    );

    // 3. Group jobs by status and calculate latency
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

    // 4. Distribute operational events into status buckets
    // Mapping:
    // - SEND_SUCCESS -> DONE
    // - SEND_FAIL -> FAILED
    // - CLAIM_COLLISION + CAS_COLLISION -> PENDING (as they represent retryable friction)
    // - TTL_EXPIRED -> PENDING (as it reverts to PENDING)

    const ensureStatus = (s: JobStatus) => {
      if (!statsByStatus[s]) {
        statsByStatus[s] = {
          count: 0,
          sendSuccess: 0,
          sendFail: 0,
          collision: 0,
          ttlExpired: 0,
          totalLatencyMs: 0,
          latencyCount: 0,
        };
      }
    };

    if (eventCounts.SEND_SUCCESS) {
      ensureStatus(JobStatus.DONE);
      statsByStatus[JobStatus.DONE].sendSuccess = eventCounts.SEND_SUCCESS;
    }
    if (eventCounts.SEND_FAIL) {
      ensureStatus(JobStatus.FAILED);
      statsByStatus[JobStatus.FAILED].sendFail = eventCounts.SEND_FAIL;
    }

    const collisions = (eventCounts.CLAIM_COLLISION || 0) + (eventCounts.CAS_COLLISION || 0);
    if (collisions > 0 || eventCounts.TTL_EXPIRED) {
      ensureStatus(JobStatus.PENDING);
      statsByStatus[JobStatus.PENDING].collision = collisions;
      statsByStatus[JobStatus.PENDING].ttlExpired = eventCounts.TTL_EXPIRED || 0;
    }

    let totalAvgLatency: number | null = null;
    let totalLatencyCount = 0;
    let totalLatencySum = 0;

    // 5. Persist in transaction for atomicity and idempotency
    await prisma.$transaction(async (tx) => {
      for (const [status, stats] of Object.entries(statsByStatus)) {
        const jobStatus = status as JobStatus;

        const avgLatency =
          stats.latencyCount > 0 ? Math.round(stats.totalLatencyMs / stats.latencyCount) : null;

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
          update: {
            // Overwrite counts if we are re-aggregating the same window
            count: stats.count,
            collisionCount: stats.collision,
            ttlExpiredCount: stats.ttlExpired,
            sendSuccessCount: stats.sendSuccess,
            sendFailCount: stats.sendFail,
            avgProcessingLatencyMs: avgLatency,
          },
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
      eventCount: events.length,
      avgLatency: totalAvgLatency,
      durationMs,
    });
  },
};
