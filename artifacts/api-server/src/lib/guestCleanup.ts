import { db } from "@workspace/db";
import { tenantsTable, jobFilesTable, jobSheetsTable, guestCleanupRunsTable, systemSettingsTable } from "@workspace/db";
import { and, lt, like, sql, inArray, desc, not } from "drizzle-orm";
import { logger } from "./logger";
import { GUEST_SESSION_TTL_MS, GUEST_TENANT_PREFIX } from "./guestAuth";
import { objectStorageClient } from "./objectStorage";

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

const _cleanupHistoryMaxAgeDays = parseInt(process.env.CLEANUP_HISTORY_MAX_AGE_DAYS ?? "90", 10);
const _maxAgeDaysValid = Number.isFinite(_cleanupHistoryMaxAgeDays) && _cleanupHistoryMaxAgeDays > 0;
let _runtimeMaxAgeDays = _maxAgeDaysValid ? _cleanupHistoryMaxAgeDays : 90;
export const getCleanupHistoryMaxAgeDays = () => _runtimeMaxAgeDays;
/** True when no CLEANUP_HISTORY_MAX_AGE_DAYS env var was provided at startup (server is using the built-in default). */
export const cleanupHistoryMaxAgeDaysIsDefault =
  process.env.CLEANUP_HISTORY_MAX_AGE_DAYS === undefined || process.env.CLEANUP_HISTORY_MAX_AGE_DAYS === "";
/** @deprecated Use getCleanupHistoryMaxAgeDays() for the live value. Kept for backward compat. */
export const cleanupHistoryMaxAgeDays = _runtimeMaxAgeDays;
export function setCleanupHistoryMaxAgeDays(days: number): void {
  _runtimeMaxAgeDays = days;
}

const _cleanupHistoryMaxRows = parseInt(process.env.CLEANUP_HISTORY_MAX_ROWS ?? "1000", 10);
const _maxRowsValid = Number.isFinite(_cleanupHistoryMaxRows) && _cleanupHistoryMaxRows > 0;
let _runtimeMaxRows = _maxRowsValid ? _cleanupHistoryMaxRows : 1000;
export const getCleanupHistoryMaxRows = () => _runtimeMaxRows;
/** True when no CLEANUP_HISTORY_MAX_ROWS env var was provided at startup (server is using the built-in default). */
export const cleanupHistoryMaxRowsIsDefault =
  process.env.CLEANUP_HISTORY_MAX_ROWS === undefined || process.env.CLEANUP_HISTORY_MAX_ROWS === "";
/** @deprecated Use getCleanupHistoryMaxRows() for the live value. Kept for backward compat. */
export const cleanupHistoryMaxRows = _runtimeMaxRows;
export function setCleanupHistoryMaxRows(rows: number): void {
  _runtimeMaxRows = rows;
}

const RETENTION_SETTINGS_KEY = "cleanup_retention";

/**
 * Persists the current runtime retention settings to the database so they
 * survive server restarts. Called by the admin PATCH /admin/config endpoint.
 */
export async function persistCleanupRetentionSettings(): Promise<void> {
  try {
    await db
      .insert(systemSettingsTable)
      .values({
        key: RETENTION_SETTINGS_KEY,
        value: {
          cleanupHistoryMaxAgeDays: _runtimeMaxAgeDays,
          cleanupHistoryMaxRows: _runtimeMaxRows,
        },
      })
      .onConflictDoUpdate({
        target: systemSettingsTable.key,
        set: {
          value: {
            cleanupHistoryMaxAgeDays: _runtimeMaxAgeDays,
            cleanupHistoryMaxRows: _runtimeMaxRows,
          },
          updatedAt: new Date(),
        },
      });
  } catch (err) {
    logger.warn({ err }, "Failed to persist cleanup retention settings to DB");
  }
}

/**
 * Loads retention settings from the database and applies them to the runtime
 * variables. Called once at startup before the cleanup job begins so that
 * admin-configured values survive server restarts instead of reverting to
 * env-var defaults.
 */
export async function loadCleanupRetentionSettings(): Promise<void> {
  try {
    const [row] = await db
      .select()
      .from(systemSettingsTable)
      .where(sql`${systemSettingsTable.key} = ${RETENTION_SETTINGS_KEY}`);

    if (!row) return;

    const stored = row.value as Record<string, unknown>;

    const storedMaxAgeDays = stored?.cleanupHistoryMaxAgeDays;
    if (Number.isInteger(storedMaxAgeDays) && (storedMaxAgeDays as number) > 0) {
      _runtimeMaxAgeDays = storedMaxAgeDays as number;
      logger.info({ cleanupHistoryMaxAgeDays: _runtimeMaxAgeDays }, "Loaded cleanup retention max-age-days from DB");
    }

    const storedMaxRows = stored?.cleanupHistoryMaxRows;
    if (Number.isInteger(storedMaxRows) && (storedMaxRows as number) > 0) {
      _runtimeMaxRows = storedMaxRows as number;
      logger.info({ cleanupHistoryMaxRows: _runtimeMaxRows }, "Loaded cleanup retention max-rows from DB");
    }
  } catch (err) {
    logger.warn({ err }, "Failed to load cleanup retention settings from DB — using env-var/default values");
  }
}

