import { prisma } from "../../src/persistence/prisma.js";
import {
  AggregatorService,
  floorToMinute,
} from "../../src/metrics/aggregator.service.js";
import { JobStatus } from "@prisma/client";

describe("AggregatorService", () => {
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

  it("should aggregate DONE jobs correctly for a specific window", async () => {
    const conv = await prisma.conversation.create({
      data: { providerContact: "agg-test-1" },
    });

    const windowDate = new Date("2026-02-27T10:00:30Z");
    const windowStart = floorToMinute(windowDate);

    // Create a job finished in this window
    await prisma.job.create({
      data: {
        type: "AI_REPLY_REQUESTED",
        conversationId: conv.id,
        status: JobStatus.DONE,
        payload: {},
        idempotencyKey: "k1",
        updatedAt: new Date("2026-02-27T10:00:45Z"),
      },
    });

    // Create a job finished OUTSIDE this window
    await prisma.job.create({
      data: {
        type: "AI_REPLY_REQUESTED",
        conversationId: conv.id,
        status: JobStatus.DONE,
        payload: {},
        idempotencyKey: "k2",
        updatedAt: new Date("2026-02-27T10:01:15Z"),
      },
    });

    await AggregatorService.aggregateWindow(windowDate);

    const aggregates = await prisma.jobMetricAggregate.findMany({
      where: { windowStart },
    });

    expect(aggregates).toHaveLength(1);
    expect(aggregates[0].status).toBe(JobStatus.DONE);
    expect(aggregates[0].count).toBe(1);
    expect(aggregates[0].sendSuccessCount).toBe(1);
  });

  it("should be idempotent if run twice for the same window", async () => {
    const conv = await prisma.conversation.create({
      data: { providerContact: "agg-test-2" },
    });

    const windowDate = new Date("2026-02-27T11:00:00Z");

    await prisma.job.create({
      data: {
        type: "AI_REPLY_REQUESTED",
        conversationId: conv.id,
        status: JobStatus.DONE,
        payload: {},
        idempotencyKey: "k3",
        updatedAt: new Date("2026-02-27T11:00:10Z"),
      },
    });

    // Run first time
    await AggregatorService.aggregateWindow(windowDate);
    // Run second time
    await AggregatorService.aggregateWindow(windowDate);

    const count = await prisma.jobMetricAggregate.count({
      where: {
        windowStart: floorToMinute(windowDate),
        status: JobStatus.DONE,
      },
    });

    expect(count).toBe(1);
  });

  it("should handle empty window gracefully", async () => {
    const windowDate = new Date("2026-02-27T12:00:00Z");
    await AggregatorService.aggregateWindow(windowDate);

    const count = await prisma.jobMetricAggregate.count({
      where: { windowStart: floorToMinute(windowDate) },
    });

    expect(count).toBe(0);
  });
});
