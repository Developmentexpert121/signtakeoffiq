/**
 * Tests that RASTERIZE_DPI, AI_VISION_CALLS_PER_RUN, and other environment
 * variables are validated at module load time with clear error messages.
 *
 * Each test resets the module registry and dynamically imports pipeline so the
 * module-level IIFEs re-execute with the current env var values.
 *
 * New parse functions (CLEANUP_HISTORY_MAX_AGE_DAYS, CLEANUP_HISTORY_MAX_ROWS,
 * PDF_SIDECAR_URL) are tested directly against the pure parser functions since
 * they are not exercised through the pipeline module.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseCleanupHistoryMaxAgeDays,
  parseCleanupHistoryMaxRows,
  parsePdfSidecarUrl,
} from "../lib/config-parsers";

// ---------------------------------------------------------------------------
// Mock all heavy transitive dependencies so module evaluation only exercises
// the env-var IIFEs we care about and doesn't fail on missing DB/AI setup.
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
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  and: vi.fn(),
}));

vi.mock("@workspace/integrations-anthropic-ai", () => ({
  anthropic: {},
}));

vi.mock("@workspace/integrations-anthropic-ai/batch", () => ({
  isRateLimitError: vi.fn(() => false),
}));

vi.mock("../lib/objectStorage", () => ({
  objectStorageClient: {},
}));

vi.mock("../lib/logger", () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
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

const SAVED_ENV: Record<string, string | undefined> = {};

function saveEnv(...keys: string[]) {
  for (const key of keys) SAVED_ENV[key] = process.env[key];
}

function restoreEnv(...keys: string[]) {
  for (const key of keys) {
    if (SAVED_ENV[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = SAVED_ENV[key];
    }
  }
}

async function importPipeline() {
  vi.resetModules();
  return import("../lib/pipeline");
}

// ---------------------------------------------------------------------------
// RASTERIZE_DPI
// ---------------------------------------------------------------------------

describe("RASTERIZE_DPI validation", () => {
  beforeEach(() => {
    saveEnv("RASTERIZE_DPI", "ANTHROPIC_API_KEY");
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test-key";
  });
  afterEach(() => restoreEnv("RASTERIZE_DPI", "ANTHROPIC_API_KEY"));

  it("accepts unset env var and defaults to 150", async () => {
    delete process.env["RASTERIZE_DPI"];
    await expect(importPipeline()).resolves.toBeDefined();
  });

  it("accepts an empty string and defaults to 150", async () => {
    process.env["RASTERIZE_DPI"] = "";
    await expect(importPipeline()).resolves.toBeDefined();
  });

  it("accepts a valid positive integer string", async () => {
    process.env["RASTERIZE_DPI"] = "200";
    await expect(importPipeline()).resolves.toBeDefined();
  });

  it("accepts a valid positive decimal string", async () => {
    process.env["RASTERIZE_DPI"] = "72.5";
    await expect(importPipeline()).resolves.toBeDefined();
  });

  it("throws on non-numeric string 'abc'", async () => {
    process.env["RASTERIZE_DPI"] = "abc";
    await expect(importPipeline()).rejects.toThrow(
      'Invalid RASTERIZE_DPI value: "abc". Must be a positive number.',
    );
  });

  it("throws on zero", async () => {
    process.env["RASTERIZE_DPI"] = "0";
    await expect(importPipeline()).rejects.toThrow(
      'Invalid RASTERIZE_DPI value: "0". Must be a positive number.',
    );
  });

  it("throws on a negative number", async () => {
    process.env["RASTERIZE_DPI"] = "-1";
    await expect(importPipeline()).rejects.toThrow(
      'Invalid RASTERIZE_DPI value: "-1". Must be a positive number.',
    );
  });

  it("throws on a trailing-garbage value '150abc'", async () => {
    process.env["RASTERIZE_DPI"] = "150abc";
    await expect(importPipeline()).rejects.toThrow(
      'Invalid RASTERIZE_DPI value: "150abc". Must be a positive number.',
    );
  });
});

// ---------------------------------------------------------------------------
// AI_VISION_CALLS_PER_RUN
// ---------------------------------------------------------------------------

describe("AI_VISION_CALLS_PER_RUN validation", () => {
  beforeEach(() => {
    saveEnv("AI_VISION_CALLS_PER_RUN", "ANTHROPIC_API_KEY");
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test-key";
  });
  afterEach(() => restoreEnv("AI_VISION_CALLS_PER_RUN", "ANTHROPIC_API_KEY"));

  it("accepts unset env var and defaults to 10", async () => {
    delete process.env["AI_VISION_CALLS_PER_RUN"];
    await expect(importPipeline()).resolves.toBeDefined();
  });

  it("accepts an empty string and defaults to 10", async () => {
    process.env["AI_VISION_CALLS_PER_RUN"] = "";
    await expect(importPipeline()).resolves.toBeDefined();
  });

  it("accepts a valid positive integer string", async () => {
    process.env["AI_VISION_CALLS_PER_RUN"] = "5";
    await expect(importPipeline()).resolves.toBeDefined();
  });

  it("accepts the minimum valid value of 1", async () => {
    process.env["AI_VISION_CALLS_PER_RUN"] = "1";
    await expect(importPipeline()).resolves.toBeDefined();
  });

  it("throws on non-numeric string 'abc'", async () => {
    process.env["AI_VISION_CALLS_PER_RUN"] = "abc";
    await expect(importPipeline()).rejects.toThrow(
      'Invalid AI_VISION_CALLS_PER_RUN value: "abc". Must be a positive integer (e.g. 10).',
    );
  });

  it("throws on zero", async () => {
    process.env["AI_VISION_CALLS_PER_RUN"] = "0";
    await expect(importPipeline()).rejects.toThrow(
      'Invalid AI_VISION_CALLS_PER_RUN value: "0". Must be a positive integer (e.g. 10).',
    );
  });

  it("throws on a negative integer", async () => {
    process.env["AI_VISION_CALLS_PER_RUN"] = "-1";
    await expect(importPipeline()).rejects.toThrow(
      'Invalid AI_VISION_CALLS_PER_RUN value: "-1". Must be a positive integer (e.g. 10).',
    );
  });

  it("throws on a decimal value '1.5'", async () => {
    process.env["AI_VISION_CALLS_PER_RUN"] = "1.5";
    await expect(importPipeline()).rejects.toThrow(
      'Invalid AI_VISION_CALLS_PER_RUN value: "1.5". Must be a positive integer (e.g. 10).',
    );
  });

  it("throws on a trailing-garbage value '10abc'", async () => {
    process.env["AI_VISION_CALLS_PER_RUN"] = "10abc";
    await expect(importPipeline()).rejects.toThrow(
      'Invalid AI_VISION_CALLS_PER_RUN value: "10abc". Must be a positive integer (e.g. 10).',
    );
  });
});

// ---------------------------------------------------------------------------
// CLEANUP_HISTORY_MAX_AGE_DAYS
// ---------------------------------------------------------------------------

describe("parseCleanupHistoryMaxAgeDays", () => {
  it("returns 90 when env var is absent", () => {
    expect(parseCleanupHistoryMaxAgeDays({})).toBe(90);
  });

  it("returns 90 when env var is empty string", () => {
    expect(parseCleanupHistoryMaxAgeDays({ CLEANUP_HISTORY_MAX_AGE_DAYS: "" })).toBe(90);
  });

  it("accepts a valid positive integer", () => {
    expect(parseCleanupHistoryMaxAgeDays({ CLEANUP_HISTORY_MAX_AGE_DAYS: "30" })).toBe(30);
  });

  it("accepts the minimum valid value of 1", () => {
    expect(parseCleanupHistoryMaxAgeDays({ CLEANUP_HISTORY_MAX_AGE_DAYS: "1" })).toBe(1);
  });

  it("returns 90 (default) and warns on non-numeric string 'abc'", () => {
    const warn = vi.fn();
    expect(parseCleanupHistoryMaxAgeDays({ CLEANUP_HISTORY_MAX_AGE_DAYS: "abc" }, warn)).toBe(90);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("returns 90 (default) and warns on zero", () => {
    const warn = vi.fn();
    expect(parseCleanupHistoryMaxAgeDays({ CLEANUP_HISTORY_MAX_AGE_DAYS: "0" }, warn)).toBe(90);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("returns 90 (default) and warns on a negative integer", () => {
    const warn = vi.fn();
    expect(parseCleanupHistoryMaxAgeDays({ CLEANUP_HISTORY_MAX_AGE_DAYS: "-1" }, warn)).toBe(90);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("returns 90 (default) and warns on a decimal value '1.5'", () => {
    const warn = vi.fn();
    expect(parseCleanupHistoryMaxAgeDays({ CLEANUP_HISTORY_MAX_AGE_DAYS: "1.5" }, warn)).toBe(90);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("returns 90 (default) and warns on a trailing-garbage value '90abc'", () => {
    const warn = vi.fn();
    expect(parseCleanupHistoryMaxAgeDays({ CLEANUP_HISTORY_MAX_AGE_DAYS: "90abc" }, warn)).toBe(90);
    expect(warn).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// CLEANUP_HISTORY_MAX_ROWS
// ---------------------------------------------------------------------------

describe("parseCleanupHistoryMaxRows", () => {
  it("returns 1000 when env var is absent", () => {
    expect(parseCleanupHistoryMaxRows({})).toBe(1000);
  });

  it("returns 1000 when env var is empty string", () => {
    expect(parseCleanupHistoryMaxRows({ CLEANUP_HISTORY_MAX_ROWS: "" })).toBe(1000);
  });

  it("accepts a valid positive integer", () => {
    expect(parseCleanupHistoryMaxRows({ CLEANUP_HISTORY_MAX_ROWS: "500" })).toBe(500);
  });

  it("accepts the minimum valid value of 1", () => {
    expect(parseCleanupHistoryMaxRows({ CLEANUP_HISTORY_MAX_ROWS: "1" })).toBe(1);
  });

  it("returns 1000 (default) and warns on non-numeric string 'abc'", () => {
    const warn = vi.fn();
    expect(parseCleanupHistoryMaxRows({ CLEANUP_HISTORY_MAX_ROWS: "abc" }, warn)).toBe(1000);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("returns 1000 (default) and warns on zero", () => {
    const warn = vi.fn();
    expect(parseCleanupHistoryMaxRows({ CLEANUP_HISTORY_MAX_ROWS: "0" }, warn)).toBe(1000);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("returns 1000 (default) and warns on a negative integer", () => {
    const warn = vi.fn();
    expect(parseCleanupHistoryMaxRows({ CLEANUP_HISTORY_MAX_ROWS: "-5" }, warn)).toBe(1000);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("returns 1000 (default) and warns on a decimal value '10.5'", () => {
    const warn = vi.fn();
    expect(parseCleanupHistoryMaxRows({ CLEANUP_HISTORY_MAX_ROWS: "10.5" }, warn)).toBe(1000);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("returns 1000 (default) and warns on a trailing-garbage value '100abc'", () => {
    const warn = vi.fn();
    expect(parseCleanupHistoryMaxRows({ CLEANUP_HISTORY_MAX_ROWS: "100abc" }, warn)).toBe(1000);
    expect(warn).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// PDF_SIDECAR_URL
// ---------------------------------------------------------------------------

describe("parsePdfSidecarUrl", () => {
  it("returns the default when env var is absent", () => {
    expect(parsePdfSidecarUrl({})).toBe("http://127.0.0.1:8008");
  });

  it("returns the default when env var is empty string", () => {
    expect(parsePdfSidecarUrl({ PDF_SIDECAR_URL: "" })).toBe("http://127.0.0.1:8008");
  });

  it("accepts a valid http URL", () => {
    expect(parsePdfSidecarUrl({ PDF_SIDECAR_URL: "http://localhost:9000" })).toBe("http://localhost:9000");
  });

  it("accepts a valid https URL", () => {
    expect(parsePdfSidecarUrl({ PDF_SIDECAR_URL: "https://sidecar.example.com" })).toBe("https://sidecar.example.com");
  });

  it("accepts a URL with a path", () => {
    expect(parsePdfSidecarUrl({ PDF_SIDECAR_URL: "http://127.0.0.1:8008" })).toBe("http://127.0.0.1:8008");
  });

  it("throws on a plain hostname without a protocol", () => {
    expect(() => parsePdfSidecarUrl({ PDF_SIDECAR_URL: "not-a-url" })).toThrow(
      'Invalid PDF_SIDECAR_URL value: "not-a-url". Must be a valid http or https URL (e.g. http://127.0.0.1:8008).',
    );
  });

  it("throws on a non-http protocol", () => {
    expect(() => parsePdfSidecarUrl({ PDF_SIDECAR_URL: "ftp://example.com" })).toThrow(
      'Invalid PDF_SIDECAR_URL value: "ftp://example.com". Must be a valid http or https URL (e.g. http://127.0.0.1:8008).',
    );
  });

  it("throws on an arbitrary string", () => {
    expect(() => parsePdfSidecarUrl({ PDF_SIDECAR_URL: ":::bad:::" })).toThrow(
      'Invalid PDF_SIDECAR_URL value: ":::bad:::". Must be a valid http or https URL (e.g. http://127.0.0.1:8008).',
    );
  });
});
