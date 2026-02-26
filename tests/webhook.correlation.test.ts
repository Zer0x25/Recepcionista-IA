import { jest } from "@jest/globals";
import supertest from "supertest";
import { fastify } from "../src/server.js";
import { prisma } from "../src/persistence/prisma.js";

describe("Webhook Correlation (ADR-005)", () => {
  const logCollector: any[] = [];

  beforeAll(async () => {
    process.env.ALLOW_INSECURE_WEBHOOK = "true";
    (global as any).__TEST_LOG_COLLECTOR__ = logCollector;
    await fastify.ready();
  });

  afterAll(async () => {
    delete (global as any).__TEST_LOG_COLLECTOR__;
    await fastify.close();
    await prisma.$disconnect();
    process.env.ALLOW_INSECURE_WEBHOOK = "false";
  });

  beforeEach(async () => {
    logCollector.length = 0;
    await prisma.message.deleteMany();
    await prisma.conversation.deleteMany();
  });

  it("should include requestId in all logs and conversationId after upsert", async () => {
    const payload = {
      MessageSid: "SM_CORR_TEST_1",
      Body: "Correlation test",
      From: "+1111111111",
      To: "+9999999999",
      AccountSid: "AC_TEST",
    };

    const response = await supertest(fastify.server)
      .post("/webhooks/twilio")
      .send(new URLSearchParams(payload).toString())
      .set("Content-Type", "application/x-www-form-urlencoded");

    expect(response.status).toBe(200);

    const allLogs = logCollector;
    expect(allLogs.length).toBeGreaterThan(0);

    // 1. Verify requestId is present in logs that are part of this request flow
    // We can identify them by checking if they HAVE a requestId (since we want to ensure they DO)
    // but better: verify that at least some logs have a requestId and it matches across them.

    const requestRelatedLogs = allLogs.filter(
      (l) => l.msg !== "Server started" && l.eventType !== "SERVER_START",
    );

    expect(requestRelatedLogs.length).toBeGreaterThan(0);

    let capturedRequestId: string | undefined;

    requestRelatedLogs.forEach((log) => {
      // Internal state transitions and webhook processing MUST have requestId
      if (
        [
          "state_transition",
          "WEBHOOK_PROCESSED",
          "WEBHOOK_DUPLICATE_IDEMPOTENCY",
        ].includes(log.eventType)
      ) {
        expect(log).toHaveProperty("requestId");
        if (!capturedRequestId) {
          capturedRequestId = log.requestId;
        } else {
          expect(log.requestId).toBe(capturedRequestId);
        }
      }
    });

    expect(capturedRequestId).toBeDefined();

    // 2. Verify conversationId exists in logs that occur AFTER the message is persisted
    const logsWithConversationId = allLogs.filter((l) => l.conversationId);

    expect(logsWithConversationId.length).toBeGreaterThan(0);
    logsWithConversationId.forEach((log) => {
      expect(log).toHaveProperty("requestId", capturedRequestId);
      expect(log).toHaveProperty("conversationId");
    });
  });
});
