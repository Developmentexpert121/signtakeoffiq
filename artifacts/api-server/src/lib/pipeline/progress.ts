import { db, jobsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export interface RetryEvent {
  attempt: number;
  errorType: string;
  errorMessage: string;
  stepLabel: string;
  timestamp: string;
}

export interface PipelineProgress {
  step: number | string;
  totalSteps: number;
  label: string;
  startedAt: string;
  stepStartedAt: string;
  estimatedTotalSeconds: number;
  estimatedSecondsPerSheet: number;
  retryLog: RetryEvent[];
  aiRetryMax?: number;
  effectiveBaseDelayMs?: number;
}

export interface Step6SheetResult {
  sheetId: string;
  status: "cached" | "fresh_scan" | "skipped_threshold" | "skipped_cap" | "timeout" | "skipped_filter";
}

// ---------------------------------------------------------------------------
// Sign schedule entry — shared between pipeline internals and tests
// ---------------------------------------------------------------------------

export interface PipelineStepRecord {
  step: number | string;
  label: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  status: "completed" | "running" | "failed";
  sheetResults?: Step6SheetResult[];
}

export const TOTAL_STEPS = 10;

export const ESTIMATED_TOTAL_SECONDS = 120; // fallback estimate when sheet count is unknown

export const ESTIMATED_SECONDS_PER_SHEET = 30; // per-sheet time estimate used to scale the total

function toNumericStep(step: number | string): number {
  if (typeof step === "number") return step;
  const map: Record<string, number> = { "4b": 2.5, "B": 4.5, "8.5": 8.5, "summary": 10.5 };
  return map[step] ?? 0;
}

export async function writeProgress(
  jobId: string,
  step: number | string,
  label: string,
  startedAt: string,
  steps: PipelineStepRecord[],
  retryLog: RetryEvent[] = [],
  sheetCount?: number,
  aiRetryMax?: number,
  effectiveBaseDelayMs?: number,
): Promise<PipelineProgress> {
  const now = new Date().toISOString();

  // Finalize the previously running step now that the next one is starting
  if (steps.length > 0) {
    const last = steps[steps.length - 1];
    if (last.status === "running") {
      last.completedAt = now;
      last.durationMs = new Date(now).getTime() - new Date(last.startedAt).getTime();
      last.status = "completed";
    }
  }

  // Record this new step as running
  steps.push({ step, label, startedAt: now, status: "running" });

  // Scale the estimate by sheet count when known; fall back to the fixed constant.
  const estimatedTotalSeconds = sheetCount != null && sheetCount > 0
    ? Math.max(ESTIMATED_TOTAL_SECONDS, sheetCount * ESTIMATED_SECONDS_PER_SHEET)
    : ESTIMATED_TOTAL_SECONDS;

  const progress: PipelineProgress = {
    step: toNumericStep(step),
    totalSteps: TOTAL_STEPS,
    label,
    startedAt,
    stepStartedAt: now,
    estimatedTotalSeconds,
    estimatedSecondsPerSheet: ESTIMATED_SECONDS_PER_SHEET,
    retryLog,
    ...(aiRetryMax !== undefined && { aiRetryMax }),
    ...(effectiveBaseDelayMs !== undefined && { effectiveBaseDelayMs }),
  };
  await db.update(jobsTable)
    .set({ metadata: { progress, steps, estimatedSecondsPerSheet: ESTIMATED_SECONDS_PER_SHEET, processingStartedAt: startedAt } as Record<string, unknown> })
    .where(eq(jobsTable.id, jobId));
  return progress;
}

// ---------------------------------------------------------------------------
// Object-storage helpers
// ---------------------------------------------------------------------------

// Parse PRIVATE_OBJECT_DIR into its component parts so we can write to the
// same path that ObjectStorageService.getObjectEntityFile() will look for.
// PRIVATE_OBJECT_DIR format: /bucket-name[/optional-prefix]
