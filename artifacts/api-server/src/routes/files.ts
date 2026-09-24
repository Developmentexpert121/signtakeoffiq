import { Router, type IRouter } from "express";
import { PDFDocument } from "pdf-lib";
import { db } from "@workspace/db";
import { jobFilesTable, jobsTable } from "@workspace/db";
import { eq, and, desc, count } from "drizzle-orm";
import { requireAuth, touchGuestLastActive } from "../lib/tenantAuth";
import { newId } from "../lib/ids";
import { downloadFromGoogleDrive } from "../lib/googleDriveDownload";
import { ObjectStorageService } from "../lib/objectStorage";
import { logger } from "../lib/logger";

const objectStorageService = new ObjectStorageService();

const router: IRouter = Router();

router.get("/jobs/:jobId/files", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const jobId = String(req.params.jobId);

  const files = await db.select().from(jobFilesTable)
    .where(and(eq(jobFilesTable.jobId, jobId), eq(jobFilesTable.tenantId, tenantId)))
    .orderBy(desc(jobFilesTable.createdAt));

  res.json(files);
});

router.post("/jobs/:jobId/files", requireAuth, async (req, res): Promise<void> => {
  const { tenantId, role } = req.auth_ctx!;
  const jobId = String(req.params.jobId);

  const { filename, storagePath, fileSizeBytes, fileCategory, floorLabel } = req.body;
  if (!filename || !storagePath) {
    res.status(400).json({ error: "filename and storagePath required" });
    return;
  }

  const [file] = await db.insert(jobFilesTable).values({
    id: newId("file"),
    jobId,
    tenantId,
    filename,
    storagePath,
    fileSizeBytes: fileSizeBytes || null,
    fileCategory: fileCategory || null,
    floorLabel: floorLabel || null,
  }).returning();

  const filesCount = await db.select({ count: count() }).from(jobFilesTable).where(eq(jobFilesTable.jobId, jobId));
  await db.update(jobsTable)
    .set({ fileCount: filesCount[0]?.count || 0 })
    .where(and(eq(jobsTable.id, jobId), eq(jobsTable.tenantId, tenantId)));

  await touchGuestLastActive(tenantId, role);

  res.status(201).json(file);
});

router.delete("/jobs/:jobId/files/:fileId", requireAuth, async (req, res): Promise<void> => {
  const { tenantId, role } = req.auth_ctx!;
  const jobId = String(req.params.jobId);
  const fileId = String(req.params.fileId);

  const [deleted] = await db.delete(jobFilesTable)
    .where(and(eq(jobFilesTable.id, fileId), eq(jobFilesTable.jobId, jobId), eq(jobFilesTable.tenantId, tenantId)))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "File not found" });
    return;
  }

  const filesCount = await db.select({ count: count() }).from(jobFilesTable).where(eq(jobFilesTable.jobId, jobId));
  await db.update(jobsTable)
    .set({ fileCount: filesCount[0]?.count || 0 })
    .where(and(eq(jobsTable.id, jobId), eq(jobsTable.tenantId, tenantId)));

  await touchGuestLastActive(tenantId, role);
  res.json({ deleted: true });
});

router.post("/jobs/:jobId/files/drive", requireAuth, async (req, res): Promise<void> => {
  const { tenantId, role } = req.auth_ctx!;
  const jobId = String(req.params.jobId);
  const { driveUrl, fileCategory, floorLabel } = req.body;

  if (!driveUrl || typeof driveUrl !== "string") {
    res.status(400).json({ error: "driveUrl is required" });
    return;
  }

  try {
    const { buffer, filename, contentType, sizeBytes } = await downloadFromGoogleDrive(driveUrl);

    const uploadURL = await objectStorageService.getObjectEntityUploadURL(tenantId);
    const putRes = await fetch(uploadURL, {
      method: "PUT",
      body: buffer,
      headers: { "Content-Type": contentType },
    });
    if (!putRes.ok) throw new Error(`Failed to upload to object storage: ${putRes.status}`);

    const storagePath = objectStorageService.normalizeObjectEntityPath(uploadURL);

    // Detect actual page count using pdf-lib (handles compressed/cross-ref PDFs
    // that the old 500 KB /Type /Page regex would under-count or miss entirely).
    let detectedPageCount: number | null = null;
    try {
      const pdfDoc = await PDFDocument.load(buffer, {
        ignoreEncryption: true,
        updateMetadata: false,
      });
      detectedPageCount = pdfDoc.getPageCount();
    } catch {
      // Fallback: regex on full buffer if pdf-lib fails to parse
      const fullPdfStr = buffer.toString("binary");
      const pageMatches = fullPdfStr.match(/\/Type\s*\/Page[^s]/g);
      detectedPageCount = (pageMatches && pageMatches.length > 0)
        ? pageMatches.length
        : null;
    }
    logger.info(`[jobs] Drive upload: ${filename} — ${(buffer.length / 1024 / 1024).toFixed(1)} MB, detected ${detectedPageCount ?? "unknown"} pages`);

    const [file] = await db.insert(jobFilesTable).values({
      id: newId("file"),
      jobId,
      tenantId,
      filename,
      storagePath,
      fileSizeBytes: sizeBytes,
      fileCategory: fileCategory || null,
      floorLabel: floorLabel || null,
      pageCount: detectedPageCount,
    }).returning();

    const filesCount = await db.select({ count: count() }).from(jobFilesTable).where(eq(jobFilesTable.jobId, jobId));
    await db.update(jobsTable)
      .set({ fileCount: filesCount[0]?.count || 0 })
      .where(and(eq(jobsTable.id, jobId), eq(jobsTable.tenantId, tenantId)));

    await touchGuestLastActive(tenantId, role);

    res.status(201).json({ ...file, sizeMB: parseFloat((sizeBytes / 1024 / 1024).toFixed(1)) });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to download from Google Drive";
    res.status(400).json({ error: message });
  }
});

router.patch("/jobs/:jobId/files/:fileId", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const jobId = String(req.params.jobId);
  const fileId = String(req.params.fileId);
  const { fileCategory, floorLabel } = req.body;

  const [updated] = await db.update(jobFilesTable)
    .set({
      fileCategory: fileCategory ?? null,
      ...(floorLabel !== undefined ? { floorLabel: floorLabel || null } : {}),
    })
    .where(and(eq(jobFilesTable.id, fileId), eq(jobFilesTable.jobId, jobId), eq(jobFilesTable.tenantId, tenantId)))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "File not found" });
    return;
  }
  res.json(updated);
});

export default router;
