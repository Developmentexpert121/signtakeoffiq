/**
 * Tests for the startup configuration validation layer.
 *
 * Two levels of coverage:
 *
 * 1. `validateStartupConfig` (config-parsers.ts) — unit tests that verify the
 *    collector returns the correct error messages without any side effects.
 *
 * 2. `checkStartupConfig` (startup-validation.ts) — integration-style tests
 *    that verify the startup guard calls process.exit(1) with a complete error
 *    list when any env var is invalid, and does NOT exit when all values are
 *    valid.  Uses a mock exit function to stay in-process.
 */
import { describe, expect, it, vi } from "vitest";
import { validateStartupConfig } from "../lib/config-parsers";
import { checkStartupConfig } from "../lib/startup-validation";
import { logger } from "../lib/logger";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A minimal set of all required secrets.  Tests that want to exercise a
 * specific variable pass it as an override; everything else is filled in so
 * the validator does not report unrelated errors.
 */
function validEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    DATABASE_URL: "postgresql://user:pass@localhost:5432/testdb",
    AI_INTEGRATIONS_ANTHROPIC_API_KEY: "sk-ant-test-key",
    AI_INTEGRATIONS_ANTHROPIC_BASE_URL: "https://api.anthropic.com",
    PRIVATE_OBJECT_DIR: "my-bucket/private",
    ANTHROPIC_API_KEY: "sk-ant-test-key",
    ...overrides,
  };
}

/**
 * Run `checkStartupConfig` with a no-op logger and a spy exit function.
 * Returns the exit code passed to `exitFn`, or undefined if it was never called.
 */
function runStartupCheck(env: Record<string, string | undefined>): number | undefined {
  let exitCode: number | undefined;
  const mockExit = (code: number): never => {
    exitCode = code;
    return undefined as never;
  };
  checkStartupConfig(env, mockExit);
  return exitCode;
}

// ---------------------------------------------------------------------------
// validateStartupConfig — unit tests
// ---------------------------------------------------------------------------

