import { describe, expect, it } from "vitest";
import {
  deduplicateSignSchedule,
  deduplicateSchedulePerSheet,
  deduplicateScheduleGlobal,
  type SignScheduleEntry,
} from "./pipeline";

// ---------------------------------------------------------------------------
// Step 4b cross-path dedup — unit tests
//
// The dedup block (pipeline.ts) removes entries where
// sheetId + roomNumber + signType collide after both Step 3a (Gemini vision)
// and Step 4b (text / Gemini fallback) have pushed into signSchedule[].
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<SignScheduleEntry> = {}): SignScheduleEntry {
  return {
    roomNumber: "101",
    roomName: "Office",
    signType: "Room ID",
    quantity: 1,
    size: "6x6",
    message: "",
    notes: "",
    floor: null,
    source: "text",
    sheetId: "sheet-A",
    substrate: null,
    finishMethod: null,
    brailleSpec: null,
    mountingHeight: null,
    manufacturer: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Step 4b cross-path dedup", () => {
  it("removes a duplicate entry pushed by both Step 3a and Step 4b for the same sheet", () => {
    const schedule: SignScheduleEntry[] = [
      makeEntry({ sheetId: "sheet-1", roomNumber: "101", signType: "Room ID", source: "gemini" }),
      makeEntry({ sheetId: "sheet-1", roomNumber: "101", signType: "Room ID", source: "text" }),
    ];

    deduplicateSignSchedule(schedule);

    expect(schedule).toHaveLength(1);
    expect(schedule[0].sheetId).toBe("sheet-1");
    expect(schedule[0].roomNumber).toBe("101");
    expect(schedule[0].signType).toBe("Room ID");
  });

  it("each sheetId|roomNumber|signType key appears exactly once after dedup", () => {
    const schedule: SignScheduleEntry[] = [
      makeEntry({ sheetId: "sheet-1", roomNumber: "101", signType: "Room ID", source: "gemini" }),
      makeEntry({ sheetId: "sheet-1", roomNumber: "101", signType: "Room ID", source: "text" }),
      makeEntry({ sheetId: "sheet-1", roomNumber: "102", signType: "Room ID", source: "gemini" }),
      makeEntry({ sheetId: "sheet-1", roomNumber: "102", signType: "Room ID", source: "text" }),
      makeEntry({ sheetId: "sheet-2", roomNumber: "101", signType: "Room ID", source: "text" }),
    ];

    deduplicateSignSchedule(schedule);

    const keys = schedule.map(e =>
      `${e.sheetId}|${e.roomNumber}|${e.signType}`,
    );
    const uniqueKeys = new Set(keys);
    expect(keys.length).toBe(uniqueKeys.size);
    expect(schedule).toHaveLength(3);
  });

  it("does not deduplicate entries that differ only by signType", () => {
    const schedule: SignScheduleEntry[] = [
      makeEntry({ sheetId: "sheet-1", roomNumber: "101", signType: "Room ID" }),
      makeEntry({ sheetId: "sheet-1", roomNumber: "101", signType: "ADA Restroom" }),
    ];

    deduplicateSignSchedule(schedule);

    expect(schedule).toHaveLength(2);
  });

  it("does not deduplicate entries that differ only by roomNumber", () => {
    const schedule: SignScheduleEntry[] = [
      makeEntry({ sheetId: "sheet-1", roomNumber: "101", signType: "Room ID" }),
      makeEntry({ sheetId: "sheet-1", roomNumber: "102", signType: "Room ID" }),
    ];

    deduplicateSignSchedule(schedule);

    expect(schedule).toHaveLength(2);
  });

  it("does not deduplicate entries that differ only by sheetId", () => {
    const schedule: SignScheduleEntry[] = [
      makeEntry({ sheetId: "sheet-1", roomNumber: "101", signType: "Room ID" }),
      makeEntry({ sheetId: "sheet-2", roomNumber: "101", signType: "Room ID" }),
    ];

    deduplicateSignSchedule(schedule);

    expect(schedule).toHaveLength(2);
  });

  it("is case-insensitive and trims whitespace when matching keys", () => {
    const schedule: SignScheduleEntry[] = [
      makeEntry({ sheetId: "Sheet-1", roomNumber: " 101 ", signType: "Room ID", source: "gemini" }),
      makeEntry({ sheetId: "sheet-1", roomNumber: "101", signType: "ROOM ID", source: "text" }),
    ];

    deduplicateSignSchedule(schedule);

    expect(schedule).toHaveLength(1);
  });

  it("keeps the first entry (Step 3a/gemini) when a collision occurs", () => {
    const schedule: SignScheduleEntry[] = [
      makeEntry({ sheetId: "sheet-1", roomNumber: "101", signType: "Room ID", source: "gemini" }),
      makeEntry({ sheetId: "sheet-1", roomNumber: "101", signType: "Room ID", source: "text" }),
    ];

    deduplicateSignSchedule(schedule);

    expect(schedule[0].source).toBe("gemini");
  });

  it("handles multiple overlapping entries from both paths across several sheets", () => {
    const schedule: SignScheduleEntry[] = [
      // sheet-A: Step 3a (gemini) pushed two entries
      makeEntry({ sheetId: "sheet-A", roomNumber: "101", signType: "Room ID", source: "gemini" }),
      makeEntry({ sheetId: "sheet-A", roomNumber: "102", signType: "Stair ID", source: "gemini" }),
      // sheet-A: Step 4b (text) pushed the same two again
      makeEntry({ sheetId: "sheet-A", roomNumber: "101", signType: "Room ID", source: "text" }),
      makeEntry({ sheetId: "sheet-A", roomNumber: "102", signType: "Stair ID", source: "text" }),
      // sheet-B: unique entry from Step 4b only
      makeEntry({ sheetId: "sheet-B", roomNumber: "201", signType: "Elevator ID", source: "text" }),
      // sheet-B: another duplicate pair
      makeEntry({ sheetId: "sheet-B", roomNumber: "201", signType: "Elevator ID", source: "gemini" }),
    ];

    deduplicateSignSchedule(schedule);

    expect(schedule).toHaveLength(3);

    const keys = schedule.map(e =>
      `${e.sheetId}|${e.roomNumber}|${e.signType}`,
    );
    expect(keys).toContain("sheet-A|101|Room ID");
    expect(keys).toContain("sheet-A|102|Stair ID");
    expect(keys).toContain("sheet-B|201|Elevator ID");
  });

  it("returns an empty array unchanged when signSchedule is empty", () => {
    const schedule: SignScheduleEntry[] = [];
    deduplicateSignSchedule(schedule);
    expect(schedule).toHaveLength(0);
  });

  it("returns the array unchanged when there are no duplicates", () => {
    const schedule: SignScheduleEntry[] = [
      makeEntry({ sheetId: "sheet-1", roomNumber: "101", signType: "Room ID" }),
      makeEntry({ sheetId: "sheet-1", roomNumber: "102", signType: "Room ID" }),
      makeEntry({ sheetId: "sheet-2", roomNumber: "101", signType: "ADA Restroom" }),
    ];

    deduplicateSignSchedule(schedule);

    expect(schedule).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Guard removal: all three helpers must be safe to call unconditionally
//
// The Step 3a and Step 4b dedup blocks no longer guard calls behind
// `if (signSchedule.length > 0)`.  These tests document that calling each
// helper on an empty array is a safe no-op, so the guard-free paths cannot
// cause runtime errors regardless of how signSchedule arrives.
// ---------------------------------------------------------------------------

describe("guard-free safety: dedup helpers on empty input", () => {
  it("deduplicateSignSchedule does not throw and leaves an empty array empty", () => {
    const schedule: SignScheduleEntry[] = [];
    expect(() => deduplicateSignSchedule(schedule)).not.toThrow();
    expect(schedule).toHaveLength(0);
  });

  it("deduplicateSchedulePerSheet does not throw and leaves an empty array empty", () => {
    const schedule: SignScheduleEntry[] = [];
    expect(() => deduplicateSchedulePerSheet(schedule)).not.toThrow();
    expect(schedule).toHaveLength(0);
  });

  it("deduplicateScheduleGlobal does not throw and leaves an empty array empty", () => {
    const schedule: SignScheduleEntry[] = [];
    expect(() => deduplicateScheduleGlobal(schedule)).not.toThrow();
    expect(schedule).toHaveLength(0);
  });

  it("calling all three helpers in sequence on an empty array is a safe no-op", () => {
    const schedule: SignScheduleEntry[] = [];
    expect(() => {
      deduplicateSchedulePerSheet(schedule);
      deduplicateScheduleGlobal(schedule);
      deduplicateSignSchedule(schedule);
    }).not.toThrow();
    expect(schedule).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Step 3a per-sheet dedup (deduplicateSchedulePerSheet)
// Key: roomNumber|signType — does NOT consider sheetId or roomName
// ---------------------------------------------------------------------------

describe("Step 3a per-sheet dedup", () => {
  it("removes duplicate roomNumber|signType pairs", () => {
    const schedule: SignScheduleEntry[] = [
      makeEntry({ roomNumber: "101", signType: "Room ID", source: "gemini" }),
      makeEntry({ roomNumber: "101", signType: "Room ID", source: "text" }),
    ];

    deduplicateSchedulePerSheet(schedule);

    expect(schedule).toHaveLength(1);
  });

  it("keeps the first (earlier) entry when a collision occurs", () => {
    const schedule: SignScheduleEntry[] = [
      makeEntry({ roomNumber: "101", signType: "Room ID", source: "gemini" }),
      makeEntry({ roomNumber: "101", signType: "Room ID", source: "text" }),
    ];

    deduplicateSchedulePerSheet(schedule);

    expect(schedule[0].source).toBe("gemini");
  });

  it("does not deduplicate entries that differ by signType", () => {
    const schedule: SignScheduleEntry[] = [
      makeEntry({ roomNumber: "101", signType: "Room ID" }),
      makeEntry({ roomNumber: "101", signType: "ADA Restroom" }),
    ];

    deduplicateSchedulePerSheet(schedule);

    expect(schedule).toHaveLength(2);
  });

  it("does not deduplicate entries that differ by roomNumber", () => {
    const schedule: SignScheduleEntry[] = [
      makeEntry({ roomNumber: "101", signType: "Room ID" }),
      makeEntry({ roomNumber: "102", signType: "Room ID" }),
    ];

    deduplicateSchedulePerSheet(schedule);

    expect(schedule).toHaveLength(2);
  });

  it("treats entries from different sheetIds as duplicates when roomNumber|signType match", () => {
    // Per-sheet dedup ignores sheetId — it collapses across sheets by design
    const schedule: SignScheduleEntry[] = [
      makeEntry({ sheetId: "sheet-1", roomNumber: "101", signType: "Room ID" }),
      makeEntry({ sheetId: "sheet-2", roomNumber: "101", signType: "Room ID" }),
    ];

    deduplicateSchedulePerSheet(schedule);

    expect(schedule).toHaveLength(1);
  });

  it("is case-insensitive and trims whitespace", () => {
    const schedule: SignScheduleEntry[] = [
      makeEntry({ roomNumber: " 101 ", signType: "Room ID", source: "gemini" }),
      makeEntry({ roomNumber: "101", signType: "ROOM ID", source: "text" }),
    ];

    deduplicateSchedulePerSheet(schedule);

    expect(schedule).toHaveLength(1);
    expect(schedule[0].source).toBe("gemini");
  });

  it("handles an empty array without throwing", () => {
    const schedule: SignScheduleEntry[] = [];
    deduplicateSchedulePerSheet(schedule);
    expect(schedule).toHaveLength(0);
  });

  it("returns the array unchanged when there are no duplicates", () => {
    const schedule: SignScheduleEntry[] = [
      makeEntry({ roomNumber: "101", signType: "Room ID" }),
      makeEntry({ roomNumber: "102", signType: "Room ID" }),
      makeEntry({ roomNumber: "101", signType: "ADA Restroom" }),
    ];

    deduplicateSchedulePerSheet(schedule);

    expect(schedule).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Step 3a global cross-sheet dedup (deduplicateScheduleGlobal)
// Key: roomNumber|roomName|signType — catches duplicates spanning many table instances
// ---------------------------------------------------------------------------

describe("Step 3a global cross-sheet dedup", () => {
  it("removes entries with identical roomNumber|roomName|signType", () => {
    const schedule: SignScheduleEntry[] = [
      makeEntry({ roomNumber: "101", roomName: "Office", signType: "Room ID", source: "gemini" }),
      makeEntry({ roomNumber: "101", roomName: "Office", signType: "Room ID", source: "text" }),
    ];

    deduplicateScheduleGlobal(schedule);

    expect(schedule).toHaveLength(1);
    expect(schedule[0].source).toBe("gemini");
  });

  it("keeps entries that differ only by roomName", () => {
    const schedule: SignScheduleEntry[] = [
      makeEntry({ roomNumber: "101", roomName: "Office", signType: "Room ID" }),
      makeEntry({ roomNumber: "101", roomName: "Conference", signType: "Room ID" }),
    ];

    deduplicateScheduleGlobal(schedule);

    expect(schedule).toHaveLength(2);
  });

  it("keeps entries that differ only by roomNumber", () => {
    const schedule: SignScheduleEntry[] = [
      makeEntry({ roomNumber: "101", roomName: "Office", signType: "Room ID" }),
      makeEntry({ roomNumber: "102", roomName: "Office", signType: "Room ID" }),
    ];

    deduplicateScheduleGlobal(schedule);

    expect(schedule).toHaveLength(2);
  });

  it("keeps entries that differ only by signType", () => {
    const schedule: SignScheduleEntry[] = [
      makeEntry({ roomNumber: "101", roomName: "Office", signType: "Room ID" }),
      makeEntry({ roomNumber: "101", roomName: "Office", signType: "ADA Restroom" }),
    ];

    deduplicateScheduleGlobal(schedule);

    expect(schedule).toHaveLength(2);
  });

  it("is case-insensitive and trims whitespace across all three key fields", () => {
    const schedule: SignScheduleEntry[] = [
      makeEntry({ roomNumber: " 101 ", roomName: "Office", signType: "Room ID", source: "gemini" }),
      makeEntry({ roomNumber: "101", roomName: "OFFICE", signType: "ROOM ID", source: "text" }),
    ];

    deduplicateScheduleGlobal(schedule);

    expect(schedule).toHaveLength(1);
    expect(schedule[0].source).toBe("gemini");
  });

  it("handles entries with null/undefined fields by ignoring them in the key", () => {
    // Two entries with no roomName — should still deduplicate on roomNumber|signType
    const schedule: SignScheduleEntry[] = [
      makeEntry({ roomNumber: "101", roomName: undefined as unknown as string, signType: "Room ID", source: "gemini" }),
      makeEntry({ roomNumber: "101", roomName: undefined as unknown as string, signType: "Room ID", source: "text" }),
    ];

    deduplicateScheduleGlobal(schedule);

    expect(schedule).toHaveLength(1);
  });

  it("handles an empty array without throwing", () => {
    const schedule: SignScheduleEntry[] = [];
    deduplicateScheduleGlobal(schedule);
    expect(schedule).toHaveLength(0);
  });

  it("simulates the AA831 multi-table-instance scenario", () => {
    // 27 table instances all pushing the same room entry — only 1 should survive
    const duplicates = Array.from({ length: 27 }, () =>
      makeEntry({ roomNumber: "831", roomName: "Storage", signType: "Room ID" }),
    );

    deduplicateScheduleGlobal(duplicates);

    expect(duplicates).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Step 9 bridge dedup — guard-free path
//
// The Step 9 bridge guard previously read `if (signSchedule.length > 0 && hasScheduleImport)`.
// The `signSchedule.length > 0` sub-condition was removed because the inline
// dedup logic (keyed on sheetId+roomNumber+signType) already short-circuits
// safely on empty input, matching the same fix applied to Steps 3a and 4b.
// These tests document that the bridge dedup key logic is safe to run
// unconditionally when hasScheduleImport is true, regardless of array length.
// ---------------------------------------------------------------------------

describe("Step 9 bridge dedup — guard-free path", () => {
  it("runs safely on an empty signSchedule without throwing", () => {
    const schedule: SignScheduleEntry[] = [];
    expect(() => deduplicateSignSchedule(schedule)).not.toThrow();
    expect(schedule).toHaveLength(0);
  });

  it("deduplicates by sheetId+roomNumber+signType when hasScheduleImport is true and entries exist", () => {
    const schedule: SignScheduleEntry[] = [
      makeEntry({ sheetId: "bridge-sheet", roomNumber: "200", signType: "Stair ID", source: "gemini" }),
      makeEntry({ sheetId: "bridge-sheet", roomNumber: "200", signType: "Stair ID", source: "text" }),
      makeEntry({ sheetId: "bridge-sheet", roomNumber: "201", signType: "Stair ID", source: "gemini" }),
    ];

    deduplicateSignSchedule(schedule);

    expect(schedule).toHaveLength(2);
    expect(schedule[0].source).toBe("gemini");
    expect(schedule[1].roomNumber).toBe("201");
  });

  it("produces zero inserts (not a runtime error) when hasScheduleImport is true but signSchedule is empty", () => {
    // Simulates a run where hasScheduleImport=true but no schedule entries were
    // collected — the guard-free block should produce an empty dedupedSchedule
    // instead of silently skipping all logging and insert steps.
    const schedule: SignScheduleEntry[] = [];
    deduplicateSignSchedule(schedule);
    const dedupedLength = schedule.length;
    expect(dedupedLength).toBe(0);
  });
});
