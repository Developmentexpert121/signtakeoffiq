/**
 * Tests that the retry configuration is actually wired through AI calls.
 *
 * Covers:
 *  1. resolveAiRetryMax   — reads aiRetryMax from tenant settings with correct fallbacks
 *  2. buildAiCallOptions  — encapsulates the full threading: tenant settings → { maxRetries, baseDelayMs }
 *     that processJob passes to every callClaudeVision call site.
 *  3. callClaudeVision    — respects the maxRetries parameter by retrying exactly N times
 *     (gemini AI client mocked).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock all heavy transitive dependencies so module evaluation doesn't fail
// ---------------------------------------------------------------------------

vi.mock("@workspace/db", () => ({
  db: {},
  jobsTable: {},
  jobFilesTable: {},
  jobSheetsTable: {},
  roomsTable: {},
  signsTable: {},
  aiScansTable: {},
  plaqueScheduleTable: {},
  validationResultsTable: {},
  ruleOverridesTable: {},
  tenantsTable: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  and: vi.fn(),
}));

// We need a mutable ref to the mock so individual tests can control it.
const mockCreate = vi.fn();

vi.mock("@workspace/integrations-gemini-ai", () => ({
  ai: {
    models: {
      get generateContent() {
        return mockCreate;
      },
    },
  },
}));

vi.mock("@workspace/integrations-anthropic-ai", () => ({
  anthropic: { messages: { create: vi.fn() } },
}));

vi.mock("@workspace/integrations-anthropic-ai/batch", () => ({
  isRateLimitError: vi.fn(() => false),
}));

vi.mock("../lib/objectStorage", () => ({
  objectStorageClient: {},
}));

vi.mock("../lib/ids", () => ({
  newId: vi.fn(() => "test-id"),
}));

vi.mock("../lib/sidecar-client", () => ({
  parseDrawingIndex: vi.fn(),
  rasterizePages: vi.fn(),
  extractWords: vi.fn(),
  sidecarHealthCheck: vi.fn(),
}));

vi.mock("../lib/rules-engine", () => ({
  applyRules: vi.fn(),
  detectBuildingType: vi.fn(),
  classifyRoom: vi.fn(),
  runValidationChecks: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A minimal successful Gemini response. */
function makeSuccessResponse(text = "[]") {
  return { text };
}

/** A retryable error (rate_limit keyword triggers the "rate_limit" classifier). */
function makeRateLimitError(message = "rate_limit exceeded") {
  return new Error(message);
}

// ---------------------------------------------------------------------------
// resolveAiRetryMax — tenant settings wiring
// ---------------------------------------------------------------------------

describe("resolveAiRetryMax – falls back to CLAUDE_RETRY_MAX_DEFAULT", () => {
  it("returns the default when aiRetryMax is absent", async () => {
    const { resolveAiRetryMax, CLAUDE_RETRY_MAX_DEFAULT } = await import("../lib/pipeline");
    expect(resolveAiRetryMax({})).toBe(CLAUDE_RETRY_MAX_DEFAULT);
  });

  it("returns the default when aiRetryMax is a string (non-numeric type)", async () => {
    const { resolveAiRetryMax, CLAUDE_RETRY_MAX_DEFAULT } = await import("../lib/pipeline");
    expect(resolveAiRetryMax({ aiRetryMax: "5" })).toBe(CLAUDE_RETRY_MAX_DEFAULT);
  });

  it("returns the default when aiRetryMax is null", async () => {
    const { resolveAiRetryMax, CLAUDE_RETRY_MAX_DEFAULT } = await import("../lib/pipeline");
    expect(resolveAiRetryMax({ aiRetryMax: null })).toBe(CLAUDE_RETRY_MAX_DEFAULT);
  });

  it("returns the default when aiRetryMax is undefined", async () => {
    const { resolveAiRetryMax, CLAUDE_RETRY_MAX_DEFAULT } = await import("../lib/pipeline");
    expect(resolveAiRetryMax({ aiRetryMax: undefined })).toBe(CLAUDE_RETRY_MAX_DEFAULT);
  });
});

