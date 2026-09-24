/**
 * HTTP client for the Python PDF sidecar service.
 * The sidecar exposes: POST /extract-words, POST /rasterize, POST /parse-index
 *
 * Also provides GCS object-storage download helpers used by the AI vision step.
 */

import { pdfSidecarUrl } from "./config";
import { objectStorageClient } from "./objectStorage";
import { time } from "./timing";

const SIDECAR_URL = pdfSidecarUrl;
const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

export interface SidecarWord {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  page: number;
}

export interface ExtractWordsResult {
  words: SidecarWord[];
  page_width: number;
  page_height: number;
}

export interface SidecarRoomTag {
  room_number: string;
  room_name: string;
  x_pts: number;
  y_pts: number;
  bbox_x0: number;
  bbox_y0: number;
  page_w: number;
  page_h: number;
}

export interface ExtractRoomTagsResult {
  room_tags: SidecarRoomTag[];
  page_width: number;
  page_height: number;
  bbox_x0: number;
  bbox_y0: number;
}

export interface SheetEntry {
  sheet_id: string;
  sheet_title: string;
  pdf_page: number;
  sheet_type: "floor_plan" | "signage_schedule" | "egress" | "code_review" | "other";
  level: string | null;
}

export interface ParseIndexResult {
  sheets: SheetEntry[];
  drawing_index_page: number | null;
  total_pages: number;
}

export interface RasterizeResult {
  pages: string[];        // base64 PNG strings
  page_widths: number[];  // pixel width of each rendered page
  page_heights: number[]; // pixel height of each rendered page
  render_offset_x: number; // pixels of left padding (always 0)
  render_offset_y: number; // pixels of top padding (always 0)
}

const MAX_RETRIES = 3;
const BASE_TIMEOUT_MS = 60_000;
/** Extra ms per additional page when batch-rasterizing at high DPI. */
const PER_PAGE_TIMEOUT_MS = 45_000;
/** Hard cap for tiling calls (each tile set is one page). */
const RASTERIZE_TILES_TIMEOUT_MS = 180_000;

