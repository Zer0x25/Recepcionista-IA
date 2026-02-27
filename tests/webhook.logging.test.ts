import { jest } from "@jest/globals";
import supertest from "supertest";
import { fastify } from "../src/server.js";
import { prisma } from "../src/persistence/prisma.js";
import { logger } from "../src/observability/logger.js";
import { makeTestLogger } from "./testUtils.js";

describe("Webhook Logging Sanitization", () => {
  let capturedLogs: any[] = [];
  let loggerSpy: any;

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

    loggerSpy = jest.spyOn(logger, "child").mockImplementation((context) => {
      return loggerFake.child(context);
    });
  });

  afterEach(() => {
    loggerSpy.mockRestore();
    delete process.env.LOG_WEBHOOK_PAYLOAD;
  });

  it("should sanitize WEBHOOK_RECEIVED log and include safeFields", async () => {
    const payload = {
      MessageSid: "SM_LOG_TEST_1",
      Body: "Hello world",
      From: "+541122334455",
      To: "+9999999999",
      AccountSid: "AC_TEST",
      NumMedia: "2",
    };

    await supertest(fastify.server)
      .post("/webhooks/twilio")
      .send(new URLSearchParams(payload).toString())
      .set("Content-Type", "application/x-www-form-urlencoded");

    const receivedLog = capturedLogs.find(
      (l) => l.eventType === "WEBHOOK_RECEIVED",
    );
    expect(receivedLog).toBeDefined();

    // Verify sanitization
    expect(receivedLog.payload).toBeUndefined();

    // Verify safeFields
    expect(receivedLog.providerMessageId).toBe("SM_LOG_TEST_1");
    expect(receivedLog.hasFrom).toBe(true);
    expect(receivedLog.fromLast4).toBe("4455");
    expect(receivedLog.bodyLength).toBe(11);
    expect(receivedLog.numMedia).toBe(2);
    expect(receivedLog.path).toBe("/webhooks/twilio");
    expect(receivedLog.hasSignatureHeader).toBe(false); // Insecure mode in tests
  });

  it("should log full payload if LOG_WEBHOOK_PAYLOAD is true and not in production", async () => {
    process.env.LOG_WEBHOOK_PAYLOAD = "true";
    process.env.NODE_ENV = "development";

    const payload = {
      MessageSid: "SM_DEBUG_TEST",
      Body: "Secret message",
      From: "+1111111111",
      To: "+9999999999",
      AccountSid: "AC_TEST",
    };

    await supertest(fastify.server)
      .post("/webhooks/twilio")
      .send(new URLSearchParams(payload).toString())
      .set("Content-Type", "application/x-www-form-urlencoded");

    const debugLog = capturedLogs.find(
      (l) => l.eventType === "WEBHOOK_PAYLOAD_DEBUG",
    );
    expect(debugLog).toBeDefined();
    expect(debugLog.payload).toBeDefined();
    expect(debugLog.payload.MessageSid).toBe("SM_DEBUG_TEST");

    // Cleanup env
    process.env.NODE_ENV = "test";
  });
});
