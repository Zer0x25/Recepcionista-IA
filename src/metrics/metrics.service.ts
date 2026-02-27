import { prisma } from "../persistence/prisma.js";
import { JobStatus } from "@prisma/client";

/**
 * Service to query operational metrics directly from the database.
 */
export const MetricsService = {
  /**
   * Returns the count of jobs in PENDING status.
   */
  async getBacklogSize(): Promise<number> {
    return prisma.job.count({
      where: {
        status: JobStatus.PENDING,
      },
    });
  },

  /**
   * Returns job counts grouped by status.
   */
  async getJobsByStatus(): Promise<Record<JobStatus, number>> {
    const counts = await prisma.job.groupBy({
      by: ["status"],
      _count: {
        _all: true,
      },
    });

    const result: Record<JobStatus, number> = {
      [JobStatus.PENDING]: 0,
      [JobStatus.PROCESSING]: 0,
      [JobStatus.DONE]: 0,
      [JobStatus.FAILED]: 0,
    };

    counts.forEach((c) => {
      result[c.status] = c._count._all;
    });

    return result;
  },

  /**
   * Returns the collision rate from the last 24 hours of aggregates.
   */
  async getRecentCollisionRate(): Promise<number> {
    const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const aggregates = await prisma.jobMetricAggregate.aggregate({
      where: {
        windowStart: { gte: last24h },
      },
      _sum: {
        count: true,
        collisionCount: true,
      },
    });

    const total = aggregates._sum.count || 0;
    const collisions = aggregates._sum.collisionCount || 0;

    if (total === 0) return 0;
    return collisions / total;
  },

  /**
   * Returns the TTL expiry rate from the last 24 hours of aggregates.
   */
  async getRecentTTlExpiryRate(): Promise<number> {
    const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const aggregates = await prisma.jobMetricAggregate.aggregate({
      where: {
        windowStart: { gte: last24h },
      },
      _sum: {
        count: true,
        ttlExpiredCount: true,
      },
    });

    const total = aggregates._sum.count || 0;
    const expired = aggregates._sum.ttlExpiredCount || 0;

    if (total === 0) return 0;
    return expired / total;
  },

  /**
   * Returns the send success rate (success / (success + fail)) from the last 24 hours.
   */
  async getSendSuccessRate(): Promise<number> {
    const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const aggregates = await prisma.jobMetricAggregate.aggregate({
      where: {
        windowStart: { gte: last24h },
      },
      _sum: {
        sendSuccessCount: true,
        sendFailCount: true,
      },
    });

    const success = aggregates._sum.sendSuccessCount || 0;
    const fail = aggregates._sum.sendFailCount || 0;

    const total = success + fail;
    if (total === 0) return 1; // Default to 100% if no data
    return success / total;
  },
};