// Parse PRIVATE_OBJECT_DIR into bucket + optional prefix (mirrors pipeline.ts)
const _GCS_DIR = (() => {
  const raw = (process.env.PRIVATE_OBJECT_DIR ?? "").replace(/^\//, "").replace(/\/$/, "");
  if (!raw) return null;
  const parts = raw.split("/");
  return {
    bucket: parts[0],
    prefix: parts.slice(1).join("/"),
  };
})();

const GCS_BUCKET = _GCS_DIR?.bucket ?? null;
const GCS_PREFIX = _GCS_DIR?.prefix ?? "";

export interface CleanupStorageResult {
  filesDeleted: number;
  bytesRecovered: number;
}

export interface CleanupRunResult {
  tenantsDeleted: number;
  filesDeleted: number;
  bytesRecovered: number;
  ranAt: string;
}

async function persistCleanupRun(result: CleanupRunResult): Promise<void> {
  try {
    await db.insert(guestCleanupRunsTable).values({
      id: crypto.randomUUID(),
      tenantsDeleted: result.tenantsDeleted,
      filesDeleted: result.filesDeleted,
      bytesRecovered: result.bytesRecovered,
      ranAt: new Date(result.ranAt),
    });
  } catch (err) {
    logger.warn({ err }, "Failed to persist cleanup run to DB");
  }
}

export async function getLastCleanupResult(): Promise<CleanupRunResult | null> {
  try {
    const [row] = await db
      .select()
      .from(guestCleanupRunsTable)
      .orderBy(desc(guestCleanupRunsTable.ranAt))
      .limit(1);
    if (row) {
      return {
        tenantsDeleted: row.tenantsDeleted,
        filesDeleted: row.filesDeleted,
        bytesRecovered: row.bytesRecovered,
        ranAt: row.ranAt.toISOString(),
      };
    }
  } catch (err) {
    logger.warn({ err }, "Failed to load last cleanup result from DB");
  }
  return null;
}

export async function getCleanupHistory(limit = 20): Promise<CleanupRunResult[]> {
  try {
    const rows = await db
      .select()
      .from(guestCleanupRunsTable)
      .orderBy(desc(guestCleanupRunsTable.ranAt))
      .limit(limit);
    return rows.map((r) => ({
      tenantsDeleted: r.tenantsDeleted,
      filesDeleted: r.filesDeleted,
      bytesRecovered: r.bytesRecovered,
      ranAt: r.ranAt.toISOString(),
    }));
  } catch (err) {
    logger.warn({ err }, "Failed to load cleanup history from DB");
    return [];
  }
}


/**
 * Build the GCS object prefix for a tenant's scoped storage directory.
 * New files are written under tenants/<tenantId>/ by the upload endpoint
 * and the pipeline, making it possible to sweep all tenant objects with
 * a single bucket prefix listing.
 */
function tenantGcsPrefix(tenantId: string): string {
  const dir = `tenants/${tenantId}/`;
  return GCS_PREFIX ? `${GCS_PREFIX}/${dir}` : dir;
}

/**
 * Convert a stored /objects/<path> reference to its GCS object name.
 * Used for the legacy (pre-prefix) compat fallback.
 */
function toGcsObjectName(storagePath: string): string {
  const entityId = storagePath.replace(/^\/objects\//, "").replace(/^\//, "");
  return GCS_PREFIX ? `${GCS_PREFIX}/${entityId}` : entityId;
}

/**
 * Delete all object-storage files belonging to the given tenant IDs.
 * Returns the total number of files deleted and bytes recovered.
 *
 * Strategy:
 *  1. PRIMARY — prefix listing: list and delete every object under
 *     tenants/<tenantId>/ for each expired tenant. This sweeps all files
 *     written since the tenant-scoped prefix was introduced.
 *  2. COMPAT FALLBACK — DB-reference deletion: also delete any paths recorded
 *     in job_files.storage_path / job_sheets.rasterized_path that do NOT sit
 *     under the tenant prefix (legacy files written before prefix adoption).
 *
 * Audit (pipeline.ts uploadToStorage call-sites):
 *  - Step 3 (rasterize): writes rasterized/<jobId>/<sheetId>.png scoped under
 *    tenants/<tenantId>/ and records the path in job_sheets.rasterized_path.
 *    → covered by both the prefix sweep (1) and the legacy fallback (2).
 *  - Steps 4 & 7 (Claude vision): rasterize pages in-memory only; no storage
 *    writes occur — nothing to clean up.
 *  All pipeline-generated objects are therefore fully covered by this cleanup.
 */
async function deleteStorageForTenants(tenantIds: string[]): Promise<CleanupStorageResult> {
  if (!GCS_BUCKET || tenantIds.length === 0) return { filesDeleted: 0, bytesRecovered: 0 };

  const bucket = objectStorageClient.bucket(GCS_BUCKET);

  let prefixDeleted = 0;
  let prefixFailed = 0;
  let totalBytesRecovered = 0;

  // 1. PRIMARY: prefix-based sweep
  for (const tenantId of tenantIds) {
    const prefix = tenantGcsPrefix(tenantId);
    try {
      const [files] = await bucket.getFiles({ prefix });
      await Promise.all(
        files.map(async (file) => {
          try {
            // Fetch size before deleting so we can track bytes recovered
            let fileSize = 0;
            try {
              const [metadata] = await file.getMetadata();
              fileSize = Number(metadata.size ?? 0);
            } catch {
              // Non-fatal: proceed with deletion even if metadata fetch fails
            }
            await file.delete({ ignoreNotFound: true });
            prefixDeleted++;
            totalBytesRecovered += fileSize;
          } catch (err) {
            prefixFailed++;
            logger.warn({ err, objectName: file.name }, "Failed to delete guest storage object (prefix sweep)");
          }
        }),
      );
    } catch (err) {
      logger.warn({ err, tenantId, prefix }, "Failed to list guest storage objects for prefix sweep");
    }
  }

  // 2. COMPAT FALLBACK: delete legacy DB-referenced paths not under a tenant prefix
  const storagePaths: string[] = [];

  const files = await db
    .select({ storagePath: jobFilesTable.storagePath })
    .from(jobFilesTable)
    .where(inArray(jobFilesTable.tenantId, tenantIds));

  for (const f of files) {
    if (f.storagePath && !f.storagePath.includes("/tenants/")) {
      storagePaths.push(f.storagePath);
    }
  }

  const sheets = await db
    .select({ rasterizedPath: jobSheetsTable.rasterizedPath })
    .from(jobSheetsTable)
    .where(inArray(jobSheetsTable.tenantId, tenantIds));

  for (const s of sheets) {
    if (s.rasterizedPath && !s.rasterizedPath.includes("/tenants/")) {
      storagePaths.push(s.rasterizedPath);
    }
  }

  let legacyDeleted = 0;
  let legacyFailed = 0;

  await Promise.all(
    storagePaths.map(async (path) => {
      const objectName = toGcsObjectName(path);
      const gcsFile = bucket.file(objectName);
      try {
        let fileSize = 0;
        try {
          const [metadata] = await gcsFile.getMetadata();
          fileSize = Number(metadata.size ?? 0);
        } catch {
          // Non-fatal
        }
        await gcsFile.delete({ ignoreNotFound: true });
        legacyDeleted++;
        totalBytesRecovered += fileSize;
      } catch (err) {
        legacyFailed++;
        logger.warn({ err, objectName }, "Failed to delete legacy guest storage object");
      }
    }),
  );

  const filesDeleted = prefixDeleted + legacyDeleted;

  logger.info(
    { prefixDeleted, prefixFailed, legacyDeleted, legacyFailed, bytesRecovered: totalBytesRecovered, tenantCount: tenantIds.length },
    "Deleted guest storage objects",
  );

  return { filesDeleted, bytesRecovered: totalBytesRecovered };
}

function expiryThreshold(): Date {
  return new Date(Date.now() - GUEST_SESSION_TTL_MS);
}

/**
 * Returns the count of expired guest tenants that are pending removal.
 * A guest tenant is considered expired when its lastActiveAt (or createdAt if
 * lastActiveAt has not been set yet) is older than the guest session TTL.
 */
export async function countExpiredGuestTenants(): Promise<number> {
  const cutoff = expiryThreshold();
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tenantsTable)
    .where(
      and(
        like(tenantsTable.id, `${GUEST_TENANT_PREFIX}%`),
        lt(
          sql`COALESCE(${tenantsTable.lastActiveAt}, ${tenantsTable.createdAt})`,
          cutoff,
        ),
      ),
    );
  return row?.count ?? 0;
}

/**
 * Prunes stale records from guest_cleanup_runs so the table doesn't grow forever.
 * Two limits are applied:
 *   1. Age — rows older than CLEANUP_RUN_MAX_AGE_MS (90 days) are deleted.
 *   2. Count — if more than CLEANUP_RUN_MAX_ROWS rows remain, the oldest
 *      records beyond that cap are deleted.
 */
async function pruneCleanupRunHistory(): Promise<void> {
  const maxAgeMs = getCleanupHistoryMaxAgeDays() * 24 * 60 * 60 * 1000;
  const ageCutoff = new Date(Date.now() - maxAgeMs);

  const { rowCount: ageDeleted } = await db
    .delete(guestCleanupRunsTable)
    .where(lt(guestCleanupRunsTable.ranAt, ageCutoff));

  const { rowCount: capDeleted } = await db
    .delete(guestCleanupRunsTable)
    .where(
      not(
        inArray(
          guestCleanupRunsTable.id,
          db
            .select({ id: guestCleanupRunsTable.id })
            .from(guestCleanupRunsTable)
            .orderBy(desc(guestCleanupRunsTable.ranAt))
            .limit(getCleanupHistoryMaxRows()),
        ),
      ),
    );

  const totalDeleted = (ageDeleted ?? 0) + (capDeleted ?? 0);
  if (totalDeleted > 0) {
    logger.info({ ageDeleted, capDeleted }, "Pruned old guest_cleanup_runs records");
  }
}

/**
 * Deletes all expired guest tenants (and their cascade-linked users/data),
 * also removing all uploaded and pipeline-generated files from object storage
 * first. Persists the run result to the database and returns a CleanupRunResult.
 */
export async function deleteExpiredGuestTenants(): Promise<CleanupRunResult> {
  const cutoff = expiryThreshold();

  const expiredTenants = await db
    .select({ id: tenantsTable.id })
    .from(tenantsTable)
    .where(
      and(
        like(tenantsTable.id, `${GUEST_TENANT_PREFIX}%`),
        lt(
          sql`COALESCE(${tenantsTable.lastActiveAt}, ${tenantsTable.createdAt})`,
          cutoff,
        ),
      ),
    );

  const ranAt = new Date().toISOString();

  const tenantIds = expiredTenants.map((t) => t.id);

  // Remove object-storage files before the DB rows are cascade-deleted
  const { filesDeleted, bytesRecovered } = tenantIds.length > 0
    ? await deleteStorageForTenants(tenantIds)
    : { filesDeleted: 0, bytesRecovered: 0 };

  let tenantsDeleted = 0;

  if (tenantIds.length > 0) {
    const deleted = await db
      .delete(tenantsTable)
      .where(inArray(tenantsTable.id, tenantIds))
      .returning({ id: tenantsTable.id });
    tenantsDeleted = deleted.length;
  }

  // Always persist a record of the run so admins can see history across restarts
  await persistCleanupRun({ tenantsDeleted, filesDeleted, bytesRecovered, ranAt });

  // Trim history so the table doesn't grow unboundedly.
  // Non-fatal: a prune failure must not mask a successful cleanup run.
  try {
    await pruneCleanupRunHistory();
  } catch (err) {
    logger.warn({ err }, "Failed to prune guest_cleanup_runs history — non-fatal");
  }

  return { tenantsDeleted, filesDeleted, bytesRecovered, ranAt };
}

export async function startGuestCleanupJob(): Promise<void> {
  if (process.env.CLEANUP_HISTORY_MAX_AGE_DAYS !== undefined && !_maxAgeDaysValid) {
    logger.warn(
      { envValue: process.env.CLEANUP_HISTORY_MAX_AGE_DAYS, defaultUsed: 90 },
      "CLEANUP_HISTORY_MAX_AGE_DAYS is invalid (must be a positive number); using default",
    );
  }
  if (process.env.CLEANUP_HISTORY_MAX_ROWS !== undefined && !_maxRowsValid) {
    logger.warn(
      { envValue: process.env.CLEANUP_HISTORY_MAX_ROWS, defaultUsed: 1000 },
      "CLEANUP_HISTORY_MAX_ROWS is invalid (must be a positive number); using default",
    );
  }

  await loadCleanupRetentionSettings();

  logger.info(
    { maxAgeDays: getCleanupHistoryMaxAgeDays(), maxRows: getCleanupHistoryMaxRows() },
    "Guest cleanup job starting — retention configuration",
  );

  const run = async () => {
    try {
      const result = await deleteExpiredGuestTenants();
      if (result.tenantsDeleted > 0) {
        logger.info(
          { count: result.tenantsDeleted, filesDeleted: result.filesDeleted, bytesRecovered: result.bytesRecovered },
          "Deleted expired guest tenants (and their users via cascade)",
        );
      }
    } catch (err) {
      logger.error({ err }, "Guest cleanup job failed");
    }
  };

  run();

  setInterval(run, CLEANUP_INTERVAL_MS).unref();
}
