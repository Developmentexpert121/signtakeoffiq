import { describe, it, expect, beforeEach } from "vitest";
import {
  migrateJobDetailTabKeys,
  readLru,
  JOB_DETAIL_TAB_PREFIX,
  JOB_DETAIL_LRU_KEY,
  JOB_DETAIL_LRU_MAX,
  JOB_DETAIL_MIGRATION_FLAG,
} from "@/lib/job-detail-tab-migration";

beforeEach(() => {
  localStorage.clear();
});

describe("migrateJobDetailTabKeys", () => {
  describe("legacy global key removal", () => {
    it("removes the legacy global key job-detail.activeTab", () => {
      localStorage.setItem("job-detail.activeTab", "overview");

      migrateJobDetailTabKeys();

      expect(localStorage.getItem("job-detail.activeTab")).toBeNull();
    });

    it("does not remove unrelated keys", () => {
      localStorage.setItem("some-other-key", "value");
      localStorage.setItem("job-detail.abc123.activeTab", "overview");

      migrateJobDetailTabKeys();

      expect(localStorage.getItem("some-other-key")).toBe("value");
    });
  });

  describe("seeding per-job keys into the LRU", () => {
    it("adds per-job keys that are not in the LRU", () => {
      localStorage.setItem("job-detail.abc123.activeTab", "overview");
      localStorage.setItem("job-detail.def456.activeTab", "rooms");

      migrateJobDetailTabKeys();

      const lru = readLru();
      expect(lru).toContain("abc123");
      expect(lru).toContain("def456");
    });

    it("preserves the tab values when seeding into the LRU", () => {
      localStorage.setItem("job-detail.abc123.activeTab", "overview");

      migrateJobDetailTabKeys();

      expect(localStorage.getItem("job-detail.abc123.activeTab")).toBe("overview");
    });

    it("does not duplicate a job ID that is already in the LRU", () => {
      localStorage.setItem(JOB_DETAIL_LRU_KEY, JSON.stringify(["abc123"]));
      localStorage.setItem("job-detail.abc123.activeTab", "overview");

      migrateJobDetailTabKeys();

      const lru = readLru();
      const occurrences = lru.filter((id) => id === "abc123").length;
      expect(occurrences).toBe(1);
    });
  });

  describe("keys already in the LRU are left untouched", () => {
    it("keeps existing LRU entries when job key is already managed", () => {
      localStorage.setItem(JOB_DETAIL_LRU_KEY, JSON.stringify(["abc123", "def456"]));
      localStorage.setItem("job-detail.abc123.activeTab", "overview");

      migrateJobDetailTabKeys();

      const lru = readLru();
      expect(lru[0]).toBe("abc123");
      expect(lru[1]).toBe("def456");
    });

    it("preserves already-managed keys alongside newly seeded ones", () => {
      localStorage.setItem(JOB_DETAIL_LRU_KEY, JSON.stringify(["existing-job"]));
      localStorage.setItem("job-detail.existing-job.activeTab", "overview");
      localStorage.setItem("job-detail.new-job.activeTab", "rooms");

      migrateJobDetailTabKeys();

      const lru = readLru();
      expect(lru).toContain("existing-job");
      expect(lru).toContain("new-job");
    });
  });

  describe("migration flag prevents re-running", () => {
    it("sets the migration flag after running", () => {
      migrateJobDetailTabKeys();

      expect(localStorage.getItem(JOB_DETAIL_MIGRATION_FLAG)).toBe("1");
    });

    it("does not re-run migration when flag is already set", () => {
      localStorage.setItem(JOB_DETAIL_MIGRATION_FLAG, "1");
      localStorage.setItem("job-detail.activeTab", "overview");

      migrateJobDetailTabKeys();

      expect(localStorage.getItem("job-detail.activeTab")).toBe("overview");
    });

    it("does not modify the LRU if migration flag is already set", () => {
      const existingLru = ["job-a", "job-b"];
      localStorage.setItem(JOB_DETAIL_LRU_KEY, JSON.stringify(existingLru));
      localStorage.setItem(JOB_DETAIL_MIGRATION_FLAG, "1");
      localStorage.setItem("job-detail.job-c.activeTab", "rooms");

      migrateJobDetailTabKeys();

      const lru = readLru();
      expect(lru).toEqual(existingLru);
    });
  });

  describe("LRU cap enforcement", () => {
    it(`caps the LRU at ${JOB_DETAIL_LRU_MAX} entries and evicts the oldest`, () => {
      const existingIds = Array.from({ length: JOB_DETAIL_LRU_MAX }, (_, i) => `existing-${i}`);
      localStorage.setItem(JOB_DETAIL_LRU_KEY, JSON.stringify(existingIds));

      localStorage.setItem("job-detail.new-job.activeTab", "overview");

      migrateJobDetailTabKeys();

      const lru = readLru();
      expect(lru.length).toBe(JOB_DETAIL_LRU_MAX);
    });

    it("removes the activeTab key for evicted entries when the LRU overflows", () => {
      const existingIds = Array.from({ length: JOB_DETAIL_LRU_MAX - 1 }, (_, i) => `existing-${i}`);
      localStorage.setItem(JOB_DETAIL_LRU_KEY, JSON.stringify(existingIds));

      localStorage.setItem("job-detail.new-a.activeTab", "overview");
      localStorage.setItem("job-detail.new-b.activeTab", "rooms");

      migrateJobDetailTabKeys();

      const lru = readLru();
      expect(lru.length).toBe(JOB_DETAIL_LRU_MAX);
      const evictedId = lru.includes("new-a") ? "new-b" : "new-a";
      expect(localStorage.getItem(`${JOB_DETAIL_TAB_PREFIX}${evictedId}.activeTab`)).toBeNull();
    });

    it("does not exceed the cap when orphaned keys overflow it", () => {
      const existingIds = Array.from({ length: JOB_DETAIL_LRU_MAX }, (_, i) => `job-${i}`);
      localStorage.setItem(JOB_DETAIL_LRU_KEY, JSON.stringify(existingIds));
      localStorage.setItem("job-detail.brand-new.activeTab", "rooms");

      migrateJobDetailTabKeys();

      const lru = readLru();
      expect(lru.length).toBe(JOB_DETAIL_LRU_MAX);
    });
  });
});

describe("readLru", () => {
  it("returns an empty array when the LRU key does not exist", () => {
    expect(readLru()).toEqual([]);
  });

  it("returns an empty array when the stored value is malformed JSON", () => {
    localStorage.setItem(JOB_DETAIL_LRU_KEY, "not-json{{");
    expect(readLru()).toEqual([]);
  });

  it("returns an empty array when stored value is not an array", () => {
    localStorage.setItem(JOB_DETAIL_LRU_KEY, JSON.stringify({ foo: "bar" }));
    expect(readLru()).toEqual([]);
  });

  it("returns the stored array when valid", () => {
    localStorage.setItem(JOB_DETAIL_LRU_KEY, JSON.stringify(["job-1", "job-2"]));
    expect(readLru()).toEqual(["job-1", "job-2"]);
  });
});
