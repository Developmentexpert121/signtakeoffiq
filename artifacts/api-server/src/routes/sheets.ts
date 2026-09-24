import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { jobSheetsTable, roomsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "../lib/tenantAuth";

const router: IRouter = Router();

router.get("/jobs/:jobId/sheets", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const jobId = String(req.params.jobId);

  const [sheets, aiVisionRooms] = await Promise.all([
    db.select().from(jobSheetsTable)
      .where(and(eq(jobSheetsTable.jobId, jobId), eq(jobSheetsTable.tenantId, tenantId))),
    db.select({ sheetId: roomsTable.sheetId }).from(roomsTable)
      .where(and(
        eq(roomsTable.jobId, jobId),
        eq(roomsTable.tenantId, tenantId),
        eq(roomsTable.source, "ai_vision"),
      )),
  ]);

  const cachedSheetIds = new Set(aiVisionRooms.map((r) => r.sheetId).filter(Boolean));

  res.json(sheets.map((s) => ({ ...s, hasCachedResult: cachedSheetIds.has(s.id) })));
});

router.get("/jobs/:jobId/sheets/:sheetId", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const jobId = String(req.params.jobId);
  const sheetId = String(req.params.sheetId);

  const [[sheet], aiVisionRooms] = await Promise.all([
    db.select().from(jobSheetsTable)
      .where(and(
        eq(jobSheetsTable.jobId, jobId),
        eq(jobSheetsTable.tenantId, tenantId),
        eq(jobSheetsTable.id, sheetId),
      )),
    db.select({ id: roomsTable.id }).from(roomsTable)
      .where(and(
        eq(roomsTable.jobId, jobId),
        eq(roomsTable.tenantId, tenantId),
        eq(roomsTable.sheetId, sheetId),
        eq(roomsTable.source, "ai_vision"),
      ))
      .limit(1),
  ]);

  if (!sheet) {
    res.status(404).json({ error: "Sheet not found" });
    return;
  }

  res.json({ ...sheet, hasCachedResult: aiVisionRooms.length > 0 });
});

export default router;
