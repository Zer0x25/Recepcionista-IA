/**
 * tests/jobs.twilioSend.test.ts
 *
 * Unit tests for src/channel/twilioSend.ts and src/config/env.ts.
 * No real Twilio calls. No DB access.
 */

import { jest } from "@jest/globals";

// ─── env.ts unit tests ───────────────────────────────────────────────────────

describe("getTwilioEnv — env validation", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    // Strip all Twilio vars for isolation
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_WHATSAPP_FROM;
  });

  afterEach(() => {
    Object.assign(process.env, ORIGINAL_ENV);
    jest.resetModules();
  });

  it("should throw if TWILIO_ACCOUNT_SID is missing", async () => {
    process.env.TWILIO_AUTH_TOKEN = "token";
    process.env.TWILIO_WHATSAPP_FROM = "whatsapp:+1415";

    const { getTwilioEnv } = await import("../src/config/env.js");
    expect(() => getTwilioEnv()).toThrow("TWILIO_ACCOUNT_SID");
  });

  it("should throw if TWILIO_AUTH_TOKEN is missing", async () => {
    process.env.TWILIO_ACCOUNT_SID = "ACfake";
    process.env.TWILIO_WHATSAPP_FROM = "whatsapp:+1415";

    const { getTwilioEnv } = await import("../src/config/env.js");
    expect(() => getTwilioEnv()).toThrow("TWILIO_AUTH_TOKEN");
  });

  it("should throw if TWILIO_WHATSAPP_FROM is missing", async () => {
    process.env.TWILIO_ACCOUNT_SID = "ACfake";
    process.env.TWILIO_AUTH_TOKEN = "token";

    const { getTwilioEnv } = await import("../src/config/env.js");
    expect(() => getTwilioEnv()).toThrow("TWILIO_WHATSAPP_FROM");
  });

  it("should return all values when all env vars are present", async () => {
    process.env.TWILIO_ACCOUNT_SID = "ACfake";
    process.env.TWILIO_AUTH_TOKEN = "token";
    process.env.TWILIO_WHATSAPP_FROM = "whatsapp:+1415";

    const { getTwilioEnv } = await import("../src/config/env.js");
    const env = getTwilioEnv();
    expect(env.accountSid).toBe("ACfake");
    expect(env.authToken).toBe("token");
    expect(env.whatsappFrom).toBe("whatsapp:+1415");
  });
});

// ─── twilioSend.ts timeout test ─────────────────────────────────────────────

describe("sendWhatsappMessage — timeout", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.TWILIO_ACCOUNT_SID = "ACfake";
    process.env.TWILIO_AUTH_TOKEN = "fake_token";
    process.env.TWILIO_WHATSAPP_FROM = "whatsapp:+14155238886";
    jest.resetModules();
  });

  afterEach(() => {
    // Restore env
    for (const key of Object.keys(process.env)) {
      if (!(key in ORIGINAL_ENV)) delete process.env[key];
    }
    Object.assign(process.env, ORIGINAL_ENV);
    jest.resetModules();
  });

  it("should reject when twilio messages.create never resolves (timeout)", async () => {
    // Mock the twilio module so messages.create never resolves
    jest.unstable_mockModule("twilio", () => ({
      default: () => ({
        messages: {
          create: jest.fn(
            () =>
              new Promise<never>(() => {
                /* never resolves */
              }),
          ),
        },
      }),
    }));

    const { sendWhatsappMessage } =
      await import("../src/channel/twilioSend.js");

    await expect(
      sendWhatsappMessage({
        to: "whatsapp:+5491100000001",
        from: "whatsapp:+14155238886",
        body: "test",
        requestId: "req-timeout-test",
        conversationId: "conv-timeout-test",
      }),
    ).rejects.toThrow(/timed out/i);
  }, 5_000); // allow up to 5s for the 3s timeout to fire
});
