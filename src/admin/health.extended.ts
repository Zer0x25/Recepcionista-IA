import { FastifyInstance } from "fastify";
import { prisma } from "../persistence/prisma.js";
import { AggregatorState } from "../metrics/aggregator.state.js";
import { logger } from "../observability/logger.js";

export async function healthExtendedRoutes(fastify: FastifyInstance) {
  fastify.get("/health", async (_request, _reply) => {
    const start = Date.now();

    const [pendingReadyCount, pendingTotalCount, oldestPending] = await Promise.all([
      // backlog: query Job where status=PENDING and nextRunAt<=now
      prisma.job.count({
        where: {
          status: "PENDING",
          nextRunAt: { lte: new Date() },
        },
      }),
      // pendingTotal: Job where status=PENDING
      prisma.job.count({
        where: {
          status: "PENDING",
        },
      }),
      // oldestPendingAgeMs: min(createdAt) among pending ready (or null)
      prisma.job.findFirst({
        where: {
          status: "PENDING",
          nextRunAt: { lte: new Date() },
        },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      }),
    ]);

    const workerLastSeen = await prisma.workerHeartbeat.findFirst({
      orderBy: { lastSeenAt: "desc" },
    });

    const aggregatorState = AggregatorState.getState();

    const now = new Date();
    const oldestPendingAgeMs = oldestPending
      ? now.getTime() - oldestPending.createdAt.getTime()
      : null;

    const workerLastSeenAt = workerLastSeen?.lastSeenAt ?? null;
    const workerAgeMs = workerLastSeenAt ? now.getTime() - workerLastSeenAt.getTime() : null;

    const response = {
      status: "ok",
      time: now.toISOString(),
      backlog: {
        pendingReady: pendingReadyCount,
        pendingTotal: pendingTotalCount,
        oldestPendingAgeMs,
      },
      worker: {
        lastSeenAt: workerLastSeenAt ? workerLastSeenAt.toISOString() : null,
        ageMs: workerAgeMs,
      },
      aggregator: {
        lastRunAt: aggregatorState.lastRunAt ? aggregatorState.lastRunAt.toISOString() : null,
        lastWindowStart: aggregatorState.lastWindowStart
          ? aggregatorState.lastWindowStart.toISOString()
          : null,
        lastDurationMs: aggregatorState.lastDurationMs,
        lastError: aggregatorState.lastError,
      },
    };

    const durationMs = Date.now() - start;
    logger.info({
      eventType: "HEALTH_EXTENDED",
      durationMs,
    });

    return response;
  });
}
