import supertest from "supertest";
import { fastify } from "../src/server.js";
import { prisma } from "../src/persistence/prisma.js";

describe("Twilio Webhook Outbound Persistence (Audit)", () => {
  beforeAll(async () => {
    await fastify.ready();
    process.env.ALLOW_INSECURE_WEBHOOK = "true";
    process.env.NODE_ENV = "development";
    await prisma.job.deleteMany();
    await prisma.stateTransition.deleteMany();
    await prisma.message.deleteMany();
    await prisma.conversation.deleteMany();
  });

  afterAll(async () => {
    await fastify.close();
    await prisma.$disconnect();
    process.env.NODE_ENV = "test";
  });

  it("should NOT create OUTBOUND message in webhook — async worker handles that now", async () => {
    const from = "+19998887777";
    const payload = {
      MessageSid: "SM_OUTBOUND_AUDIT",
      Body: "Testing outbound persistence",
      From: from,
      To: "+11112223333",
      AccountSid: "AC_TEST",
    };

    const response = await supertest(fastify.server)
      .post("/webhooks/twilio")
      .send(new URLSearchParams(payload).toString())
      .set("Content-Type", "application/x-www-form-urlencoded")
      .set("x-twilio-signature", "audit-signature");

    expect(response.status).toBe(200);
    expect(response.text).toBe("<Response></Response>");

    // Check DB
    const conversation = await prisma.conversation.findUnique({
      where: { providerContact: from },
      include: { messages: true },
    });

    expect(conversation).toBeDefined();

    // Webhook must NOT create OUTBOUND messages — that is the worker's responsibility
    const outbound = conversation?.messages.find((m) => m.direction === "OUTBOUND");
    expect(outbound).toBeUndefined();

    // Webhook MUST create a Job for the worker to process
    const job = await prisma.job.findFirst({
      where: {
        conversationId: conversation!.id,
        type: "AI_REPLY_REQUESTED",
      },
    });
    expect(job).toBeDefined();
    expect(job?.status).toBe("PENDING");
    expect(job?.idempotencyKey).toBe(`ai-reply:${conversation!.id}:SM_OUTBOUND_AUDIT`);
  });
});
