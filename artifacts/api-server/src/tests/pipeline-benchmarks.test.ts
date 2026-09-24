import { describe, test, expect } from "vitest";
import { db, signsTable, jobsTable } from "@workspace/db";
import { eq, count } from "drizzle-orm";

// Job IDs for benchmark jobs — update if jobs are recreated
const FOX_HILL_JOB_ID = process.env.FOX_HILL_JOB_ID ?? "job_a81ec18d15cec938";
const WALKING_COURT_2_JOB_ID = process.env.WALKING_COURT_2_JOB_ID ?? "job_2fb551b4f62a8b22";
const GIBSON_LIB_JOB_ID = process.env.GIBSON_LIB_JOB_ID ?? "";

async function jobExists(jobId: string): Promise<boolean> {
  const result = await db
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(eq(jobsTable.id, jobId))
    .limit(1);
  return result.length > 0;
}

async function getJobSignCount(jobId: string): Promise<number> {
  const result = await db
    .select({ count: count() })
    .from(signsTable)
    .where(eq(signsTable.jobId, jobId));
  return result[0]?.count ?? 0;
}

async function getJobStrategy(jobId: string): Promise<string | null> {
  const job = await db
    .select({ metadata: jobsTable.metadata, scopeFlag: jobsTable.scopeFlag })
    .from(jobsTable)
    .where(eq(jobsTable.id, jobId))
    .limit(1);
  if (!job[0]) return null;
  return (
    job[0].scopeFlag ??
    (job[0].metadata as Record<string, string> | null)?.pipelineStrategy ??
    null
  );
}

describe("Pipeline benchmarks — DB state assertions (no rescan needed)", () => {
  test("Fox Hill: 185-215 signs", async () => {
    if (!FOX_HILL_JOB_ID || !(await jobExists(FOX_HILL_JOB_ID))) return;
    const signCount = await getJobSignCount(FOX_HILL_JOB_ID);
    expect(signCount).toBeGreaterThanOrEqual(185);
    expect(signCount).toBeLessThanOrEqual(215);
  });

  test("Walking Court_2: 300-550 signs, schedule_primary strategy", async () => {
    if (!WALKING_COURT_2_JOB_ID || !(await jobExists(WALKING_COURT_2_JOB_ID))) return;
    const signCount = await getJobSignCount(WALKING_COURT_2_JOB_ID);
    const strategy = await getJobStrategy(WALKING_COURT_2_JOB_ID);
    expect(strategy).toBe("schedule_primary");
    // AA831 is a graphically-rendered schedule; Gemini yield varies 316-395 schedule rows
    // + 51 deterministic rules-engine signs = observed range 367-446.
    // Window set to 300-550 to catch pipeline failures (e.g. 16-sign no-schedule runs)
    // while tolerating natural AI extraction variance across runs.
    expect(signCount).toBeGreaterThanOrEqual(300);
    expect(signCount).toBeLessThanOrEqual(550);
  });

  test("Gibson Lib: exactly 16 egress signs", async () => {
    if (!GIBSON_LIB_JOB_ID || !(await jobExists(GIBSON_LIB_JOB_ID))) return;
    const signCount = await getJobSignCount(GIBSON_LIB_JOB_ID);
    expect(signCount).toBe(16);
  });
});
