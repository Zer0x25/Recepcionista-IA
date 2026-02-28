import { jest } from "@jest/globals";
import { fastify } from "../../src/server.js";
import { prisma } from "../../src/persistence/prisma.js";
import { setupTestEnv, teardownTestEnv } from "../testUtils.js";
import { AggregatorState } from "../../src/metrics/aggregator.state.js";

// Set longer timeout for integration tests
jest.setTimeout(30000);

describe("Extended Health Endpoint Integration", () => {
  beforeAll(async () => {
    await setupTestEnv();
  });

  afterAll(async () => {
    await teardownTestEnv();
  });

  beforeEach(async () => {
    await prisma.job.deleteMany();
    await prisma.workerHeartbeat.deleteMany();
    await prisma.conversation.deleteMany();

    // Create required conversations for jobs
    await prisma.conversation.createMany({
      data: [
        { id: "conv-1", providerContact: "+123", state: "NEW" },
        { id: "conv-2", providerContact: "+456", state: "NEW" },
        { id: "conv-3", providerContact: "+789", state: "NEW" },
      ],
    });

    // Reset aggregator state
    AggregatorState.update({
      lastRunAt: null,
      lastWindowStart: null,
      lastDurationMs: null,
      lastError: null,
    });
  });

  it("should return ok status and current time", async () => {
    const response = await fastify.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe("ok");
    expect(body.time).toBeDefined();
  });

  it("should include backlog metrics accurately", async () => {
    // Seed some jobs
    const now = new Date();
    await prisma.job.createMany({
      data: [
        {
          id: "job-1",
          type: "AI_REPLY_REQUESTED",
          conversationId: "conv-1",
          status: "PENDING",
          nextRunAt: new Date(now.getTime() - 10000), // Ready
          createdAt: new Date(now.getTime() - 10000), // Aged
          idempotencyKey: "k1",
          payload: {},
        },
        {
          id: "job-2",
          type: "AI_REPLY_REQUESTED",
          conversationId: "conv-2",
          status: "PENDING",
          nextRunAt: new Date(now.getTime() + 10000), // Not ready
          idempotencyKey: "k2",
          payload: {},
        },
        {
          id: "job-3",
          type: "AI_REPLY_REQUESTED",
          conversationId: "conv-3",
          status: "DONE",
          nextRunAt: new Date(now.getTime() - 10000),
          idempotencyKey: "k3",
          payload: {},
        },
      ],
    });

    const response = await fastify.inject({
      method: "GET",
      url: "/health",
    });

    const body = JSON.parse(response.body);
    expect(body.backlog.pendingReady).toBe(1);
    expect(body.backlog.pendingTotal).toBe(2);
    expect(body.backlog.oldestPendingAgeMs).toBeGreaterThan(9000);
  });

  it("should include worker heartbeat data", async () => {
    const lastSeenAt = new Date(Date.now() - 5000);
    await prisma.workerHeartbeat.create({
      data: {
        workerId: "test-worker",
        lastSeenAt,
      },
    });

    const response = await fastify.inject({
      method: "GET",
      url: "/health",
    });

    const body = JSON.parse(response.body);
    expect(body.worker.lastSeenAt).toBe(lastSeenAt.toISOString());
    expect(body.worker.ageMs).toBeGreaterThanOrEqual(5000);
  });

  it("should include aggregator state data", async () => {
    const lastRunAt = new Date();
    const lastWindowStart = new Date(Date.now() - 60000);
    AggregatorState.update({
      lastRunAt,
      lastWindowStart,
      lastDurationMs: 123,
      lastError: "some-error",
    });

    const response = await fastify.inject({
      method: "GET",
      url: "/health",
    });

    const body = JSON.parse(response.body);
    expect(body.aggregator.lastRunAt).toBe(lastRunAt.toISOString());
    expect(body.aggregator.lastWindowStart).toBe(lastWindowStart.toISOString());
    expect(body.aggregator.lastDurationMs).toBe(123);
    expect(body.aggregator.lastError).toBe("some-error");
  });
});
