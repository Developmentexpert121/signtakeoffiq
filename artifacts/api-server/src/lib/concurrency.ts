/**
 * Bounded-concurrency map — Phase 1 / S2.
 *
 * Runs `fn` over `items` with at most `limit` calls in flight at once, while
 * keeping the returned array aligned to the input order (`results[i]` is the
 * result of `items[i]`). Used to parallelize per-file / per-tile pipeline loops
 * without stampeding the PDF sidecar or Gemini rate limits.
 *
 * Behaviour matches `Promise.all`: the first rejection rejects the whole call.
 * Callers that must tolerate partial failure should catch inside `fn` and
 * return a sentinel (the existing pipeline loops already swallow per-item errors
 * this way), keeping this helper simple and predictable.
 *
 * Zero dependencies — a ~classic worker-pool — so it stays trivially testable.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = items.length;
  const results = new Array<R>(n);
  if (n === 0) return results;

  // At least 1 worker; never more workers than items.
  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, n));
  let next = 0;

  async function run(): Promise<void> {
    // Each worker pulls the next index until the queue is drained.
    for (let i = next++; i < n; i = next++) {
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: workers }, () => run()));
  return results;
}
