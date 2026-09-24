import { describe, it, expect } from "vitest";
import { mapWithConcurrency } from "./concurrency";

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

describe("mapWithConcurrency", () => {
  it("returns an empty array for empty input without calling fn", async () => {
    let calls = 0;
    const out = await mapWithConcurrency([], 4, async () => {
      calls++;
      return 1;
    });
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });

  it("preserves input order regardless of completion order", async () => {
    const items = [50, 10, 30, 5, 20];
    // Slower items finish later, but results must stay index-aligned.
    const out = await mapWithConcurrency(items, 2, async (ms, i) => {
      await tick(ms);
      return `${i}:${ms}`;
    });
    expect(out).toEqual(["0:50", "1:10", "2:30", "3:5", "4:20"]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick(5);
      inFlight--;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBe(3); // 20 items / limit 3 → the cap is actually reached
  });

  it("treats a limit >= length as full parallelism", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3], 10, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick(5);
      inFlight--;
    });
    expect(peak).toBe(3);
  });

  it("clamps a non-positive limit to a single worker", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3, 4], 0, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick(2);
      inFlight--;
    });
    expect(peak).toBe(1);
  });

  it("rejects when any task rejects (Promise.all semantics)", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });

  it("passes the correct index to fn", async () => {
    const seen: Array<[string, number]> = [];
    await mapWithConcurrency(["a", "b", "c"], 1, async (item, index) => {
      seen.push([item, index]);
    });
    expect(seen).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
  });
});
