import { jest } from "@jest/globals";
import supertest from "supertest";
import { fastify } from "../src/server.js";
import { prisma } from "../src/persistence/prisma.js";

describe("Twilio Webhook Outbound Persistence (Audit)", () => {
  beforeAll(async () => {
    await fastify.ready();
    process.env.ALLOW_INSECURE_WEBHOOK = "true";
    process.env.NODE_ENV = "development"; // to allow business logic to proceed normally if needed
    await prisma.message.deleteMany();
    await prisma.conversation.deleteMany();
  });

  afterAll(async () => {
    await fastify.close();
    await prisma.$disconnect();
    process.env.ALLOW_INSECURE_WEBHOOK = "false";
    process.env.NODE_ENV = "test";
  });

  it("should confirm OUTBOUND message exists after successful processing", async () => {
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

    // Check DB
    const conversation = await prisma.conversation.findUnique({
      where: { providerContact: from },
      include: { messages: true },
    });

    expect(conversation).toBeDefined();
    const outbound = conversation?.messages.find(
      (m) => m.direction === "OUTBOUND",
    );

    expect(outbound).toBeDefined();
    expect(outbound?.providerMessageId).toMatch(/^internal-.*$/);
    expect(outbound?.content).toContain("Recibido");
    expect(outbound?.payload).toBeDefined();
  });
});
