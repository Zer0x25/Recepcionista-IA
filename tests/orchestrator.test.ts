import { jest } from "@jest/globals";
import supertest from "supertest";
import { fastify } from "../src/server.js";
import { prisma } from "../src/persistence/prisma.js";
import { State } from "@prisma/client";

describe("Orchestrator & State Machine", () => {
  const fromNumber = "+1112223333";

  beforeAll(async () => {
    await fastify.ready();
  });

  beforeEach(async () => {
    await prisma.message.deleteMany();
    await prisma.conversation.deleteMany();
  });

  afterAll(async () => {
    await fastify.close();
    await prisma.$disconnect();
  });

  it("should flow NEW -> CLASSIFYING -> ANSWERING -> WAITING_USER for normal message", async () => {
    const payload = {
      MessageSid: "SM_NORMAL_1",
      Body: "Hola, ¿qué servicios ofrecen?",
      From: fromNumber,
      To: "+0987654321",
      AccountSid: "AC12345",
    };

    const response = await supertest(fastify.server)
      .post("/webhooks/twilio")
      .send(new URLSearchParams(payload).toString())
      .set("Content-Type", "application/x-www-form-urlencoded");

    expect(response.status).toBe(200);
    expect(response.text).toContain("Estado: WAITING_USER");

    const conversation = await prisma.conversation.findUnique({
      where: { providerContact: fromNumber },
    });
    expect(conversation?.state).toBe(State.WAITING_USER);
  });

  it("should transition to HANDOFF and suppress response for handoff keywords", async () => {
    const payload = {
      MessageSid: "SM_HANDOFF_1",
      Body: "Quiero hablar con un humano ahora mismo",
      From: fromNumber,
      To: "+0987654321",
      AccountSid: "AC12345",
    };

    const response = await supertest(fastify.server)
      .post("/webhooks/twilio")
      .send(new URLSearchParams(payload).toString())
      .set("Content-Type", "application/x-www-form-urlencoded");

    expect(response.status).toBe(200);
    expect(response.text).toBe("<Response></Response>"); // Suppressed response

    const conversation = await prisma.conversation.findUnique({
      where: { providerContact: fromNumber },
    });
    expect(conversation?.state).toBe(State.HANDOFF);
  });
});
