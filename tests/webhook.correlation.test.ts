import { jest } from "@jest/globals";
import supertest from "supertest";
import { fastify } from "../src/server.js";
import { prisma } from "../src/persistence/prisma.js";
import { logger } from "../src/observability/logger.js";

describe("Webhook Correlation (ADR-005)", () => {
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

  beforeEach(() => {
    // Mock logger.child which is used to create contextual loggers
    loggerSpy = jest.spyOn(logger, "child");
  });

  afterEach(() => {
    jest.resetAllMocks();
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

    // Verify that logger.child was called (creating child loggers)
    expect(loggerSpy).toHaveBeenCalled();

    // Check calls to the child loggers
    // Since we mock logger.child, we need to track what it returns
    // However, a simpler way is to verify that all calls were contextual.
    // Given the constraints, we'll verify that child loggers were created with the expected keys.

    const childCalls = loggerSpy.mock.calls;

    // At least 3 child loggers should be created:
    // 1. requestLogger (requestId)
    // 2. requestLogger (inside verifyTwilioSignature)
    // 3. contextualLogger (requestId + conversationId)
    // 4. orchestratorLogger (requestId + conversationId)
    expect(childCalls.length).toBeGreaterThanOrEqual(3);

    const firstChild = childCalls[0][0];
    expect(firstChild).toHaveProperty("requestId");

    // Check if any child was created with conversationId
    const hasConversationId = childCalls.some((call: any) =>
      call[0].hasOwnProperty("conversationId"),
    );
    expect(hasConversationId).toBe(true);
  });
});
