import { objectStorageClient } from "../objectStorage";

const _GCS_DIR = (() => {
  const raw = (process.env.PRIVATE_OBJECT_DIR ?? "").replace(/^\//, "").replace(/\/$/, "");
  if (!raw) return null;
  const parts = raw.split("/");
  return {
    bucket: parts[0],
    prefix: parts.slice(1).join("/"), // empty string when no prefix
  };
})();

const GCS_BUCKET = _GCS_DIR?.bucket ?? null;

const GCS_PREFIX = _GCS_DIR?.prefix ?? "";

/**
 * Download a file from GCS using the normalised /objects/ path stored in the DB.
 * Uploaded files live at: <bucket>/<prefix>/<objectPath>
 * (where objectPath = the path after /objects/ in the stored reference)
 */

export async function downloadFromStorage(storagePath: string): Promise<Buffer> {
  if (!GCS_BUCKET) throw new Error("PRIVATE_OBJECT_DIR not set");

  // storagePath may be "/objects/uploads/<uuid>" (upload) or "/objects/rasterized/..." (pipeline)
  const entityId = storagePath.replace(/^\/objects\//, "").replace(/^\//, "");
  const gcsPath = GCS_PREFIX ? `${GCS_PREFIX}/${entityId}` : entityId;

  const bucket = objectStorageClient.bucket(GCS_BUCKET);
  const [buf] = await bucket.file(gcsPath).download().catch(async () => {
    // Fallback: try with explicit uploads/ prefix (legacy upload path)
    const [alt] = await bucket.file(GCS_PREFIX ? `${GCS_PREFIX}/uploads/${entityId}` : `uploads/${entityId}`).download();
    return [alt];
  });
  return buf as Buffer;
}

/**
 * Upload a buffer to GCS at a path that mirrors ObjectStorageService's convention:
 *   GCS path: <prefix>/<path>  (inside the PRIVATE_OBJECT_DIR bucket)
 *   Stored reference: /objects/<path>   (served via GET /storage/objects/<path>)
 *
 * When tenantId is provided the path is stored under a tenant-scoped prefix
 * (tenants/<tenantId>/<path>) so that guest cleanup can sweep all tenant
 * objects with a single bucket prefix listing.
 *
 * getObjectEntityFile("/objects/<path>") resolves to:
 *   <PRIVATE_OBJECT_DIR>/<path>  →  bucket=<GCS_BUCKET>, object=<GCS_PREFIX>/<path>
 */

export async function uploadToStorage(
  path: string,
  buffer: Buffer,
  contentType = "image/png",
  tenantId?: string,
): Promise<string> {
  if (!GCS_BUCKET) throw new Error("PRIVATE_OBJECT_DIR not set");

  const scopedPath = tenantId ? `tenants/${tenantId}/${path}` : path;
  const gcsObjectName = GCS_PREFIX ? `${GCS_PREFIX}/${scopedPath}` : scopedPath;
  const bucket = objectStorageClient.bucket(GCS_BUCKET);
  await bucket.file(gcsObjectName).save(buffer, { contentType, resumable: false });
  return `/objects/${scopedPath}`;
}

// ---------------------------------------------------------------------------
// Room synonym expansion map
// ---------------------------------------------------------------------------
