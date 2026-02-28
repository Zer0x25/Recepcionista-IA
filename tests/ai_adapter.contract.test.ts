import { jest } from "@jest/globals";
import { logger } from "../src/observability/logger.js";
import { callAI } from "../src/ai_adapter/index.js";

describe("AI Adapter Contract Tests", () => {
  let capturedLogs: any[] = [];

  beforeEach(() => {
    capturedLogs = [];
    // Spy on logger.info and logger.error to verify logs
    jest.spyOn(logger, "info").mockImplementation((obj: any) => {
      capturedLogs.push(obj);
      return undefined as any;
    });
    jest.spyOn(logger, "error").mockImplementation((obj: any) => {
      capturedLogs.push(obj);
      return undefined as any;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("should succeed with valid input and valid stub output", async () => {
    const input = {
      conversationId: "test-conv-id",
      requestId: "test-req-id",
      text: "hello ai",
    };

    const response = await callAI(input);

    expect(response.success).toBe(true);
    expect(response.content).toContain("hello ai");
    expect(response.tokensUsed).toBeGreaterThan(0);

    // Verify logging
    const startLog = capturedLogs.find((l) => l.eventType === "AI_CALL_STARTED");
    const successLog = capturedLogs.find((l) => l.eventType === "AI_CALL_SUCCEEDED");

    expect(startLog).toBeDefined();
    expect(startLog.requestId).toBe("test-req-id");
    expect(startLog.conversationId).toBe("test-conv-id");

    expect(successLog).toBeDefined();
    expect(successLog.tokensUsed).toBe(response.tokensUsed);
    expect(successLog.durationMs).toBeDefined();
  });

  it("should fail gracefully with invalid input (contract violation)", async () => {
    // Missing text
    const input = {
      conversationId: "test-conv-id",
      requestId: "test-req-id",
    } as any;

    const response = await callAI(input);

    expect(response.success).toBe(false);
    expect(response.content).toBe("");
    expect(response.error).toBeDefined();

    const failureLog = capturedLogs.find((l) => l.eventType === "AI_CALL_FAILED");
    expect(failureLog).toBeDefined();
    expect(failureLog.error).toMatch(/invalid_type|Required/i);
  });

  it.skip("should return fallback if AI provider returns invalid structure", async () => {
    // Skipping for now as the provider stub is internal and not easily mockable
    // without architectural changes.
  });
});
