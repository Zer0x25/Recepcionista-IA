import { jest } from "@jest/globals";
import supertest from "supertest";
import { fastify } from "../src/server.js";
import { prisma } from "../src/persistence/prisma.js";

describe("Twilio Webhook Security and Persistence", () => {
  beforeAll(async () => {
    await fastify.ready();
    await prisma.message.deleteMany();
    await prisma.conversation.deleteMany();
  });

  afterAll(async () => {
    await fastify.close();
    await prisma.$disconnect();
    process.env.ALLOW_INSECURE_WEBHOOK = "false";
    process.env.NODE_ENV = "test";
  });

  it("should persist OUTBOUND message when processing succeeds", async () => {
    // Enable bypass for testing
    process.env.ALLOW_INSECURE_WEBHOOK = "true";
    process.env.NODE_ENV = "development";

    const payload = {
      MessageSid: "SM_PERSIST_TEST",
      Body: "Persistence test",
      From: "+2222222222",
      To: "+8888888888",
      AccountSid: "AC_TEST",
    };

    const response = await supertest(fastify.server)
      .post("/webhooks/twilio")
      .send(new URLSearchParams(payload).toString())
      .set("Content-Type", "application/x-www-form-urlencoded")
      .set("x-twilio-signature", "dummy-signature");

    expect(response.status).toBe(200);

    // Verify database
    const conversation = await prisma.conversation.findUnique({
      where: { providerContact: "+2222222222" },
      include: { messages: true },
    });

    expect(conversation).toBeDefined();
    // Should have 1 INBOUND and 1 OUTBOUND message
    expect(conversation?.messages.length).toBe(2);

    const inbound = conversation?.messages.find(
      (m) => m.direction === "INBOUND",
    );
    const outbound = conversation?.messages.find(
      (m) => m.direction === "OUTBOUND",
    );

    expect(inbound).toBeDefined();
    expect(inbound?.content).toBe("Persistence test");

    expect(outbound).toBeDefined();
    expect(outbound?.providerMessageId).toMatch(/^internal-.*$/);
    expect(outbound?.content).toContain("Recibido");

    // Cleanup
    process.env.ALLOW_INSECURE_WEBHOOK = "false";
    process.env.NODE_ENV = "test";
  });

  it("should return 401 if signature is missing or invalid", async () => {
    const payload = {
      MessageSid: "SM_SEC_TEST_1",
      Body: "Security test",
      From: "+1111111111",
      To: "+9999999999",
      AccountSid: "AC_TEST",
    };

    const response = await supertest(fastify.server)
      .post("/webhooks/twilio")
      .send(new URLSearchParams(payload).toString())
      .set("Content-Type", "application/x-www-form-urlencoded");

    // Since we don't have TWILIO_AUTH_TOKEN set and ALLOW_INSECURE_WEBHOOK is not true,
    // it should fail signature verification.
    expect(response.status).toBe(401);
  });

  it("should return 429 if rate limit exceeded", async () => {
    const payload = {
      MessageSid: "SM_RATE_TEST",
      Body: "Rate test",
      From: "+3333333333",
      To: "+7777777777",
      AccountSid: "AC_TEST",
    };

    // We set max: 3 for tests in server.ts.
    // Requests 1, 2, 3 should be fine (though failing signature if not bypassed)
    // Request 4 should be 429.

    // First 3 requests
    for (let i = 0; i < 3; i++) {
      await supertest(fastify.server)
        .post("/webhooks/twilio")
        .send(
          new URLSearchParams({
            ...payload,
            MessageSid: `SM_RATE_${i}`,
          }).toString(),
        )
        .set("Content-Type", "application/x-www-form-urlencoded");
    }

    // 4th request
    const response = await supertest(fastify.server)
      .post("/webhooks/twilio")
      .send(
        new URLSearchParams({
          ...payload,
          MessageSid: "SM_RATE_EXCEEDED",
        }).toString(),
      )
      .set("Content-Type", "application/x-www-form-urlencoded");

    expect(response.status).toBe(429);
  });
});
