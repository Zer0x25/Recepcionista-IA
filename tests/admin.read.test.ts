import { jest } from "@jest/globals";
import supertest from "supertest";
import { fastify } from "../src/server.js";
import { prisma } from "../src/persistence/prisma.js";
import { State } from "@prisma/client";
import { logger } from "../src/observability/logger.js";
import { makeTestLogger } from "./testUtils.js";

describe("Admin Read API (Debug)", () => {
  const ADMIN_KEY = "test-admin-key";
  const fromNumber = "+1234567890";

  let capturedLogs: any[] = [];
  let loggerSpy: any;

  beforeAll(async () => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    await fastify.ready();
  });

  beforeEach(async () => {
    await prisma.stateTransition.deleteMany();
    await prisma.message.deleteMany();
    await prisma.conversation.deleteMany();

    capturedLogs.length = 0;
    const { loggerFake, getLogs } = makeTestLogger();
    capturedLogs = getLogs();

    loggerSpy = jest.spyOn(logger, "child").mockImplementation((context) => {
      return loggerFake.child(context);
    });
  });

  afterEach(() => {
    if (loggerSpy) {
      loggerSpy.mockRestore();
    }
  });

  afterAll(async () => {
    await fastify.close();
    await prisma.$disconnect();
  });

  const setupMockData = async () => {
    const conversation = await prisma.conversation.create({
      data: {
        providerContact: fromNumber,
        state: State.ANSWERING,
      },
    });

    await prisma.message.createMany({
      data: [
        {
          conversationId: conversation.id,
          providerMessageId: "MSG_1",
          direction: "INBOUND",
          content: "Hello",
          createdAt: new Date(Date.now() - 1000),
        },
        {
          conversationId: conversation.id,
          providerMessageId: "MSG_2",
          direction: "OUTBOUND",
          content: "Hi there",
          createdAt: new Date(),
        },
      ],
    });

    await prisma.stateTransition.create({
      data: {
        conversationId: conversation.id,
        fromState: State.NEW,
        toState: State.CLASSIFYING,
        triggeredBy: "MSG_1",
      },
    });

    return conversation;
  };

  describe("GET /admin/conversations/:id", () => {
    it("should return 401 if x-admin-key is missing", async () => {
      const resp = await supertest(fastify.server).get(
        "/admin/conversations/00000000-0000-0000-0000-000000000000",
      );
      expect(resp.status).toBe(401);
    });

    it("should return 401 if x-admin-key is incorrect", async () => {
      const resp = await supertest(fastify.server)
        .get("/admin/conversations/00000000-0000-0000-0000-000000000000")
        .set("x-admin-key", "wrong-key");
      expect(resp.status).toBe(401);

      const log = capturedLogs.find(
        (l) => l.eventType === "ADMIN_READ_UNAUTHORIZED",
      );
      expect(log).toBeDefined();
      expect(log.requestId).toBeDefined();
      expect(log.scope).toBe("admin");
    });

    it("should return 400 if id is not a UUID", async () => {
      const resp = await supertest(fastify.server)
        .get("/admin/conversations/not-a-uuid")
        .set("x-admin-key", ADMIN_KEY);
      expect(resp.status).toBe(400);

      const log = capturedLogs.find(
        (l) => l.eventType === "ADMIN_READ_INVALID_PARAMS",
      );
      expect(log).toBeDefined();
      expect(log.durationMs).toBeDefined();
    });

    it("should return 404 if conversation does not exist", async () => {
      const id = "00000000-0000-0000-0000-000000000000";
      const resp = await supertest(fastify.server)
        .get(`/admin/conversations/${id}`)
        .set("x-admin-key", ADMIN_KEY);
      expect(resp.status).toBe(404);

      const log = capturedLogs.find(
        (l) => l.eventType === "ADMIN_READ_NOT_FOUND",
      );
      expect(log).toBeDefined();
      expect(log.conversationId).toBe(id);
      expect(log.durationMs).toBeDefined();
    });

    it("should return the conversation snapshot if authorized and exists", async () => {
      const conversation = await setupMockData();
      const resp = await supertest(fastify.server)
        .get(`/admin/conversations/${conversation.id}`)
        .set("x-admin-key", ADMIN_KEY);

      expect(resp.status).toBe(200);
      expect(resp.body).toMatchObject({
        id: conversation.id,
        providerContact: fromNumber,
        state: State.ANSWERING,
      });
      expect(resp.body.messages.length).toBe(2);
      expect(resp.body.transitions.length).toBe(1);

      const log = capturedLogs.find(
        (l) => l.eventType === "ADMIN_READ_SUCCESS",
      );
      expect(log).toBeDefined();
      expect(log.conversationId).toBe(conversation.id);
      expect(log.durationMs).toBeDefined();
      expect(log.requestId).toBeDefined();
    });

    it("should respect limitMessages query param", async () => {
      const conversation = await setupMockData();
      const resp = await supertest(fastify.server)
        .get(`/admin/conversations/${conversation.id}?limitMessages=1`)
        .set("x-admin-key", ADMIN_KEY);

      expect(resp.status).toBe(200);
      expect(resp.body.messages.length).toBe(1);
      // Order should be desc by createdAt
      expect(resp.body.messages[0].providerMessageId).toBe("MSG_2");
    });

    it("should use default limitMessages if not provided", async () => {
      const conversation = await setupMockData();
      const resp = await supertest(fastify.server)
        .get(`/admin/conversations/${conversation.id}`)
        .set("x-admin-key", ADMIN_KEY);

      expect(resp.status).toBe(200);
      expect(resp.body.messages.length).toBe(2);
    });
  });

  describe("GET /admin/conversations/by-contact/:providerContact", () => {
    it("should return 404 if contact does not exist", async () => {
      const resp = await supertest(fastify.server)
        .get("/admin/conversations/by-contact/+9999999999")
        .set("x-admin-key", ADMIN_KEY);
      expect(resp.status).toBe(404);
    });

    it("should return the conversation snapshot by contact", async () => {
      const conversation = await setupMockData();
      const resp = await supertest(fastify.server)
        .get(
          `/admin/conversations/by-contact/${encodeURIComponent(fromNumber)}`,
        )
        .set("x-admin-key", ADMIN_KEY);

      expect(resp.status).toBe(200);
      expect(resp.body.id).toBe(conversation.id);
    });

    it("should use default limitMessages if not provided", async () => {
      await setupMockData();
      const resp = await supertest(fastify.server)
        .get(
          `/admin/conversations/by-contact/${encodeURIComponent(fromNumber)}`,
        )
        .set("x-admin-key", ADMIN_KEY);

      expect(resp.status).toBe(200);
      expect(resp.body.messages.length).toBe(2);
    });
  });
});
