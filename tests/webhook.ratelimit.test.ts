import supertest from "supertest";
import { fastify } from "../src/server.js";
import { prisma } from "../src/persistence/prisma.js";

describe("Twilio Webhook Rate Limiting (Audit)", () => {
  beforeAll(async () => {
    await fastify.ready();
    process.env.ALLOW_INSECURE_WEBHOOK = "true";
    process.env.NODE_ENV = "test";
    process.env.RATE_LIMIT_MAX = "20";
  });

  afterAll(async () => {
    await fastify.close();
    await prisma.$disconnect();
    process.env.ALLOW_INSECURE_WEBHOOK = "false";
    delete process.env.RATE_LIMIT_MAX;
  });

  it("should rate limit by 'From' field", async () => {
    const from = "+12223334444";
    const payload = {
      MessageSid: "SM_RATE_AUDIT",
      Body: "Rate audit test",
      From: from,
      To: "+9999999999",
      AccountSid: "AC_TEST",
    };

    // max: 20 in test environment for this test block
    for (let i = 0; i < 20; i++) {
      const resp = await supertest(fastify.server)
        .post("/webhooks/twilio")
        .send(
          new URLSearchParams({
            ...payload,
            MessageSid: `SM_RA_${i}`,
          }).toString(),
        )
        .set("Content-Type", "application/x-www-form-urlencoded");
      expect(resp.status).toBe(200);
    }

    // 4th request from same 'From'
    const limitResp = await supertest(fastify.server)
      .post("/webhooks/twilio")
      .send(
        new URLSearchParams({
          ...payload,
          MessageSid: "SM_RA_EXCEEDED",
        }).toString(),
      )
      .set("Content-Type", "application/x-www-form-urlencoded");

    expect(limitResp.status).toBe(429);
  });

  it("should allow different 'From' to have separate limits", async () => {
    // Note: Since we are in the same test run, the previous test might have consumed the bucket for the IP fallback
    // IF the rate limit bucket persists across tests.
    // But here we use a distinct 'From'.

    const from2 = "+15556667777";
    const payload = {
      MessageSid: "SM_RATE_AUDIT_2",
      Body: "Rate audit test 2",
      From: from2,
      To: "+9999999999",
      AccountSid: "AC_TEST",
    };

    const resp = await supertest(fastify.server)
      .post("/webhooks/twilio")
      .send(new URLSearchParams(payload).toString())
      .set("Content-Type", "application/x-www-form-urlencoded");

    expect(resp.status).toBe(200);
  });
});
