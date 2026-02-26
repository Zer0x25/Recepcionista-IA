import { jest } from "@jest/globals";
import supertest from "supertest";
import { fastify } from "../src/server.js";
import { prisma } from "../src/persistence/prisma.js";
import { logger } from "../src/observability/logger.js";
import { makeTestLogger } from "./testUtils.js";

describe("Webhook Correlation (ADR-005)", () => {
  let capturedLogs: any[] = [];

  beforeAll(async () => {
    process.env.ALLOW_INSECURE_WEBHOOK = "true";
    await fastify.ready();
  });

  afterAll(async () => {
    await fastify.close();
    await prisma.$disconnect();
    process.env.ALLOW_INSECURE_WEBHOOK = "false";
  });

  beforeEach(async () => {
    await prisma.stateTransition.deleteMany();
    await prisma.message.deleteMany();
    await prisma.conversation.deleteMany();

    const { loggerFake, getLogs } = makeTestLogger();
    capturedLogs = getLogs();

    // Mock logger.child to use our fake logger's child method
    // This ensures that when we call logger.child({requestId}), it returns a fake logger
    // and when we call THAT logger.child({conversationId}), it also returns a fake logger.
    jest.spyOn(logger, "child").mockImplementation((context) => {
      return loggerFake.child(context);
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
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

    const allLogs = capturedLogs;
    expect(allLogs.length).toBeGreaterThan(0);

    // Filter logs that are part of the flow
    // (Identifying them by eventType presence usually indicates our instrumented logs)
    // Filter logs that are part of the flow
    // (Identifying them by eventType presence usually indicates our instrumented logs)
    const flowLogs = allLogs.filter(
      (l) => l.eventType || l.msg === "Processing message in orchestrator",
    );

    expect(flowLogs.length).toBeGreaterThan(0);

    // A) Capture the first requestId found in the flow logs
    const logWithRequestId = flowLogs.find((l) => l.requestId);
    const capturedRequestId = logWithRequestId?.requestId;

    expect(capturedRequestId).toBeDefined();
    expect(typeof capturedRequestId).toBe("string");

    flowLogs.forEach((log) => {
      // Every log in the flow must have the requestId
      expect(log).toHaveProperty("requestId", capturedRequestId);
    });

    // B) Ensure logs with conversationId also have requestId
    const logsWithConversationId = flowLogs.filter((l) => l.conversationId);
    expect(logsWithConversationId.length).toBeGreaterThan(0);

    logsWithConversationId.forEach((log) => {
      expect(log).toHaveProperty("requestId", capturedRequestId);
      expect(log).toHaveProperty("conversationId");
      expect(typeof log.conversationId).toBe("string");
    });

    // C) Verify consistency - specific check for important eventTypes
    const eventTypesFound = flowLogs.map((l) => l.eventType).filter(Boolean);
    expect(eventTypesFound).toContain("state_transition");
    expect(eventTypesFound).toContain("WEBHOOK_PROCESSED");
  });
});
