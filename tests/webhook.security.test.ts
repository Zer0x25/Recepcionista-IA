import { jest } from "@jest/globals";
import supertest from "supertest";
import { fastify } from "../src/server.js";
import { prisma } from "../src/persistence/prisma.js";

describe("Twilio Webhook Security (Audit)", () => {
  beforeAll(async () => {
    await fastify.ready();
    await prisma.stateTransition.deleteMany();
    await prisma.message.deleteMany();
    await prisma.conversation.deleteMany();
  });

  afterAll(async () => {
    await fastify.close();
    await prisma.$disconnect();
    process.env.ALLOW_INSECURE_WEBHOOK = "false";
    process.env.NODE_ENV = "test";
  });

  it("should return 401 if signature is missing or invalid and bypass is disabled", async () => {
    process.env.ALLOW_INSECURE_WEBHOOK = "false";
    process.env.NODE_ENV = "production"; // Force strict check

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

    expect(response.status).toBe(401);
  });
});
