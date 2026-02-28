import supertest from "supertest";
import { fastify } from "../src/server.js";
import { prisma } from "../src/persistence/prisma.js";

describe("Twilio Webhook Security (Audit)", () => {
  let originalInsecure: string | undefined;
  let originalNodeEnv: string | undefined;

  beforeAll(async () => {
    originalInsecure = process.env.ALLOW_INSECURE_WEBHOOK;
    originalNodeEnv = process.env.NODE_ENV;
    await fastify.ready();
    await prisma.stateTransition.deleteMany();
    await prisma.message.deleteMany();
    await prisma.conversation.deleteMany();
  });

  afterAll(async () => {
    await fastify.close();
    await prisma.$disconnect();
    process.env.ALLOW_INSECURE_WEBHOOK = originalInsecure;
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("should return 401 if signature is missing or invalid and bypass is disabled", async () => {
    // Force strict check for this test only
    process.env.ALLOW_INSECURE_WEBHOOK = "false";
    process.env.NODE_ENV = "production";

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
