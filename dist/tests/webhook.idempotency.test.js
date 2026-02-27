import supertest from "supertest";
import { fastify } from "../src/server.js";
import { prisma } from "../src/persistence/prisma.js";
describe("Twilio Webhook Idempotency", () => {
    beforeAll(async () => {
        await fastify.ready();
        process.env.ALLOW_INSECURE_WEBHOOK = "true";
        process.env.NODE_ENV = "development";
        // Clean up DB before tests
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
    it("should only create one record when receiving the same MessageSid twice", async () => {
        const payload = {
            MessageSid: "SM123456789",
            Body: "Hello world",
            From: "+1234567890",
            To: "+0987654321",
            AccountSid: "AC12345",
        };
        // First request
        const response1 = await supertest(fastify.server)
            .post("/webhooks/twilio")
            .send(new URLSearchParams(payload).toString())
            .set("Content-Type", "application/x-www-form-urlencoded");
        expect(response1.status).toBe(200);
        expect(response1.text).toContain("Estado: WAITING_USER");
        // Second request (same providerMessageId)
        const response2 = await supertest(fastify.server)
            .post("/webhooks/twilio")
            .send(new URLSearchParams(payload).toString())
            .set("Content-Type", "application/x-www-form-urlencoded");
        expect(response2.status).toBe(200);
        // Check DB count
        const messageCount = await prisma.message.count({
            where: { providerMessageId: "SM123456789" },
        });
        expect(messageCount).toBe(1);
        const conversationCount = await prisma.conversation.count({
            where: { providerContact: "+1234567890" },
        });
        expect(conversationCount).toBe(1);
    });
});
//# sourceMappingURL=webhook.idempotency.test.js.map