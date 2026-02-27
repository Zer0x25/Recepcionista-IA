import { jest } from "@jest/globals";
import supertest from "supertest";
import { fastify } from "../src/server.js";
import { prisma } from "../src/persistence/prisma.js";
import { State } from "@prisma/client";

describe("Webhook Concurrency and Atomicity", () => {
  const fromNumber = "+19998887777";
  const messageSid = "SM_CONC_TEST_100";

  beforeAll(async () => {
    process.env.ALLOW_INSECURE_WEBHOOK = "true";
    process.env.NODE_ENV = "development";
    await fastify.ready();
  });

  afterAll(async () => {
    await fastify.close();
    await prisma.$disconnect();
    process.env.ALLOW_INSECURE_WEBHOOK = "false";
    process.env.NODE_ENV = "test";
  });

  beforeEach(async () => {
    await prisma.stateTransition.deleteMany();
    await prisma.message.deleteMany();
    await prisma.conversation.deleteMany();
  });

  it("should handle 20 concurrent identical requests without duplicate messages or state corruption", async () => {
    const payload = {
      MessageSid: messageSid,
      Body: "Concurrent test message",
      From: fromNumber,
      To: "+1000000000",
      AccountSid: "AC_CONC",
    };

    const urlSearchParams = new URLSearchParams(payload).toString();

    // Fire 20 requests concurrently
    const requests = Array.from({ length: 20 }).map(() =>
      supertest(fastify.server)
        .post("/webhooks/twilio")
        .send(urlSearchParams)
        .set("Content-Type", "application/x-www-form-urlencoded"),
    );

    const responses = await Promise.all(requests);

    // All should return 200 (either processed or idempotent hit)
    responses.forEach((resp) => {
      expect(resp.status).toBe(200);
    });

    // Verify DB State
    const messages = await prisma.message.findMany({
      where: { providerMessageId: messageSid },
    });

    // ATOMICITY CHECK: Only one inbound message should exist
    expect(messages.length).toBe(1);

    const conversation = await prisma.conversation.findUnique({
      where: { providerContact: fromNumber },
      include: { transitions: true },
    });

    expect(conversation).toBeDefined();

    // The state should be logically consistent (final state of the chain)
    // Normally it goes NEW -> CLASSIFYING -> ANSWERING -> WAITING_USER
    expect(conversation?.state).toBe(State.WAITING_USER);

    // Transitions check
    const initialTransitions = conversation?.transitions.filter(
      (t) => t.fromState === State.NEW && t.toState === State.CLASSIFYING,
    );

    // Only ONE transition from NEW to CLASSIFYING should have happened
    expect(initialTransitions?.length).toBe(1);
  });
});
