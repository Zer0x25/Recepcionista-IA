import { jest } from "@jest/globals";

// Mock logger to avoid spamming logs during tests
// Using relative path without .js extension for the mock as per common Jest ESM pattern if needed
// or keeping it if it's what the resolver expects.
jest.unstable_mockModule("../../src/observability/logger.js", () => ({
  logger: {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    child: jest.fn().mockReturnThis(),
  },
}));

describe("Environment Validation", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    // Set valid defaults for other tests to avoid exit(1) during setup
    process.env.DATABASE_URL =
      "postgresql://postgres:postgres@localhost:5432/recepcionista_ia?schema=public";
    process.env.ADMIN_API_KEY = "super-secret-key-12345";
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("should fail fast if DATABASE_URL is missing", async () => {
    delete process.env.DATABASE_URL;
    const exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`Process.exit called with ${code}`);
      });

    try {
      await import("../../src/config/env.js");
    } catch (err: any) {
      expect(err.message).toContain("Process.exit called with 1");
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("should pass if all required env vars are present and valid", async () => {
    process.env.DATABASE_URL =
      "postgresql://postgres:postgres@localhost:5432/recepcionista_ia?schema=public";
    process.env.ADMIN_API_KEY = "super-secret-key-12345";
    process.env.PORT = "3000";

    const { env } = await import("../../src/config/env.js");
    expect(env.ADMIN_API_KEY).toBe("super-secret-key-12345");
    expect(env.PORT).toBe(3000);
  });
});
