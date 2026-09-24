/**
 * Tests for applyStep3aBridge — the bridge block at the end of Step 3a.
 *
 * Verifies that when dedicated sign-schedule files are present and Step 3a
 * extracted schedule entries, the bridge:
 *   1. Sets hasScheduleImport = true (so Step 9 uses the schedule path)
 *   2. Returns the exact entries in bridgedRows (the data Step 9 will consume)
 *
 * Extracted from processJob so the contract can be tested without the full
 * pipeline (no DB, no AI, no sidecar).
 */

import { describe, expect, it, vi } from "vitest";

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

vi.mock("drizzle-orm", () => ({ eq: vi.fn(), and: vi.fn() }));

vi.mock("@workspace/integrations-gemini-ai", () => ({
  ai: { models: { generateContent: vi.fn() } },
}));

vi.mock("@workspace/integrations-anthropic-ai", () => ({
  anthropic: { messages: { create: vi.fn() } },
}));

vi.mock("@workspace/integrations-anthropic-ai/batch", () => ({
  isRateLimitError: vi.fn(() => false),
}));

vi.mock("../lib/objectStorage", () => ({ objectStorageClient: {} }));

vi.mock("../lib/ids", () => ({ newId: vi.fn(() => "test-id") }));

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
// Happy path — bridge fires when both conditions are met
// ---------------------------------------------------------------------------

describe("applyStep3aBridge – fires when dedicated files AND schedule entries are present", () => {
  it("sets hasScheduleImport=true and bridgedRows.length equals signSchedule.length", async () => {
    const { applyStep3aBridge } = await import("../lib/pipeline");

    const files   = [{ id: "file-1" }];
    const entries = [
      { roomNumber: "101", roomName: "Office",    signType: "Room ID",  quantity: 1 },
      { roomNumber: "102", roomName: "Restroom",  signType: "ADA",      quantity: 2 },
      { roomNumber: "103", roomName: "Stairwell", signType: "Egress",   quantity: 1 },
    ];

    const result = applyStep3aBridge(files, entries);

    expect(result.hasScheduleImport).toBe(true);
    expect(result.bridgedRows).toHaveLength(entries.length);
  });

  it("bridgedRows contains the exact same entries that were extracted (identity check)", async () => {
    const { applyStep3aBridge } = await import("../lib/pipeline");

    const files   = [{ id: "sched-file-42" }, { id: "sched-file-43" }];
    const entries = [
      { roomNumber: "201", roomName: "Conference", signType: "Room ID", quantity: 1 },
      { roomNumber: "202", roomName: "Lobby",      signType: "Room ID", quantity: 1 },
    ];

    const result = applyStep3aBridge(files, entries);

    expect(result.hasScheduleImport).toBe(true);
    expect(result.bridgedRows).toBe(entries);
  });
});

// ---------------------------------------------------------------------------
// Bridge does NOT fire — missing dedicated files
// ---------------------------------------------------------------------------

describe("applyStep3aBridge – does NOT fire when no dedicated schedule files are present", () => {
  it("returns hasScheduleImport=false and empty bridgedRows even when schedule entries exist", async () => {
    const { applyStep3aBridge } = await import("../lib/pipeline");

    const entries = [
      { roomNumber: "101", roomName: "Office", signType: "Room ID", quantity: 1 },
    ];

    const result = applyStep3aBridge([], entries);

    expect(result.hasScheduleImport).toBe(false);
    expect(result.bridgedRows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Bridge does NOT fire — no extracted entries
// ---------------------------------------------------------------------------

describe("applyStep3aBridge – does NOT fire when Step 3a extracted zero entries", () => {
  it("returns hasScheduleImport=false and empty bridgedRows when signSchedule is empty", async () => {
    const { applyStep3aBridge } = await import("../lib/pipeline");

    const result = applyStep3aBridge([{ id: "file-1" }], []);

    expect(result.hasScheduleImport).toBe(false);
    expect(result.bridgedRows).toHaveLength(0);
  });
});
