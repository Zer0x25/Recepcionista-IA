import { jest } from "@jest/globals";
import { fastify } from "../../src/server.js";
import { prisma } from "../../src/persistence/prisma.js";
import { JobStatus } from "@prisma/client";

describe("Admin Metrics Endpoints", () => {
  const adminKey = "test-admin-key";

  beforeAll(async () => {
    process.env.ADMIN_API_KEY = adminKey;
    await fastify.ready();
  });

  beforeEach(async () => {
    await prisma.job.deleteMany();
    await prisma.workerHeartbeat.deleteMany();
    await prisma.jobMetricAggregate.deleteMany();
    await prisma.message.deleteMany();
    await prisma.stateTransition.deleteMany();
    await prisma.conversation.deleteMany();
  });

  afterAll(async () => {
    await fastify.close();
    await prisma.$disconnect();
  });

  describe("GET /admin/metrics/summary", () => {
    it("should return 401 if unauthorized", async () => {
      const response = await fastify.inject({
        method: "GET",
        url: "/admin/metrics/summary",
      });
      expect(response.statusCode).toBe(401);
    });

    it("should return metrics summary when authorized", async () => {
      const response = await fastify.inject({
        method: "GET",
        url: "/admin/metrics/summary",
        headers: {
          "x-admin-key": adminKey,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty("backlogSize");
      expect(body).toHaveProperty("collisionRate");
      expect(body).toHaveProperty("ttlExpiryRate");
      expect(body).toHaveProperty("sendSuccessRate");
    });
  });

  describe("GET /admin/jobs/backlog", () => {
    it("should return job counts by status", async () => {
      const conv = await prisma.conversation.create({
        data: { providerContact: "test-backlog-1" },
      });

      await prisma.job.create({
        data: {
          type: "AI_REPLY_REQUESTED",
          conversationId: conv.id,
          status: JobStatus.PENDING,
          payload: {},
          idempotencyKey: "k1",
        },
      });

      const response = await fastify.inject({
        method: "GET",
        url: "/admin/jobs/backlog",
        headers: {
          "x-admin-key": adminKey,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body[JobStatus.PENDING]).toBe(1);
    });
  });

  describe("GET /admin/worker/heartbeat", () => {
    it("should return worker heartbeats", async () => {
      await prisma.workerHeartbeat.create({
        data: {
          workerId: "worker-1",
          lastSeenAt: new Date(),
          claimedCount: 5,
        },
      });

      const response = await fastify.inject({
        method: "GET",
        url: "/admin/worker/heartbeat",
        headers: {
          "x-admin-key": adminKey,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveLength(1);
      expect(body[0].workerId).toBe("worker-1");
    });
  });
});
