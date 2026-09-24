/**
 * Lightweight per-job timing instrumentation — Phase 0 / "S7".
 *
 * Goal: make it obvious WHERE a job spends its 10–15 minutes. Today the pipeline
 * only records coarse, step-level durations (jobs.metadata.steps[]), so a slow
 * step could be the sidecar, Gemini, or the DB and you can't tell which. This
 * module times each individual sidecar call and each Gemini call.
 *
 * Design notes:
 *  - AsyncLocalStorage keeps ONE bucket of records per in-flight job. Up to
 *    MAX_CONCURRENT_PIPELINES jobs (configurable; default 4) can run at once, so
 *    a simple module-level array would interleave timings from different jobs —
 *    ALS isolates them and propagates across awaits into sidecar-client without
 *    threading a jobId through every function signature.
 *  - `time()` wraps a single async op, records its wall-clock duration (including
 *    any internal retries), and emits a live `[timing] <op> <ms>ms` line so the
 *    run can be tailed.
 *  - At job end the pipeline calls getTimingSummary()/formatTimingSummary() to log
 *    and persist an aggregate breakdown into jobs.metadata.timing.
 *
 * Disable with PIPELINE_TIMING=false (every helper becomes a near-zero-cost
 * passthrough). On by default.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface TimingRecord {
  /** Operation label, e.g. "sidecar/rasterize" or "gemini:gemini-2.5-pro". */
  op: string;
  /** Wall-clock duration in milliseconds (rounded). */
  ms: number;
  /** Whether the wrapped op resolved (true) or threw (false). */
  ok: boolean;
  /** Optional structured context (pages, dpi, model, …). */
  meta?: Record<string, unknown>;
  /** ISO timestamp the op finished. */
  at: string;
}

interface TimingContext {
  jobId: string;
  records: TimingRecord[];
  logLines: string[];
}

const storage = new AsyncLocalStorage<TimingContext>();
const ENABLED = process.env.PIPELINE_TIMING !== "false";

/** Establish a per-job timing context for the duration of `fn`. */
export function runWithTiming<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
  if (!ENABLED) return fn();
  return storage.run({ jobId, records: [], logLines: [] }, fn);
}

/** Append a console line to the current job's log buffer (no-op outside a job context). */
export function appendLogLine(line: string): void {
  storage.getStore()?.logLines.push(line);
}

/** All buffered log lines for the current job context (empty outside one). */
export function getLogLines(): string[] {
  return storage.getStore()?.logLines ?? [];
}

/** Push a record into the current job's bucket (no-op outside a job context). */
export function recordTiming(op: string, ms: number, ok: boolean, meta?: Record<string, unknown>): void {
  const ctx = storage.getStore();
  if (!ctx) return;
  ctx.records.push({ op, ms: Math.round(ms), ok, meta, at: new Date().toISOString() });
}

/**
 * Time a single async operation. Records its wall-clock duration (retries
 * included) and emits one live log line. Re-throws on error after recording it
 * as a failure, so callers see identical behaviour to calling `fn` directly.
 */
export async function time<T>(
  op: string,
  fn: () => Promise<T>,
  meta?: Record<string, unknown>,
): Promise<T> {
  if (!ENABLED) return fn();
  const start = Date.now();
  let ok = true;
  try {
    return await fn();
  } catch (err) {
    ok = false;
    throw err;
  } finally {
    const ms = Date.now() - start;
    recordTiming(op, ms, ok, meta);
    const metaStr = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
    console.log(`[timing] ${op} ${Math.round(ms)}ms${ok ? "" : " FAILED"}${metaStr}`);
  }
}

/** Raw records for the current job context (empty outside one). */
export function getTimingRecords(): TimingRecord[] {
  return storage.getStore()?.records ?? [];
}

export interface OpSummary {
  op: string;
  count: number;
  totalMs: number;
  avgMs: number;
  maxMs: number;
  failures: number;
}

export interface TimingSummary {
  totalTrackedMs: number;
  callCount: number;
  byOp: OpSummary[];
}

/** Aggregate raw records by op, sorted by total time descending. Pure → testable. */
export function summarizeTimings(records: TimingRecord[]): TimingSummary {
  const byOp = new Map<string, OpSummary>();
  let totalTrackedMs = 0;
  for (const r of records) {
    totalTrackedMs += r.ms;
    const s = byOp.get(r.op) ?? { op: r.op, count: 0, totalMs: 0, avgMs: 0, maxMs: 0, failures: 0 };
    s.count += 1;
    s.totalMs += r.ms;
    s.maxMs = Math.max(s.maxMs, r.ms);
    if (!r.ok) s.failures += 1;
    byOp.set(r.op, s);
  }
  const ops = [...byOp.values()]
    .map((s) => ({ ...s, avgMs: Math.round(s.totalMs / Math.max(1, s.count)) }))
    .sort((a, b) => b.totalMs - a.totalMs);
  return { totalTrackedMs: Math.round(totalTrackedMs), callCount: records.length, byOp: ops };
}

/** Summary for the current job context. */
export function getTimingSummary(): TimingSummary {
  return summarizeTimings(getTimingRecords());
}

/** Render a human-readable block for the logs. */
export function formatTimingSummary(summary: TimingSummary, jobId?: string): string {
  const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const lines: string[] = [
    `[timing] ===== Job ${jobId ?? ""} breakdown — ${sec(summary.totalTrackedMs)} tracked across ${summary.callCount} call(s) =====`,
  ];
  for (const s of summary.byOp) {
    lines.push(
      `[timing]   ${s.op.padEnd(28)} ${String(s.count).padStart(3)}x  total ${sec(s.totalMs).padStart(8)}  avg ${String(s.avgMs).padStart(6)}ms  max ${String(s.maxMs).padStart(6)}ms${s.failures ? `  (${s.failures} failed)` : ""}`,
    );
  }
  return lines.join("\n");
}
