import express, { Router, type IRouter, type Request, type Response } from "express";
import { Readable } from "stream";
import {
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
} from "@workspace/api-zod";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { requireAuth } from "../lib/tenantAuth";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

/**
 * POST /storage/uploads/request-url
 *
 * Request a presigned URL for file upload.
 * The client sends JSON metadata (name, size, contentType) — NOT the file.
 * Then uploads the file directly to the returned presigned URL.
 * Files are stored under a tenant-scoped prefix so cleanup can sweep them
 * entirely with a prefix listing.
 */
router.post("/storage/uploads/request-url", requireAuth, async (req: Request, res: Response) => {
  const parsed = RequestUploadUrlBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing or invalid required fields" });
    return;
  }

  try {
    const { name, size, contentType } = parsed.data;
    const tenantId = req.auth_ctx!.tenantId;

    const uploadURL = await objectStorageService.getObjectEntityUploadURL(tenantId);
    const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);

    res.json(
      RequestUploadUrlResponse.parse({
        uploadURL,
        objectPath,
        metadata: { name, size, contentType },
      }),
    );
  } catch (error) {
    req.log.error({ err: error }, "Error generating upload URL");
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

/**
 * POST /storage/uploads/direct
 *
 * Server-side upload fallback. The client streams the raw file bytes here and
 * the API writes them to object storage, returning the same `objectPath` the
 * presigned-PUT flow yields. Used when the browser → storage PUT is blocked by
 * a missing CORS rule on the bucket (common in local dev against DO Spaces).
 * The file transits the API, so no browser CORS preflight is involved.
 */
router.post(
  "/storage/uploads/direct",
  requireAuth,
  express.raw({ type: () => true, limit: "210mb" }),
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.auth_ctx!.tenantId;
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        res.status(400).json({ error: "Empty or invalid upload body" });
        return;
      }
      const contentType =
        req.header("x-upload-content-type") ||
        req.header("content-type") ||
        "application/pdf";

      const objectPath = await objectStorageService.uploadObjectEntityFromBuffer(body, {
        contentType,
        tenantId,
      });
      res.json({ objectPath });
    } catch (error) {
      req.log.error({ err: error }, "Error in direct upload");
      res.status(500).json({ error: "Failed to upload file" });
    }
  },
);

/**
 * GET /storage/public-objects/*
 *
 * Serve public assets from PUBLIC_OBJECT_SEARCH_PATHS.
 * These are unconditionally public — no authentication or ACL checks.
 * IMPORTANT: Always provide this endpoint when object storage is set up.
 */
router.get("/storage/public-objects/*filePath", async (req: Request, res: Response) => {
  try {
    const raw = req.params.filePath;
    const filePath = Array.isArray(raw) ? raw.join("/") : raw;
    const file = await objectStorageService.searchPublicObject(filePath);
    if (!file) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    const response = await objectStorageService.downloadObject(file);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    req.log.error({ err: error }, "Error serving public object");
    res.status(500).json({ error: "Failed to serve public object" });
  }
});

/**
 * GET /storage/objects/*
 *
 * Serve private object entities from PRIVATE_OBJECT_DIR.
 * Requires authentication. The requested path must be scoped to the
 * authenticated tenant's directory (tenants/<tenantId>/...) so that
 * tenants cannot read each other's files.
 */
router.get("/storage/objects/*path", requireAuth, async (req: Request, res: Response) => {
  try {
    const raw = req.params.path;
    const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;

    const tenantId = req.auth_ctx!.tenantId;
    const tenantPrefix = `tenants/${tenantId}/`;
    if (!wildcardPath.startsWith(tenantPrefix)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const objectPath = `/objects/${wildcardPath}`;
    const objectFile = await objectStorageService.getObjectEntityFile(objectPath);

    const response = await objectStorageService.downloadObject(objectFile);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      req.log.warn({ err: error }, "Object not found");
      res.status(404).json({ error: "Object not found" });
      return;
    }
    req.log.error({ err: error }, "Error serving object");
    res.status(500).json({ error: "Failed to serve object" });
  }
});

export default router;
