import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { jobsTable } from "@workspace/db";
import { eq, desc, type SQL } from "drizzle-orm";
import { requireAuth, isSuperAdmin } from "../lib/tenantAuth";

const router: IRouter = Router();

router.get("/dashboard/summary", requireAuth, async (req, res): Promise<void> => {
  const { tenantId, role } = req.auth_ctx!;
  const tenantFilter: SQL | undefined = isSuperAdmin(role) ? undefined : eq(jobsTable.tenantId, tenantId);

  const jobs = await db.select().from(jobsTable).where(tenantFilter);

  const totalJobs = jobs.length;
  const activeJobs = jobs.filter(j => j.status === "processing" || j.status === "pending").length;
  const completedJobs = jobs.filter(j => j.status === "completed").length;
  const totalSigns = jobs.reduce((acc, j) => acc + j.totalSigns, 0);
  const totalHighConfidence = jobs.reduce((acc, j) => acc + j.highConfidence, 0);
  const totalNeedsReview = jobs.reduce((acc, j) => acc + j.needsReview, 0);
  const totalAiCost = jobs.reduce((acc, j) => acc + parseFloat(String(j.aiTokenCost || "0")), 0);

  res.json({
    totalJobs,
    activeJobs,
    completedJobs,
    totalSigns,
    totalHighConfidence,
    totalNeedsReview,
    totalAiCost,
  });
});

router.get("/dashboard/recent-jobs", requireAuth, async (req, res): Promise<void> => {
  const { tenantId, role } = req.auth_ctx!;
  const limit = req.query.limit ? parseInt(String(req.query.limit)) : 5;
  const tenantFilter: SQL | undefined = isSuperAdmin(role) ? undefined : eq(jobsTable.tenantId, tenantId);

  const jobs = await db
    .select()
    .from(jobsTable)
    .where(tenantFilter)
    .orderBy(desc(jobsTable.updatedAt))
    .limit(limit);

  res.json(jobs.map(j => ({
    ...j,
    aiTokenCost: parseFloat(String(j.aiTokenCost || "0")),
    metadata: j.metadata || {},
  })));
});

export default router;
