/**
 * Tests that startGuestCleanupJob() emits the correct WARN logs when
 * CLEANUP_HISTORY_MAX_AGE_DAYS or CLEANUP_HISTORY_MAX_ROWS env vars are
 * invalid, and the correct INFO log (with resolved values) in all cases.
 *
 * Because guestCleanup.ts parses env vars at module evaluation time, each
 * test resets the module registry and dynamically re-imports the module so
 * the top-level IIFEs re-execute with the current env values.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock all heavy transitive dependencies so module evaluation exercises only
// the env-var parsing and logging paths we care about.
// ---------------------------------------------------------------------------

vi.mock("@workspace/db", () => ({
  db: {
    insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve()) })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([])),
      })),
    })),
  },
  tenantsTable: {},
  jobFilesTable: {},
  jobSheetsTable: {},
  guestCleanupRunsTable: {},
  systemSettingsTable: {},
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn(),
  lt: vi.fn(),
  like: vi.fn(),
  sql: vi.fn(),
  inArray: vi.fn(),
  desc: vi.fn(),
  not: vi.fn(),
  eq: vi.fn(),
}));

vi.mock("../lib/guestAuth", () => ({
  GUEST_SESSION_TTL_MS: 3_600_000,
  GUEST_TENANT_PREFIX: "guest_",
}));

vi.mock("../lib/objectStorage", () => ({
  objectStorageClient: { delete: vi.fn(), list: vi.fn() },
}));

vi.mock("../lib/logger", () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ENV_KEYS = ["CLEANUP_HISTORY_MAX_AGE_DAYS", "CLEANUP_HISTORY_MAX_ROWS"] as const;
const saved: Record<string, string | undefined> = {};

function saveEnv() {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
}

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
}

async function loadModule() {
  vi.resetModules();
  const mod = await import("../lib/guestCleanup");
  const { logger } = await import("../lib/logger");
  return { mod, logger };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  saveEnv();
  vi.clearAllMocks();
});
afterEach(restoreEnv);

describe("startGuestCleanupJob — WARN when CLEANUP_HISTORY_MAX_AGE_DAYS is invalid", () => {
  it('emits WARN with defaultUsed: 90 when value is "abc"', async () => {
    process.env.CLEANUP_HISTORY_MAX_AGE_DAYS = "abc";
    delete process.env.CLEANUP_HISTORY_MAX_ROWS;

    const { mod, logger } = await loadModule();
    mod.startGuestCleanupJob();

    const warnCalls = vi.mocked(logger.warn).mock.calls;
    const matchingCall = warnCalls.find(([obj]) => {
      const o = obj as Record<string, unknown>;
      return (
        typeof o === "object" &&
        o !== null &&
        "envValue" in o &&
        o.envValue === "abc" &&
        o.defaultUsed === 90
      );
    });

    expect(matchingCall).toBeDefined();
  });

  it('emits WARN with defaultUsed: 90 when value is "-5"', async () => {
    process.env.CLEANUP_HISTORY_MAX_AGE_DAYS = "-5";
    delete process.env.CLEANUP_HISTORY_MAX_ROWS;

    const { mod, logger } = await loadModule();
    mod.startGuestCleanupJob();

    const warnCalls = vi.mocked(logger.warn).mock.calls;
    const matchingCall = warnCalls.find(([obj]) => {
      const o = obj as Record<string, unknown>;
      return (
        typeof o === "object" &&
        o !== null &&
        "envValue" in o &&
        o.envValue === "-5" &&
        o.defaultUsed === 90
      );
    });

    expect(matchingCall).toBeDefined();
  });

  it('emits WARN with defaultUsed: 90 when value is "0"', async () => {
    process.env.CLEANUP_HISTORY_MAX_AGE_DAYS = "0";
    delete process.env.CLEANUP_HISTORY_MAX_ROWS;

    const { mod, logger } = await loadModule();
    mod.startGuestCleanupJob();

    const warnCalls = vi.mocked(logger.warn).mock.calls;
    const matchingCall = warnCalls.find(([obj]) => {
      const o = obj as Record<string, unknown>;
      return (
        typeof o === "object" &&
        o !== null &&
        "envValue" in o &&
        o.envValue === "0" &&
        o.defaultUsed === 90
      );
    });

    expect(matchingCall).toBeDefined();
  });

  it("does NOT emit WARN when CLEANUP_HISTORY_MAX_AGE_DAYS is absent", async () => {
    delete process.env.CLEANUP_HISTORY_MAX_AGE_DAYS;
    delete process.env.CLEANUP_HISTORY_MAX_ROWS;

    const { mod, logger } = await loadModule();
    mod.startGuestCleanupJob();

    const warnCalls = vi.mocked(logger.warn).mock.calls;
    const ageDaysWarn = warnCalls.find(([_obj, msg]) =>
      typeof msg === "string" && msg.includes("CLEANUP_HISTORY_MAX_AGE_DAYS"),
    );
    expect(ageDaysWarn).toBeUndefined();
  });
});

describe("startGuestCleanupJob — WARN when CLEANUP_HISTORY_MAX_ROWS is invalid", () => {
  it('emits WARN with defaultUsed: 1000 when value is "abc"', async () => {
    delete process.env.CLEANUP_HISTORY_MAX_AGE_DAYS;
    process.env.CLEANUP_HISTORY_MAX_ROWS = "abc";

    const { mod, logger } = await loadModule();
    mod.startGuestCleanupJob();

    const warnCalls = vi.mocked(logger.warn).mock.calls;
    const matchingCall = warnCalls.find(([obj]) => {
      const o = obj as Record<string, unknown>;
      return (
        typeof o === "object" &&
        o !== null &&
        "envValue" in o &&
        o.envValue === "abc" &&
        o.defaultUsed === 1000
      );
    });

    expect(matchingCall).toBeDefined();
  });

  it('emits WARN with defaultUsed: 1000 when value is "-1"', async () => {
    delete process.env.CLEANUP_HISTORY_MAX_AGE_DAYS;
    process.env.CLEANUP_HISTORY_MAX_ROWS = "-1";

    const { mod, logger } = await loadModule();
    mod.startGuestCleanupJob();

    const warnCalls = vi.mocked(logger.warn).mock.calls;
    const matchingCall = warnCalls.find(([obj]) => {
      const o = obj as Record<string, unknown>;
      return (
        typeof o === "object" &&
        o !== null &&
        "envValue" in o &&
        o.envValue === "-1" &&
        o.defaultUsed === 1000
      );
    });

    expect(matchingCall).toBeDefined();
  });

  it("does NOT emit WARN when CLEANUP_HISTORY_MAX_ROWS is absent", async () => {
    delete process.env.CLEANUP_HISTORY_MAX_AGE_DAYS;
    delete process.env.CLEANUP_HISTORY_MAX_ROWS;

    const { mod, logger } = await loadModule();
    mod.startGuestCleanupJob();

    const warnCalls = vi.mocked(logger.warn).mock.calls;
    const rowsWarn = warnCalls.find(([_obj, msg]) =>
      typeof msg === "string" && msg.includes("CLEANUP_HISTORY_MAX_ROWS"),
    );
    expect(rowsWarn).toBeUndefined();
  });
});

describe("startGuestCleanupJob — INFO log with resolved retention values", () => {
  it("INFO log shows built-in defaults (maxAgeDays: 90, maxRows: 1000) when no env vars are set", async () => {
    delete process.env.CLEANUP_HISTORY_MAX_AGE_DAYS;
    delete process.env.CLEANUP_HISTORY_MAX_ROWS;

    const { mod, logger } = await loadModule();
    await mod.startGuestCleanupJob();

    const infoCalls = vi.mocked(logger.info).mock.calls;
    const retentionLog = infoCalls.find(([obj]) => {
      const o = obj as Record<string, unknown>;
      return (
        typeof o === "object" &&
        o !== null &&
        o.maxAgeDays === 90 &&
        o.maxRows === 1000
      );
    });

    expect(retentionLog).toBeDefined();
  });

  it("INFO log reflects valid custom env vars (maxAgeDays: 30, maxRows: 500)", async () => {
    process.env.CLEANUP_HISTORY_MAX_AGE_DAYS = "30";
    process.env.CLEANUP_HISTORY_MAX_ROWS = "500";

    const { mod, logger } = await loadModule();
    await mod.startGuestCleanupJob();

    const infoCalls = vi.mocked(logger.info).mock.calls;
    const retentionLog = infoCalls.find(([obj]) => {
      const o = obj as Record<string, unknown>;
      return (
        typeof o === "object" &&
        o !== null &&
        o.maxAgeDays === 30 &&
        o.maxRows === 500
      );
    });

    expect(retentionLog).toBeDefined();
  });

  it("INFO log shows defaults even when env vars are invalid (falls back)", async () => {
    process.env.CLEANUP_HISTORY_MAX_AGE_DAYS = "bad";
    process.env.CLEANUP_HISTORY_MAX_ROWS = "also-bad";

    const { mod, logger } = await loadModule();
    await mod.startGuestCleanupJob();

    const infoCalls = vi.mocked(logger.info).mock.calls;
    const retentionLog = infoCalls.find(([obj]) => {
      const o = obj as Record<string, unknown>;
      return (
        typeof o === "object" &&
        o !== null &&
        o.maxAgeDays === 90 &&
        o.maxRows === 1000
      );
    });

    expect(retentionLog).toBeDefined();
  });

  it("INFO log reflects a valid maxAgeDays even when maxRows falls back to default", async () => {
    process.env.CLEANUP_HISTORY_MAX_AGE_DAYS = "60";
    process.env.CLEANUP_HISTORY_MAX_ROWS = "notanumber";

    const { mod, logger } = await loadModule();
    await mod.startGuestCleanupJob();

    const infoCalls = vi.mocked(logger.info).mock.calls;
    const retentionLog = infoCalls.find(([obj]) => {
      const o = obj as Record<string, unknown>;
      return (
        typeof o === "object" &&
        o !== null &&
        o.maxAgeDays === 60 &&
        o.maxRows === 1000
      );
    });

    expect(retentionLog).toBeDefined();
  });
});
