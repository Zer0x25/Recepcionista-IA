import { prisma } from "../../src/persistence/prisma.js";
import { MetricsService } from "../../src/metrics/metrics.service.js";
import { JobStatus } from "@prisma/client";

describe("MetricsService", () => {
  beforeEach(async () => {
    await prisma.jobMetricAggregate.deleteMany();
    await prisma.job.deleteMany();
    await prisma.message.deleteMany();
    await prisma.stateTransition.deleteMany();
    await prisma.conversation.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe("getBacklogSize", () => {
    it("should return the number of pending jobs", async () => {
      const conv = await prisma.conversation.create({
        data: { providerContact: "test-metrics-1" },
      });

      await prisma.job.createMany({
        data: [
          {
            type: "AI_REPLY_REQUESTED",
            conversationId: conv.id,
            status: JobStatus.PENDING,
            payload: {},
            idempotencyKey: "k1",
          },
          {
            type: "AI_REPLY_REQUESTED",
            conversationId: conv.id,
            status: JobStatus.PENDING,
            payload: {},
            idempotencyKey: "k2",
          },
          {
            type: "AI_REPLY_REQUESTED",
            conversationId: conv.id,
            status: JobStatus.DONE,
            payload: {},
            idempotencyKey: "k3",
          },
        ],
      });

      const size = await MetricsService.getBacklogSize();
      expect(size).toBe(2);
    });
  });

  describe("Aggregates", () => {
    it("should calculate collision rate correctly", async () => {
      await prisma.jobMetricAggregate.create({
        data: {
          windowStart: new Date(),
          windowEnd: new Date(),
          status: JobStatus.DONE,
          count: 100,
          collisionCount: 5,
        },
      });

      const rate = await MetricsService.getRecentCollisionRate();
      expect(rate).toBe(0.05);
    });

    it("should calculate TTL expiry rate correctly", async () => {
      await prisma.jobMetricAggregate.create({
        data: {
          windowStart: new Date(),
          windowEnd: new Date(),
          status: JobStatus.DONE,
          count: 50,
          ttlExpiredCount: 5,
        },
      });

      const rate = await MetricsService.getRecentTTlExpiryRate();
      expect(rate).toBe(0.1);
    });

    it("should calculate send success rate correctly", async () => {
      await prisma.jobMetricAggregate.create({
        data: {
          windowStart: new Date(),
          windowEnd: new Date(),
          status: JobStatus.DONE,
          count: 10,
          sendSuccessCount: 8,
          sendFailCount: 2,
        },
      });

      const rate = await MetricsService.getSendSuccessRate();
      expect(rate).toBe(0.8);
    });

    it("should handle zero totals gracefully", async () => {
      expect(await MetricsService.getRecentCollisionRate()).toBe(0);
      expect(await MetricsService.getRecentTTlExpiryRate()).toBe(0);
      expect(await MetricsService.getSendSuccessRate()).toBe(1); // Default is 100% success
    });
  });
});
