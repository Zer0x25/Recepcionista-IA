import { prisma } from "../../src/persistence/prisma.js";
import {
  AggregatorService,
  floorToMinute,
} from "../../src/metrics/aggregator.service.js";
import { JobStatus, OperationalEventType } from "@prisma/client";
import { recordOperationalEvent } from "../../src/metrics/events.repository.js";

async function cleanDb() {
  await prisma.operationalEvent.deleteMany();
  await prisma.jobMetricAggregate.deleteMany();
  await prisma.job.deleteMany();
  await prisma.message.deleteMany();
  await prisma.stateTransition.deleteMany();
  await prisma.conversation.deleteMany();
}

describe("Operational Events Aggregation", () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("should aggregate operational events into correct status buckets", async () => {
    const windowDate = new Date("2026-02-27T15:00:30Z");
    const windowStart = floorToMinute(windowDate);

    // 1. Record events in window
    await prisma.operationalEvent.createMany({
      data: [
        { type: OperationalEventType.CLAIM_COLLISION, createdAt: windowDate },
        { type: OperationalEventType.CAS_COLLISION, createdAt: windowDate },
        { type: OperationalEventType.TTL_EXPIRED, createdAt: windowDate },
        { type: OperationalEventType.SEND_SUCCESS, createdAt: windowDate },
        { type: OperationalEventType.SEND_SUCCESS, createdAt: windowDate },
        { type: OperationalEventType.SEND_FAIL, createdAt: windowDate },
      ],
    });

    // 2. Aggregate
    await AggregatorService.aggregateWindow(windowDate);

    // 3. Verify DONE row (SEND_SUCCESS)
    const aggDone = await prisma.jobMetricAggregate.findUnique({
      where: { windowStart_status: { windowStart, status: JobStatus.DONE } },
    });
    expect(aggDone?.sendSuccessCount).toBe(2);
    expect(aggDone?.sendFailCount).toBe(0);

    // 4. Verify FAILED row (SEND_FAIL)
    const aggFailed = await prisma.jobMetricAggregate.findUnique({
      where: { windowStart_status: { windowStart, status: JobStatus.FAILED } },
    });
    expect(aggFailed?.sendFailCount).toBe(1);

    // 5. Verify PENDING row (COLLISIONS + TTL)
    const aggPending = await prisma.jobMetricAggregate.findUnique({
      where: { windowStart_status: { windowStart, status: JobStatus.PENDING } },
    });
    expect(aggPending?.collisionCount).toBe(2); // CLAIM + CAS
    expect(aggPending?.ttlExpiredCount).toBe(1);
  });

  it("should ignore events outside the window", async () => {
    const windowDate = new Date("2026-02-27T16:00:30Z");
    const windowStart = floorToMinute(windowDate);

    const pastDate = new Date(windowStart.getTime() - 1); // 1ms before window
    const futureDate = new Date(windowStart.getTime() + 60_000); // end of window

    await prisma.operationalEvent.createMany({
      data: [
        { type: OperationalEventType.SEND_SUCCESS, createdAt: pastDate },
        { type: OperationalEventType.SEND_SUCCESS, createdAt: windowDate },
        { type: OperationalEventType.SEND_SUCCESS, createdAt: futureDate },
      ],
    });

    await AggregatorService.aggregateWindow(windowDate);

    const aggDone = await prisma.jobMetricAggregate.findUnique({
      where: { windowStart_status: { windowStart, status: JobStatus.DONE } },
    });
    expect(aggDone?.sendSuccessCount).toBe(1);
  });

  it("should update counts on re-aggregation (idempotency)", async () => {
    const windowDate = new Date("2026-02-27T17:00:00Z");
    const windowStart = floorToMinute(windowDate);

    // First aggregation
    await prisma.operationalEvent.create({
      data: { type: OperationalEventType.SEND_SUCCESS, createdAt: windowDate },
    });
    await AggregatorService.aggregateWindow(windowDate);

    let agg = await prisma.jobMetricAggregate.findUniqueOrThrow({
      where: { windowStart_status: { windowStart, status: JobStatus.DONE } },
    });
    expect(agg.sendSuccessCount).toBe(1);

    // Second event and re-aggregate
    await prisma.operationalEvent.create({
      data: { type: OperationalEventType.SEND_SUCCESS, createdAt: windowDate },
    });
    await AggregatorService.aggregateWindow(windowDate);

    agg = await prisma.jobMetricAggregate.findUniqueOrThrow({
      where: { windowStart_status: { windowStart, status: JobStatus.DONE } },
    });
    expect(agg.sendSuccessCount).toBe(2);
  });
});