describe("validateStartupConfig", () => {
  // ── Valid configurations ─────────────────────────────────────────────────

  it("returns an empty array when all required secrets are present and numeric vars use defaults", () => {
    expect(validateStartupConfig(validEnv())).toEqual([]);
  });

  it("returns an empty array when all required secrets are present and numeric vars are explicitly valid", () => {
    expect(validateStartupConfig(validEnv({
      RASTERIZE_DPI: "200",
      AI_VISION_CALLS_PER_RUN: "5",
    }))).toEqual([]);
  });

  it("returns an empty array when numeric vars are empty strings (defaults apply)", () => {
    expect(validateStartupConfig(validEnv({
      RASTERIZE_DPI: "",
      AI_VISION_CALLS_PER_RUN: "",
    }))).toEqual([]);
  });

  // ── Required secrets — missing ────────────────────────────────────────────

  it("returns an error when DATABASE_URL is absent", () => {
    const errors = validateStartupConfig(validEnv({ DATABASE_URL: undefined }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("DATABASE_URL");
    expect(errors[0]).toMatch(/missing or empty/i);
  });

  it("returns an error when DATABASE_URL is an empty string", () => {
    const errors = validateStartupConfig(validEnv({ DATABASE_URL: "" }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("DATABASE_URL");
  });

  it("returns an error when DATABASE_URL is a whitespace-only string", () => {
    const errors = validateStartupConfig(validEnv({ DATABASE_URL: "   " }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("DATABASE_URL");
  });

  it("accepts DO_DATABASE_URL as an alternative when DATABASE_URL is absent", () => {
    const errors = validateStartupConfig(
      validEnv({
        DATABASE_URL: undefined,
        DO_DATABASE_URL: "postgresql://user:pass@host:5432/testdb",
      }),
    );
    expect(errors).toEqual([]);
  });

  it("returns an error when both DATABASE_URL and DO_DATABASE_URL are missing", () => {
    const errors = validateStartupConfig(
      validEnv({ DATABASE_URL: undefined, DO_DATABASE_URL: undefined }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("DATABASE_URL");
  });

  // ── Production-only secrets ───────────────────────────────────────────────

  it("does not require GUEST_JWT_SECRET / SESSION_SECRET outside production", () => {
    expect(validateStartupConfig(validEnv())).toEqual([]);
  });

  it("requires GUEST_JWT_SECRET and SESSION_SECRET in production", () => {
    const errors = validateStartupConfig(validEnv({ NODE_ENV: "production" }));
    expect(errors.some((e) => e.includes("GUEST_JWT_SECRET"))).toBe(true);
    expect(errors.some((e) => e.includes("SESSION_SECRET"))).toBe(true);
  });

  it("flags a too-short SESSION_SECRET in production", () => {
    const errors = validateStartupConfig(
      validEnv({
        NODE_ENV: "production",
        GUEST_JWT_SECRET: "a-long-random-guest-secret",
        SESSION_SECRET: "tooshort",
      }),
    );
    expect(errors.some((e) => e.includes("SESSION_SECRET"))).toBe(true);
    expect(errors.some((e) => e.includes("GUEST_JWT_SECRET"))).toBe(false);
  });

  it("passes in production when GUEST_JWT_SECRET and SESSION_SECRET are valid", () => {
    const errors = validateStartupConfig(
      validEnv({
        NODE_ENV: "production",
        GUEST_JWT_SECRET: "a-long-random-guest-secret",
        SESSION_SECRET: "a-long-random-session-secret",
      }),
    );
    expect(errors).toEqual([]);
  });

  it("returns an error when AI_INTEGRATIONS_ANTHROPIC_API_KEY is absent", () => {
    const errors = validateStartupConfig(validEnv({ AI_INTEGRATIONS_ANTHROPIC_API_KEY: undefined }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("AI_INTEGRATIONS_ANTHROPIC_API_KEY");
    expect(errors[0]).toMatch(/missing or empty/i);
  });

  it("returns an error when AI_INTEGRATIONS_ANTHROPIC_API_KEY is an empty string", () => {
    const errors = validateStartupConfig(validEnv({ AI_INTEGRATIONS_ANTHROPIC_API_KEY: "" }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("AI_INTEGRATIONS_ANTHROPIC_API_KEY");
  });

  it("returns an error when AI_INTEGRATIONS_ANTHROPIC_BASE_URL is absent", () => {
    const errors = validateStartupConfig(validEnv({ AI_INTEGRATIONS_ANTHROPIC_BASE_URL: undefined }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("AI_INTEGRATIONS_ANTHROPIC_BASE_URL");
    expect(errors[0]).toMatch(/missing or empty/i);
  });

  it("returns an error when AI_INTEGRATIONS_ANTHROPIC_BASE_URL is an empty string", () => {
    const errors = validateStartupConfig(validEnv({ AI_INTEGRATIONS_ANTHROPIC_BASE_URL: "" }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("AI_INTEGRATIONS_ANTHROPIC_BASE_URL");
  });

  it("returns an error when PRIVATE_OBJECT_DIR is absent", () => {
    const errors = validateStartupConfig(validEnv({ PRIVATE_OBJECT_DIR: undefined }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("PRIVATE_OBJECT_DIR");
    expect(errors[0]).toMatch(/missing or empty/i);
  });

  it("returns an error when PRIVATE_OBJECT_DIR is an empty string", () => {
    const errors = validateStartupConfig(validEnv({ PRIVATE_OBJECT_DIR: "" }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("PRIVATE_OBJECT_DIR");
  });

  it("does not error when ANTHROPIC_API_KEY is absent but AI_INTEGRATIONS_ANTHROPIC_API_KEY is set", () => {
    const errors = validateStartupConfig(validEnv({ ANTHROPIC_API_KEY: undefined }));
    expect(errors).toHaveLength(0);
  });

  it("does not error when ANTHROPIC_API_KEY is empty but AI_INTEGRATIONS_ANTHROPIC_API_KEY is set", () => {
    const errors = validateStartupConfig(validEnv({ ANTHROPIC_API_KEY: "" }));
    expect(errors).toHaveLength(0);
  });

  it("returns an error when both ANTHROPIC_API_KEY and AI_INTEGRATIONS_ANTHROPIC_API_KEY are absent", () => {
    const errors = validateStartupConfig(
      validEnv({ ANTHROPIC_API_KEY: undefined, AI_INTEGRATIONS_ANTHROPIC_API_KEY: undefined }),
    );
    expect(errors).toHaveLength(2);
    expect(errors.some((e) => e.includes("AI_INTEGRATIONS_ANTHROPIC_API_KEY"))).toBe(true);
    expect(errors.some((e) => e.includes("ANTHROPIC_API_KEY"))).toBe(true);
  });

  it("collects errors for all missing required secrets in one pass", () => {
    const errors = validateStartupConfig({});
    const names = ["DATABASE_URL", "AI_INTEGRATIONS_ANTHROPIC_API_KEY", "AI_INTEGRATIONS_ANTHROPIC_BASE_URL", "PRIVATE_OBJECT_DIR", "ANTHROPIC_API_KEY"];
    for (const name of names) {
      expect(errors.some((e) => e.includes(name))).toBe(true);
    }
    expect(errors.length).toBeGreaterThanOrEqual(names.length);
  });

  // ── Operator-tunable numerics — invalid ───────────────────────────────────

  it("returns one error when only RASTERIZE_DPI is invalid", () => {
    const errors = validateStartupConfig(validEnv({ RASTERIZE_DPI: "abc", AI_VISION_CALLS_PER_RUN: "10" }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("RASTERIZE_DPI");
    expect(errors[0]).toContain('"abc"');
  });

  it("returns one error when only AI_VISION_CALLS_PER_RUN is invalid", () => {
    const errors = validateStartupConfig(validEnv({ RASTERIZE_DPI: "150", AI_VISION_CALLS_PER_RUN: "bad" }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("AI_VISION_CALLS_PER_RUN");
    expect(errors[0]).toContain('"bad"');
  });

  it("returns two errors when both numeric vars are invalid — collects all failures in one pass", () => {
    const errors = validateStartupConfig(validEnv({ RASTERIZE_DPI: "0", AI_VISION_CALLS_PER_RUN: "1.5" }));
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("RASTERIZE_DPI");
    expect(errors[1]).toContain("AI_VISION_CALLS_PER_RUN");
  });

  it("includes the offending value and a human-readable hint for RASTERIZE_DPI", () => {
    const errors = validateStartupConfig(validEnv({ RASTERIZE_DPI: "-5" }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/"-5"/);
    expect(errors[0]).toMatch(/positive number/i);
  });

  it("includes the offending value and a human-readable hint for AI_VISION_CALLS_PER_RUN", () => {
    const errors = validateStartupConfig(validEnv({ AI_VISION_CALLS_PER_RUN: "0" }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/"0"/);
    expect(errors[0]).toMatch(/positive integer/i);
  });

  it("treats a non-integer AI_VISION_CALLS_PER_RUN as invalid", () => {
    expect(validateStartupConfig(validEnv({ AI_VISION_CALLS_PER_RUN: "2.5" }))).toHaveLength(1);
  });

  it("treats a garbage-appended AI_VISION_CALLS_PER_RUN value as invalid", () => {
    const errors = validateStartupConfig(validEnv({ AI_VISION_CALLS_PER_RUN: "10abc" }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("AI_VISION_CALLS_PER_RUN");
  });

  it("treats a garbage-appended RASTERIZE_DPI value as invalid", () => {
    const errors = validateStartupConfig(validEnv({ RASTERIZE_DPI: "150abc" }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("RASTERIZE_DPI");
  });

  // ── Combined failures ─────────────────────────────────────────────────────

  it("collects both a missing secret and an invalid numeric in one pass", () => {
    const errors = validateStartupConfig(validEnv({
      DATABASE_URL: undefined,
      RASTERIZE_DPI: "0",
    }));
    expect(errors).toHaveLength(2);
    expect(errors.some((e) => e.includes("DATABASE_URL"))).toBe(true);
    expect(errors.some((e) => e.includes("RASTERIZE_DPI"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkStartupConfig — integration-style startup tests
// ---------------------------------------------------------------------------

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

describe("checkStartupConfig (startup guard)", () => {
  it("does NOT call exit when all required secrets and numeric vars are valid", () => {
    const exitCode = runStartupCheck(validEnv({ RASTERIZE_DPI: "150", AI_VISION_CALLS_PER_RUN: "5" }));
    expect(exitCode).toBeUndefined();
  });

  it("does NOT call exit when only required secrets are set (numeric vars use defaults)", () => {
    const exitCode = runStartupCheck(validEnv());
    expect(exitCode).toBeUndefined();
  });

  it("calls exit(1) when DATABASE_URL is missing", () => {
    const exitCode = runStartupCheck(validEnv({ DATABASE_URL: undefined }));
    expect(exitCode).toBe(1);
  });

  it("calls exit(1) when AI_INTEGRATIONS_ANTHROPIC_API_KEY is missing", () => {
    const exitCode = runStartupCheck(validEnv({ AI_INTEGRATIONS_ANTHROPIC_API_KEY: undefined }));
    expect(exitCode).toBe(1);
  });

  it("calls exit(1) when AI_INTEGRATIONS_ANTHROPIC_BASE_URL is missing", () => {
    const exitCode = runStartupCheck(validEnv({ AI_INTEGRATIONS_ANTHROPIC_BASE_URL: undefined }));
    expect(exitCode).toBe(1);
  });

  it("calls exit(1) when PRIVATE_OBJECT_DIR is missing", () => {
    const exitCode = runStartupCheck(validEnv({ PRIVATE_OBJECT_DIR: undefined }));
    expect(exitCode).toBe(1);
  });

  it("calls exit(1) when both ANTHROPIC_API_KEY and AI_INTEGRATIONS_ANTHROPIC_API_KEY are missing", () => {
    const exitCode = runStartupCheck(
      validEnv({ ANTHROPIC_API_KEY: undefined, AI_INTEGRATIONS_ANTHROPIC_API_KEY: undefined }),
    );
    expect(exitCode).toBe(1);
  });

  it("calls exit(1) when RASTERIZE_DPI is invalid", () => {
    const exitCode = runStartupCheck(validEnv({ RASTERIZE_DPI: "abc" }));
    expect(exitCode).toBe(1);
  });

  it("calls exit(1) when AI_VISION_CALLS_PER_RUN is invalid", () => {
    const exitCode = runStartupCheck(validEnv({ AI_VISION_CALLS_PER_RUN: "not-a-number" }));
    expect(exitCode).toBe(1);
  });

  it("calls exit(1) when env is completely empty (all required secrets missing)", () => {
    const exitCode = runStartupCheck({});
    expect(exitCode).toBe(1);
  });

  it("calls exit(1) and reports BOTH numeric errors when both vars are bad", () => {
    const mockExit = (_code: number): never => undefined as never;

    vi.mocked(logger.error).mockClear();

    checkStartupConfig(
      validEnv({ RASTERIZE_DPI: "0", AI_VISION_CALLS_PER_RUN: "1.5" }),
      mockExit,
    );

    const firstCallArg = vi.mocked(logger.error).mock.calls[0][0] as { configErrors: string[] };
    expect(firstCallArg.configErrors).toHaveLength(2);
    expect(firstCallArg.configErrors.some((e) => e.includes("RASTERIZE_DPI"))).toBe(true);
    expect(firstCallArg.configErrors.some((e) => e.includes("AI_VISION_CALLS_PER_RUN"))).toBe(true);
  });

  it("calls exit(1) and reports all missing secrets when env is empty", () => {
    const mockExit = (_code: number): never => undefined as never;

    vi.mocked(logger.error).mockClear();

    checkStartupConfig({}, mockExit);

    const firstCallArg = vi.mocked(logger.error).mock.calls[0][0] as { configErrors: string[] };
    expect(firstCallArg.configErrors.length).toBeGreaterThanOrEqual(4);
    const names = ["DATABASE_URL", "AI_INTEGRATIONS_ANTHROPIC_API_KEY", "AI_INTEGRATIONS_ANTHROPIC_BASE_URL", "PRIVATE_OBJECT_DIR"];
    for (const name of names) {
      expect(firstCallArg.configErrors.some((e: string) => e.includes(name))).toBe(true);
    }
  });

  it("calls exit(1) — not exit(0) or other code — on invalid config", () => {
    const exitCode = runStartupCheck(validEnv({ RASTERIZE_DPI: "-1" }));
    expect(exitCode).toBe(1);
  });
});