describe("resolveAiRetryMax – uses numeric aiRetryMax from tenant settings", () => {
  it("returns the exact value when within [0, 10]", async () => {
    const { resolveAiRetryMax } = await import("../lib/pipeline");
    expect(resolveAiRetryMax({ aiRetryMax: 0 })).toBe(0);
    expect(resolveAiRetryMax({ aiRetryMax: 5 })).toBe(5);
    expect(resolveAiRetryMax({ aiRetryMax: 10 })).toBe(10);
  });

  it("clamps values above 10 to 10", async () => {
    const { resolveAiRetryMax } = await import("../lib/pipeline");
    expect(resolveAiRetryMax({ aiRetryMax: 11 })).toBe(10);
    expect(resolveAiRetryMax({ aiRetryMax: 100 })).toBe(10);
  });

  it("clamps negative values to 0", async () => {
    const { resolveAiRetryMax } = await import("../lib/pipeline");
    expect(resolveAiRetryMax({ aiRetryMax: -1 })).toBe(0);
    expect(resolveAiRetryMax({ aiRetryMax: -99 })).toBe(0);
  });

  it("rounds float values to the nearest integer", async () => {
    const { resolveAiRetryMax } = await import("../lib/pipeline");
    expect(resolveAiRetryMax({ aiRetryMax: 2.9 })).toBe(3);
    expect(resolveAiRetryMax({ aiRetryMax: 2.4 })).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// buildAiCallOptions – processJob → callClaudeVision wiring
//
// buildAiCallOptions encapsulates the full path from tenant settings (DB) to
// the { maxRetries, baseDelayMs } arguments passed by processJob to every
// callClaudeVision call site.  Testing it here proves the wiring is correct
// without needing to run the entire pipeline.
// ---------------------------------------------------------------------------

describe("buildAiCallOptions – maxRetries is threaded from tenant settings", () => {
  it("returns CLAUDE_RETRY_MAX_DEFAULT when aiRetryMax is absent", async () => {
    const { buildAiCallOptions, CLAUDE_RETRY_MAX_DEFAULT } = await import("../lib/pipeline");
    const opts = buildAiCallOptions({});
    expect(opts.maxRetries).toBe(CLAUDE_RETRY_MAX_DEFAULT);
  });

  it("returns the tenant's aiRetryMax when provided as a number", async () => {
    const { buildAiCallOptions } = await import("../lib/pipeline");
    expect(buildAiCallOptions({ aiRetryMax: 7 }).maxRetries).toBe(7);
    expect(buildAiCallOptions({ aiRetryMax: 1 }).maxRetries).toBe(1);
    expect(buildAiCallOptions({ aiRetryMax: 10 }).maxRetries).toBe(10);
  });

  it("clamps out-of-range aiRetryMax values (same as resolveAiRetryMax)", async () => {
    const { buildAiCallOptions } = await import("../lib/pipeline");
    expect(buildAiCallOptions({ aiRetryMax: -5 }).maxRetries).toBe(0);
    expect(buildAiCallOptions({ aiRetryMax: 99 }).maxRetries).toBe(10);
  });

  it("ignores non-numeric aiRetryMax and falls back to the default", async () => {
    const { buildAiCallOptions, CLAUDE_RETRY_MAX_DEFAULT } = await import("../lib/pipeline");
    expect(buildAiCallOptions({ aiRetryMax: "5" }).maxRetries).toBe(CLAUDE_RETRY_MAX_DEFAULT);
    expect(buildAiCallOptions({ aiRetryMax: null }).maxRetries).toBe(CLAUDE_RETRY_MAX_DEFAULT);
  });
});

describe("buildAiCallOptions – baseDelayMs comes from env config", () => {
  it("returns a positive numeric baseDelayMs", async () => {
    const { buildAiCallOptions } = await import("../lib/pipeline");
    const opts = buildAiCallOptions({});
    expect(typeof opts.baseDelayMs).toBe("number");
    expect(opts.baseDelayMs).toBeGreaterThan(0);
  });

  it("returns the same baseDelayMs regardless of tenant settings (env-controlled)", async () => {
    const { buildAiCallOptions } = await import("../lib/pipeline");
    const optsA = buildAiCallOptions({ aiRetryMax: 2 });
    const optsB = buildAiCallOptions({ aiRetryMax: 8 });
    expect(optsA.baseDelayMs).toBe(optsB.baseDelayMs);
  });
});

describe("buildAiCallOptions – output matches callClaudeVision parameter contract", () => {
  it("provides both maxRetries and baseDelayMs so every AI call site receives the right args", async () => {
    const { buildAiCallOptions } = await import("../lib/pipeline");
    const opts = buildAiCallOptions({ aiRetryMax: 5 });
    expect(opts).toHaveProperty("maxRetries", 5);
    expect(opts).toHaveProperty("baseDelayMs");
    expect(Object.keys(opts).sort()).toEqual(["baseDelayMs", "maxRetries"]);
  });
});

// ---------------------------------------------------------------------------
// callClaudeVision – retry behaviour
// ---------------------------------------------------------------------------

describe("callClaudeVision – succeeds on the first attempt", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValueOnce(makeSuccessResponse());
  });

  it("calls gemini generateContent exactly once when the first attempt succeeds", async () => {
    const { callClaudeVision } = await import("../lib/pipeline");
    await callClaudeVision("sys", "user", "base64img", "image/png", undefined, 3, 0);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("returns the text extracted from the response", async () => {
    const { callClaudeVision } = await import("../lib/pipeline");
    const result = await callClaudeVision("sys", "user", "base64img", "image/png", undefined, 3, 0);
    expect(result.text).toBe("[]");
  });
});

describe("callClaudeVision – retries on retryable errors", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("retries once after a rate_limit error and succeeds on attempt 2 (maxRetries=2)", async () => {
    mockCreate
      .mockRejectedValueOnce(makeRateLimitError())
      .mockResolvedValueOnce(makeSuccessResponse("ok"));

    const { callClaudeVision } = await import("../lib/pipeline");
    const onRetry = vi.fn().mockResolvedValue(undefined);
    const result = await callClaudeVision("sys", "user", "img", "image/png", onRetry, 2, 0);

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, "rate_limit", expect.any(String));
    expect(result.text).toBe("ok");
  });

  it("retries twice and succeeds on attempt 3 (maxRetries=3)", async () => {
    mockCreate
      .mockRejectedValueOnce(makeRateLimitError())
      .mockRejectedValueOnce(makeRateLimitError())
      .mockResolvedValueOnce(makeSuccessResponse("done"));

    const { callClaudeVision } = await import("../lib/pipeline");
    const onRetry = vi.fn().mockResolvedValue(undefined);
    const result = await callClaudeVision("sys", "user", "img", "image/png", onRetry, 3, 0);

    expect(mockCreate).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(result.text).toBe("done");
  });

  it("throws after exhausting all attempts (maxRetries=2, always fails)", async () => {
    mockCreate.mockRejectedValue(makeRateLimitError("rate_limit exceeded"));

    const { callClaudeVision } = await import("../lib/pipeline");
    await expect(
      callClaudeVision("sys", "user", "img", "image/png", undefined, 2, 0),
    ).rejects.toThrow("rate_limit exceeded");

    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("makes exactly N attempts when maxRetries=N and every attempt fails", async () => {
    const N = 4;
    mockCreate.mockRejectedValue(makeRateLimitError());

    const { callClaudeVision } = await import("../lib/pipeline");
    await expect(
      callClaudeVision("sys", "user", "img", "image/png", undefined, N, 0),
    ).rejects.toThrow();

    expect(mockCreate).toHaveBeenCalledTimes(N);
  });
});

describe("callClaudeVision – non-retryable errors are thrown immediately", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("does not retry on a non-retryable error and throws on the first attempt", async () => {
    mockCreate.mockRejectedValueOnce(new Error("invalid_api_key"));

    const { callClaudeVision } = await import("../lib/pipeline");
    const onRetry = vi.fn().mockResolvedValue(undefined);
    await expect(
      callClaudeVision("sys", "user", "img", "image/png", onRetry, 3, 0),
    ).rejects.toThrow("invalid_api_key");

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });
});

describe("callClaudeVision – maxRetries=1 means a single attempt with no retries", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("throws immediately on the first failure without retrying", async () => {
    mockCreate.mockRejectedValueOnce(makeRateLimitError());

    const { callClaudeVision } = await import("../lib/pipeline");
    const onRetry = vi.fn().mockResolvedValue(undefined);
    await expect(
      callClaudeVision("sys", "user", "img", "image/png", onRetry, 1, 0),
    ).rejects.toThrow();

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });
});

describe("callClaudeVision – onRetry callback receives correct arguments", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("passes the attempt number, error type, and truncated message to onRetry", async () => {
    mockCreate
      .mockRejectedValueOnce(makeRateLimitError("rate_limit: quota exceeded"))
      .mockResolvedValueOnce(makeSuccessResponse());

    const { callClaudeVision } = await import("../lib/pipeline");
    const onRetry = vi.fn().mockResolvedValue(undefined);
    await callClaudeVision("sys", "user", "img", "image/png", onRetry, 2, 0);

    expect(onRetry).toHaveBeenCalledWith(
      1,
      "rate_limit",
      expect.stringContaining("rate_limit: quota exceeded"),
    );
  });
});
