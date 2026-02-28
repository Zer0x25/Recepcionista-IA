import supertest from "supertest";
import { fastify } from "../src/server.js";
import { prisma } from "../src/persistence/prisma.js";
import { jest } from "@jest/globals";
import { logger } from "../src/observability/logger.js";
import { makeTestLogger } from "./testUtils.js";

describe("Webhook Logging Sanitization", () => {
  let capturedLogs: any[] = [];
  let loggerSpy: any;
  let originalNodeEnv: string | undefined;

  beforeAll(async () => {
    process.env.ALLOW_INSECURE_WEBHOOK = "true";
    await fastify.ready();
  });

  afterAll(async () => {
    await fastify.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    originalNodeEnv = process.env.NODE_ENV;
    await prisma.job.deleteMany();
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
    process.env.NODE_ENV = originalNodeEnv;
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

    const receivedLog = capturedLogs.find((l) => l.eventType === "WEBHOOK_RECEIVED");
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

  it("should redact PII in debug log if LOG_WEBHOOK_PAYLOAD is true and in development", async () => {
    process.env.LOG_WEBHOOK_PAYLOAD = "true";
    process.env.NODE_ENV = "development";

    const payload = {
      MessageSid: "SM_DEBUG_TEST",
      Body: "Secret message",
      From: "+1111111111",
      To: "+9999999999",
      AccountSid: "AC_TEST",
      MediaUrl0: "https://example.com/image.png",
    };

    await supertest(fastify.server)
      .post("/webhooks/twilio")
      .send(new URLSearchParams(payload).toString())
      .set("Content-Type", "application/x-www-form-urlencoded");

    const debugLog = capturedLogs.find((l) => l.eventType === "WEBHOOK_PAYLOAD_DEBUG");
    expect(debugLog).toBeDefined();
    expect(debugLog.payload).toBeDefined();
    expect(debugLog.payload.MessageSid).toBe("SM_DEBUG_TEST");
    expect(debugLog.payload.From).toBe("...1111");
    expect(debugLog.payload.Body).toBe("[redacted] (len: 14)");
    expect(debugLog.payload.MediaUrl0).toBe("[redacted]");
  });

  it("should NOT log debug payload when NODE_ENV is test", async () => {
    process.env.LOG_WEBHOOK_PAYLOAD = "true";
    process.env.NODE_ENV = "test";

    const payload = {
      MessageSid: "SM_DEBUG_TEST_TEST",
      Body: "Test message",
      From: "+1111111111",
      To: "+9999999999",
      AccountSid: "AC_TEST",
    };

    await supertest(fastify.server)
      .post("/webhooks/twilio")
      .send(new URLSearchParams(payload).toString())
      .set("Content-Type", "application/x-www-form-urlencoded");

    const debugLog = capturedLogs.find((l) => l.eventType === "WEBHOOK_PAYLOAD_DEBUG");
    expect(debugLog).toBeUndefined();
  });

  it("should NOT include payload in WEBHOOK_VALIDATION_FAILED log", async () => {
    // Missing MessageSid to trigger validation failure
    const payload = {
      Body: "Incomplete payload",
      From: "+1111111111",
      To: "+9999999999",
      AccountSid: "AC_TEST",
    };

    const response = await supertest(fastify.server)
      .post("/webhooks/twilio")
      .send(new URLSearchParams(payload as any).toString())
      .set("Content-Type", "application/x-www-form-urlencoded");

    expect(response.status).toBe(400);

    const validationFailedLog = capturedLogs.find(
      (l) => l.eventType === "WEBHOOK_VALIDATION_FAILED",
    );
    expect(validationFailedLog).toBeDefined();
    expect(validationFailedLog.payload).toBeUndefined();
    expect(validationFailedLog.errors).toBeDefined();
    expect(validationFailedLog.fromLast4).toBe("1111");
  });
});
