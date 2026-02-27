import { prisma } from "../../src/persistence/prisma.js";
import {
  AggregatorService,
  floorToMinute,
} from "../../src/metrics/aggregator.service.js";
import { JobStatus } from "@prisma/client";

describe("AggregatorService Hardening", () => {
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

  it("should compute avg latency correctly for DONE and FAILED jobs", async () => {
    const conv = await prisma.conversation.create({
      data: { providerContact: "latency-test" },
    });

    const windowDate = new Date("2026-02-27T10:00:30Z");
    const windowStart = floorToMinute(windowDate);

    // Job 1: DONE, latency 10s
    await prisma.job.create({
      data: {
        type: "AI_REPLY_REQUESTED",
        conversationId: conv.id,
        status: JobStatus.DONE,
        payload: {},
        idempotencyKey: "l1",
        createdAt: new Date("2026-02-27T10:00:00Z"),
        updatedAt: new Date("2026-02-27T10:00:10Z"),
      },
    });

    // Job 2: FAILED, latency 20s
    await prisma.job.create({
      data: {
        type: "AI_REPLY_REQUESTED",
        conversationId: conv.id,
        status: JobStatus.FAILED,
        payload: {},
        idempotencyKey: "l2",
        createdAt: new Date("2026-02-27T10:00:00Z"),
        updatedAt: new Date("2026-02-27T10:00:20Z"),
      },
    });

    await AggregatorService.aggregateWindow(windowDate);

    const aggDone = await prisma.jobMetricAggregate.findUnique({
      where: { windowStart_status: { windowStart, status: JobStatus.DONE } },
    });
    const aggFailed = await prisma.jobMetricAggregate.findUnique({
      where: { windowStart_status: { windowStart, status: JobStatus.FAILED } },
    });

    expect(aggDone?.avgProcessingLatencyMs).toBe(10000);
    expect(aggFailed?.avgProcessingLatencyMs).toBe(20000);
  });

  it("should not duplicate under simulated concurrent calls (atomic upsert)", async () => {
    const conv = await prisma.conversation.create({
      data: { providerContact: "concurrency-test" },
    });

    const windowDate = new Date("2026-02-27T11:00:00Z");

    await prisma.job.create({
      data: {
        type: "AI_REPLY_REQUESTED",
        conversationId: conv.id,
        status: JobStatus.DONE,
        payload: {},
        idempotencyKey: "c1",
        updatedAt: new Date("2026-02-27T11:00:10Z"),
      },
    });

    // Run multiple aggregations in parallel
    await Promise.all([
      AggregatorService.aggregateWindow(windowDate),
      AggregatorService.aggregateWindow(windowDate),
      AggregatorService.aggregateWindow(windowDate),
    ]);

    const count = await prisma.jobMetricAggregate.count({
      where: {
        windowStart: floorToMinute(windowDate),
        status: JobStatus.DONE,
      },
    });

    expect(count).toBe(1);
  });

  it("should handle mixed statuses and null latency for non-terminal jobs", async () => {
    const conv = await prisma.conversation.create({
      data: { providerContact: "mixed-test" },
    });

    const windowDate = new Date("2026-02-27T12:00:00Z");
    const windowStart = floorToMinute(windowDate);

    // Job PENDING (not terminal)
    await prisma.job.create({
      data: {
        type: "AI_REPLY_REQUESTED",
        conversationId: conv.id,
        status: JobStatus.PENDING,
        payload: {},
        idempotencyKey: "m1",
        updatedAt: new Date("2026-02-27T12:00:05Z"),
      },
    });

    await AggregatorService.aggregateWindow(windowDate);

    const aggPending = await prisma.jobMetricAggregate.findUnique({
      where: { windowStart_status: { windowStart, status: JobStatus.PENDING } },
    });

    expect(aggPending?.count).toBe(1);
    expect(aggPending?.avgProcessingLatencyMs).toBeNull();
  });
});