async function callSidecarWithRetry(
  url: string,
  body: FormData | Record<string, unknown>,
  attempt = 1,
  timeoutMs = BASE_TIMEOUT_MS,
  retryOnTimeout = true,
): Promise<Response> {
  const isFormData = body instanceof FormData;
  try {
    const response = await fetch(url, {
      method: "POST",
      body: isFormData ? body : JSON.stringify(body),
      headers: isFormData ? undefined : { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response;
  } catch (err) {
    // A timeout abort on a CPU-bound endpoint must NOT be retried: the sidecar's
    // work is uninterruptible and keeps running after the fetch aborts, so a retry
    // just stacks an identical run on top and starves the work semaphore. Only
    // transient connection errors benefit from a retry.
    const isTimeout = err instanceof Error && err.name === "TimeoutError";
    if (attempt >= MAX_RETRIES || (isTimeout && !retryOnTimeout)) throw err;
    const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
    console.warn(
      `[sidecar] Attempt ${attempt}/${MAX_RETRIES} failed — retrying in ${delay}ms. ` +
        `Error: ${err instanceof Error ? err.message : String(err)}`,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
    return callSidecarWithRetry(url, body, attempt + 1, timeoutMs, retryOnTimeout);
  }
}

async function postForm(
  path: string,
  formData: FormData,
  timeoutMs = BASE_TIMEOUT_MS,
  retryOnTimeout = true,
): Promise<Response> {
  const url = `${SIDECAR_URL}${path}`;
  const res = await time(
    `sidecar${path}`,
    () => callSidecarWithRetry(url, formData, 1, timeoutMs, retryOnTimeout),
    { timeoutMs },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Sidecar ${path} failed (${res.status}): ${body}`);
  }
  return res;
}

/**
 * Extract room tags from a floor plan PDF page using character stream scanning.
 * Includes nearby-word room name detection and bbox metadata for accurate pixel conversion.
 */
export async function extractRoomTags(
  pdfBuffer: Buffer,
  page: number = 1,
  filename = "file.pdf",
): Promise<ExtractRoomTagsResult> {
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(pdfBuffer)], { type: "application/pdf" }), filename);
  fd.append("page", String(page));
  const res = await postForm("/extract-room-tags", fd);
  return res.json() as Promise<ExtractRoomTagsResult>;
}

/**
 * Extract words + bounding boxes from a single PDF page.
 */
export async function extractWords(
  pdfBuffer: Buffer,
  page: number = 1,
  filename = "file.pdf",
): Promise<ExtractWordsResult> {
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(pdfBuffer)], { type: "application/pdf" }), filename);
  fd.append("page", String(page));
  const res = await postForm("/extract-words", fd);
  return res.json() as Promise<ExtractWordsResult>;
}

/**
 * Rasterize one or more PDF pages to PNG (returned as base64 strings).
 */
export async function rasterizePages(
  pdfBuffer: Buffer,
  pages: number[],
  dpi = 150,
  filename = "file.pdf",
): Promise<RasterizeResult> {
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(pdfBuffer)], { type: "application/pdf" }), filename);
  fd.append("pages", pages.join(","));
  fd.append("dpi", String(dpi));
  const timeoutMs = Math.max(BASE_TIMEOUT_MS, pages.length * PER_PAGE_TIMEOUT_MS);
  const res = await postForm("/rasterize", fd, timeoutMs);
  return res.json() as Promise<RasterizeResult>;
}

/**
 * Batch-convert specific PDF pages to PNG images in a single sidecar call.
 *
 * @param pdfBuffer   - Raw PDF file bytes.
 * @param specificPages - Page numbers (1-based) to convert. When provided, only
 *   those pages are rasterized — passing a filtered list (e.g. only the 15
 *   relevant sheets from a 100-page PDF) avoids unnecessary conversion work.
 *   If the array is empty the function returns an empty Map immediately.
 * @param dpi      - Rasterization resolution (default 150).
 * @param filename - Original filename forwarded to the sidecar for logging.
 * @returns Map<pageNumber, base64PngString> for O(1) per-page lookup.
 */
export async function batchConvertPdfToImages(
  pdfBuffer: Buffer,
  specificPages: number[],
  dpi = 150,
  filename = "file.pdf",
): Promise<Map<number, string>> {
  if (specificPages.length === 0) return new Map();
  const unique = [...new Set(specificPages)].sort((a, b) => a - b);
  const result = await rasterizePages(pdfBuffer, unique, dpi, filename);
  const pageMap = new Map<number, string>();
  unique.forEach((pageNum, idx) => {
    const base64 = result.pages[idx];
    if (base64) pageMap.set(pageNum, base64);
  });
  return pageMap;
}

/**
 * Parse the drawing index from a PDF, returning sheet metadata.
 * @param timeoutMs  Per-call timeout.  Defaults to BASE_TIMEOUT_MS (60 s).
 *                   Pass the pipeline's STEP2_TIMEOUT_MS for large files so
 *                   the sidecar call budget matches the outer timer.
 */
export async function parseDrawingIndex(
  pdfBuffer: Buffer,
  filename = "file.pdf",
  timeoutMs = BASE_TIMEOUT_MS,
): Promise<ParseIndexResult> {
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(pdfBuffer)], { type: "application/pdf" }), filename);
  const res = await postForm("/parse-index", fd, timeoutMs);
  return res.json() as Promise<ParseIndexResult>;
}

export interface ExtractTableResult {
  tables: string[][][]; // tables[tableIdx][rowIdx][colIdx]
  page: number;
  table_count: number;
}

/**
 * Extract tables from a single PDF page using pdfplumber.
 * Returns all tables found on the page with cells normalized to strings.
 *
 * @param strategy  pdfplumber detection method. "lines" (default) suits dedicated
 *   ruled schedule sheets; "text" derives the grid from word alignment and ignores
 *   vector lines — far cheaper on dense floor plans where line detection explodes.
 *   With "text" we also skip retry-on-timeout: that work is CPU-bound and
 *   uncancellable, so retrying a timeout only stacks load (see callSidecarWithRetry).
 */
export async function extractTable(
  pdfBuffer: Buffer,
  page: number = 1,
  filename = "file.pdf",
  strategy: "lines" | "text" = "lines",
  timeoutMs: number = BASE_TIMEOUT_MS,
): Promise<ExtractTableResult> {
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(pdfBuffer)], { type: "application/pdf" }), filename);
  fd.append("page", String(page));
  fd.append("strategy", strategy);
  const res = await postForm("/extract-table", fd, timeoutMs, strategy !== "text");
  return res.json() as Promise<ExtractTableResult>;
}

/**
 * Check if the sidecar is running.
 */
export async function sidecarHealthCheck(): Promise<boolean> {
  const attempts = 5;
  const perAttemptTimeoutMs = 8000;
  const backoffMs = [0, 500, 1000, 2000, 3000];
  for (let i = 0; i < attempts; i++) {
    if (backoffMs[i] > 0) {
      await new Promise((r) => setTimeout(r, backoffMs[i]));
    }
    try {
      const res = await fetch(`${SIDECAR_URL}/healthz`, {
        signal: AbortSignal.timeout(perAttemptTimeoutMs),
      });
      if (res.ok) return true;
    } catch {
      // try again
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tile-based rasterization (large/dense floor plans)
// ---------------------------------------------------------------------------

export interface RasterTile {
  base64: string;
  offsetX: number;
  offsetY: number;
  scaleX: number;
  scaleY: number;
  col: number;
  row: number;
}

export interface RasterizeTilesResult {
  tiles: RasterTile[];
  /** base64 PNG of the whole page at `fullDpi` — render the page only once. */
  fullPage: string;
  width: number;
  height: number;
}

/**
 * Rasterize a single PDF page ONCE and return both a 2×2 grid of overlapping
 * tiles AND the full page, so the caller never renders the same page twice.
 *
 * The page is rendered at `max(dpi, fullDpi)`. `fullPage` is at that resolution
 * (pass fullDpi=150 to keep it crisp for downstream text reads); the tiles are
 * downscaled to `dpi`-equivalent pixels to keep their token size small. Each
 * tile's offsetX/Y and scaleX/Y are full-page fractions (0–1), unaffected by the
 * tile downscale.
 */
export async function rasterizeTiles(
  pdfBuf: Buffer,
  pageNumber: number,
  dpi = 100,
  filename = "document.pdf",
  fullDpi = 0,
): Promise<RasterizeTilesResult> {
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(pdfBuf)], { type: "application/pdf" }), filename);
  fd.append("page", String(pageNumber));
  fd.append("dpi", String(dpi));
  if (fullDpi > 0) fd.append("full_dpi", String(fullDpi));

  const response = await time(
    "sidecar/rasterize-tiles",
    () => callSidecarWithRetry(`${SIDECAR_URL}/rasterize-tiles`, fd, 1, RASTERIZE_TILES_TIMEOUT_MS),
    { page: pageNumber, dpi },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Sidecar /rasterize-tiles failed (${response.status}): ${body}`);
  }
  const data = await response.json() as {
    tiles: Array<{
      base64: string;
      offset_x: number;
      offset_y: number;
      scale_x: number;
      scale_y: number;
      col: number;
      row: number;
    }>;
    full_page?: string;
    width?: number;
    height?: number;
  };
  return {
    tiles: data.tiles.map((t) => ({
      base64: t.base64,
      offsetX: t.offset_x,
      offsetY: t.offset_y,
      scaleX: t.scale_x,
      scaleY: t.scale_y,
      col: t.col,
      row: t.row,
    })),
    fullPage: data.full_page ?? "",
    width: data.width ?? 0,
    height: data.height ?? 0,
  };
}

// ---------------------------------------------------------------------------
// GCS object-storage helpers (used by Step 6b AI vision)
// ---------------------------------------------------------------------------

function parseObjectPath(path: string): { bucketName: string; objectName: string } {
  if (!path.startsWith("/")) {
    path = `/${path}`;
  }
  const parts = path.split("/");
  if (parts.length < 3) {
    throw new Error("Invalid object path: must contain bucket name and object name");
  }
  return {
    bucketName: parts[1],
    objectName: parts.slice(2).join("/"),
  };
}

function gcsUrlToObjectPath(url: string): string {
  const parsed = new URL(url);
  return parsed.pathname;
}

/**
 * Download a rasterized floor-plan image from GCS object storage as a Buffer.
 * Accepts either a full GCS URL or a normalised /bucket/path.
 */
export async function downloadRasterizedImage(
  rasterizedPath: string,
): Promise<{ buffer: Buffer; mediaType: "image/png" | "image/jpeg" | "image/webp" }> {
  let objectPath = rasterizedPath;

  if (rasterizedPath.startsWith("https://storage.googleapis.com/")) {
    objectPath = gcsUrlToObjectPath(rasterizedPath);
  }

  const { bucketName, objectName } = parseObjectPath(objectPath);
  const bucket = objectStorageClient.bucket(bucketName);
  const file = bucket.file(objectName);

  const [exists] = await file.exists();
  if (!exists) {
    throw new Error(`Rasterized image not found at path: ${rasterizedPath}`);
  }

  const [contents] = await file.download();
  const buffer = Buffer.from(contents);

  const lowerPath = objectPath.toLowerCase();
  let mediaType: "image/png" | "image/jpeg" | "image/webp" = "image/png";
  if (lowerPath.endsWith(".jpg") || lowerPath.endsWith(".jpeg")) {
    mediaType = "image/jpeg";
  } else if (lowerPath.endsWith(".webp")) {
    mediaType = "image/webp";
  }

  return { buffer, mediaType };
}

/**
 * Get a short-lived signed download URL for a GCS object.
 */
export async function getSignedDownloadUrl(objectPath: string, ttlSec = 3600): Promise<string> {
  const normalPath = objectPath.startsWith("/") ? objectPath : `/${objectPath}`;
  const { bucketName, objectName } = parseObjectPath(normalPath);

  const request = {
    bucket_name: bucketName,
    object_name: objectName,
    method: "GET",
    expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
  };

  const response = await fetch(
    `${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30_000),
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to get signed URL: ${response.status}`);
  }

  const data = await response.json() as { signed_url: string };
  return data.signed_url;
}
