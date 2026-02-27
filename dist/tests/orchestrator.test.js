import supertest from "supertest";
import { fastify } from "../src/server.js";
import { prisma } from "../src/persistence/prisma.js";
import { State } from "@prisma/client";
describe("Orchestrator & State Machine", () => {
    const fromNumber = "+1112223333";
    beforeAll(async () => {
        process.env.ALLOW_INSECURE_WEBHOOK = "true";
        await fastify.ready();
    });
    beforeEach(async () => {
        await prisma.stateTransition.deleteMany();
        await prisma.message.deleteMany();
        await prisma.conversation.deleteMany();
    });
    afterAll(async () => {
        await fastify.close();
        await prisma.$disconnect();
        process.env.ALLOW_INSECURE_WEBHOOK = "false";
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
    it("should persist all state transitions in the audit table", async () => {
        const payload = {
            MessageSid: `SM_AUDIT_${Date.now()}`,
            Body: "Hola",
            From: "+5556667777",
            To: "+0987654321",
            AccountSid: "AC12345",
        };
        await supertest(fastify.server)
            .post("/webhooks/twilio")
            .send(new URLSearchParams(payload).toString())
            .set("Content-Type", "application/x-www-form-urlencoded");
        const conversation = await prisma.conversation.findUnique({
            where: { providerContact: "+5556667777" },
            include: { transitions: { orderBy: { createdAt: "asc" } } },
        });
        expect(conversation).toBeDefined();
        // Transitions: NEW -> CLASSIFYING -> ANSWERING -> WAITING_USER
        expect(conversation?.transitions.length).toBeGreaterThanOrEqual(3);
        conversation?.transitions.forEach((t) => {
            expect(t.fromState).not.toBe(t.toState);
            expect(t.conversationId).toBe(conversation.id);
            expect(t.triggeredBy).toBe(payload.MessageSid);
        });
        // Specific check for the sequence
        const states = conversation?.transitions.map((t) => t.toState);
        expect(states).toContain(State.CLASSIFYING);
        expect(states).toContain(State.ANSWERING);
        expect(states).toContain(State.WAITING_USER);
        // Verify ordering
        const transitionTimes = conversation?.transitions.map((t) => t.createdAt.getTime());
        const sortedTimes = [...(transitionTimes || [])].sort((a, b) => a - b);
        expect(transitionTimes).toEqual(sortedTimes);
    });
});
//# sourceMappingURL=orchestrator.test.js.map