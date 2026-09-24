import { db } from "@workspace/db";
import { signsTable, jobsTable, roomsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

/**
 * Compute live sign counts directly from the database.
 *
 * This is the single source of truth for Overview metrics.  It exactly
 * mirrors the logic in GET /api/jobs/:jobId/counts so that the cached
 * job row and the live endpoint always return the same numbers:
 *
 *   • Only non-deleted signs (isDeleted = false)
 *   • Exterior-source signs excluded
 *   • Signs whose room is dismissed excluded
 *   • High-confidence threshold: confidence >= 0.75
 *   • All qty values are summed (not row-counted)
 */
export async function computeLiveSignCounts(
  jobId: string,
  tenantId: string,
): Promise<{ totalSigns: number; highConfidence: number; needsReview: number }> {
  const rows = await db
    .select({
      qty: signsTable.qty,
      confidence: signsTable.confidence,
      source: signsTable.source,
      reviewStatus: roomsTable.reviewStatus,
    })
    .from(signsTable)
    .leftJoin(roomsTable, eq(signsTable.roomId, roomsTable.id))
    .where(
      and(
        eq(signsTable.jobId, jobId),
        eq(signsTable.tenantId, tenantId),
        eq(signsTable.isDeleted, false),
      ),
    );

  const filtered = rows.filter(
    (r) => r.source !== "exterior" && r.reviewStatus !== "dismissed",
  );

  let totalSigns = 0;
  let highConfidence = 0;
  let needsReview = 0;

  for (const r of filtered) {
    const qty = r.qty ?? 1;
    const conf = parseFloat(String(r.confidence ?? "0.5"));
    totalSigns += qty;
    if (conf >= 0.75) highConfidence += qty;
    else needsReview += qty;
  }

  return { totalSigns, highConfidence, needsReview };
}

/**
 * Recompute live sign counts and persist them to the jobs table.
 *
 * Call this after any operation that adds, removes, or changes signs so
 * that job.totalSigns / highConfidence / needsReview never drift from the
 * live /counts endpoint.
 */
export async function syncJobSignCounts(
  jobId: string,
  tenantId: string,
): Promise<{ totalSigns: number; highConfidence: number; needsReview: number }> {
  const counts = await computeLiveSignCounts(jobId, tenantId);

  await db
    .update(jobsTable)
    .set({
      totalSigns: counts.totalSigns,
      highConfidence: counts.highConfidence,
      needsReview: counts.needsReview,
      updatedAt: new Date(),
    })
    .where(and(eq(jobsTable.id, jobId), eq(jobsTable.tenantId, tenantId)));

  console.log(
    `[sign-count] synced job ${jobId}: total=${counts.totalSigns} high=${counts.highConfidence} review=${counts.needsReview}`,
  );

  return counts;
}
