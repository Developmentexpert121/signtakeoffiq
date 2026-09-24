import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { tenantsTable, usersTable } from "@workspace/db";
import { BUILDING_TRAITS, BUILT_IN_MULTI_ENTRY_KEYWORD_NAMES } from "../lib/rules-engine";
import { eq, or, sql } from "drizzle-orm";
import { requireAuth, requireAdmin, requireSuperAdmin, isSuperAdmin, normalizeRole } from "../lib/tenantAuth";
import { countExpiredGuestTenants, deleteExpiredGuestTenants, getLastCleanupResult, getCleanupHistory, getCleanupHistoryMaxAgeDays, getCleanupHistoryMaxRows, setCleanupHistoryMaxAgeDays, setCleanupHistoryMaxRows, cleanupHistoryMaxAgeDaysIsDefault, cleanupHistoryMaxRowsIsDefault, persistCleanupRetentionSettings } from "../lib/guestCleanup";
import { rasterizeDpi, maxAiVisionCallsPerRun } from "../lib/config";
import { CLAUDE_VISION_MODEL, CLAUDE_VISION_PROVIDER, CLAUDE_RETRY_MAX_DEFAULT, computeMaxRetryWaitMs } from "../lib/pipeline";

const router: IRouter = Router();

router.get("/admin/tenant", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;

  const [tenant] = await db.select().from(tenantsTable)
    .where(eq(tenantsTable.id, tenantId));

  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  res.json({
    ...tenant,
    settings: tenant.settings || {},
  });
});

router.patch("/admin/tenant", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const { name, settings } = req.body;

  if (settings && typeof settings === "object") {
    if ("aiRetryMax" in settings) {
      const val = settings.aiRetryMax;
      if (!Number.isInteger(val) || val < 0 || val > 10) {
        res.status(400).json({ error: "aiRetryMax must be an integer between 0 and 10." });
        return;
      }
    }

    if ("aiCallCap" in settings) {
      const val = settings.aiCallCap;
      if (!Number.isInteger(val) || val < 1 || val > 1000) {
        res.status(400).json({ error: "aiCallCap must be an integer between 1 and 1000." });
        return;
      }
    }

    if ("aiBaseDelayMs" in settings) {
      const val = settings.aiBaseDelayMs;
      if (!Number.isInteger(val) || (val as number) < 500 || (val as number) > 30000) {
        res.status(400).json({ error: "aiBaseDelayMs must be an integer between 500 and 30000." });
        return;
      }
    }

    if ("aiRetryMax" in settings || "aiBaseDelayMs" in settings) {
      const [currentTenantForRetry] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
      const currentSettingsForRetry = (currentTenantForRetry?.settings ?? {}) as Record<string, unknown>;
      // Cross-field validation only applies when at least one side has an explicit
      // tenant-level base delay configured (incoming or stored). If the tenant has
      // never set aiBaseDelayMs, the server env var controls it and the validation
      // is the server admin's responsibility — we only prevent the tenant from
      // creating a problematic combination they own end-to-end.
      const hasExplicitBaseDelay =
        "aiBaseDelayMs" in settings ||
        typeof currentSettingsForRetry.aiBaseDelayMs === "number";
      if (hasExplicitBaseDelay) {
        const effectiveRetryMax =
          "aiRetryMax" in settings
            ? (settings.aiRetryMax as number)
            : typeof currentSettingsForRetry.aiRetryMax === "number"
              ? currentSettingsForRetry.aiRetryMax
              : CLAUDE_RETRY_MAX_DEFAULT;
        const effectiveBaseDelayMs =
          "aiBaseDelayMs" in settings
            ? (settings.aiBaseDelayMs as number)
            : (currentSettingsForRetry.aiBaseDelayMs as number);
        const RETRY_TIMEOUT_THRESHOLD_MS = 5 * 60 * 1000;
        const totalWaitMs = computeMaxRetryWaitMs(effectiveBaseDelayMs, effectiveRetryMax);
        if (totalWaitMs > RETRY_TIMEOUT_THRESHOLD_MS) {
          res.status(400).json({
            error: `This base delay and retry count combination could produce up to ${Math.round(totalWaitMs / 1000)}s of total retry wait time, which exceeds the 5-minute limit. Reduce the base delay or retry limit.`,
          });
          return;
        }
      }
    }
  }

  if (settings && typeof settings === "object" && "aiVisionCallsPerRun" in settings) {
    const val = settings.aiVisionCallsPerRun;
    if (!Number.isInteger(val) || (val as number) < 1 || (val as number) > 500) {
      res.status(400).json({ error: "aiVisionCallsPerRun must be an integer between 1 and 500." });
      return;
    }
  }

  if (settings && typeof settings === "object" && "customBuildingTypes" in settings) {
    const val = settings.customBuildingTypes;
    if (!Array.isArray(val)) {
      res.status(400).json({ error: "customBuildingTypes must be an array of strings." });
      return;
    }
    for (const item of val) {
      if (typeof item !== "string" || item.trim().length === 0) {
        res.status(400).json({ error: "Each custom building type must be a non-empty string." });
        return;
      }
      if (item.length > 60) {
        res.status(400).json({ error: "Custom building type names must be 60 characters or fewer." });
        return;
      }
    }
    if (val.length > 50) {
      res.status(400).json({ error: "You can add up to 50 custom building types." });
      return;
    }
    // Fetch currently stored types so legacy duplicate pairs that already exist in
    // storage can pass through unchanged (e.g. an unrelated settings update), while
    // any newly introduced case-insensitive duplicate is still rejected.
    const [currentTenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
    const currentSettings = (currentTenant?.settings ?? {}) as Record<string, unknown>;
    const storedTypes: string[] = Array.isArray(currentSettings.customBuildingTypes)
      ? (currentSettings.customBuildingTypes as string[])
      : [];
    // Count occurrences of each exact-case value in storage (handles exact-string duplicates).
    const storedCountMap = new Map<string, number>();
    for (const s of storedTypes) {
      storedCountMap.set(s, (storedCountMap.get(s) ?? 0) + 1);
    }
    const submittedLower = val.map((s: string) => s.trim().toLowerCase());
    for (let i = 0; i < val.length; i++) {
      for (let j = i + 1; j < val.length; j++) {
        if (submittedLower[i] === submittedLower[j]) {
          // Case-insensitive duplicate pair found. Allow only if the stored list
          // already had these same values with the same or greater multiplicity.
          const allowed =
            val[i] === val[j]
              ? (storedCountMap.get(val[i]) ?? 0) >= 2  // same exact string: need 2+ copies stored
              : storedCountMap.has(val[i]) && storedCountMap.has(val[j]); // different strings: both must be stored
          if (!allowed) {
            res.status(400).json({ error: "Custom building types must be unique (case-insensitive)." });
            return;
          }
        }
      }
    }
  }

  if (settings && typeof settings === "object" && "multiEntryRoomKeywords" in settings) {
    const val = settings.multiEntryRoomKeywords;
    if (!Array.isArray(val)) {
      res.status(400).json({ error: "multiEntryRoomKeywords must be an array of strings." });
      return;
    }
    if (val.length > 100) {
      res.status(400).json({ error: "multiEntryRoomKeywords may not exceed 100 entries." });
      return;
    }
    for (const kw of val) {
      if (typeof kw !== "string" || kw.trim().length === 0) {
        res.status(400).json({ error: "Each keyword in multiEntryRoomKeywords must be a non-empty string." });
        return;
      }
      if (kw.length > 100) {
        res.status(400).json({ error: "Each keyword in multiEntryRoomKeywords must be 100 characters or fewer." });
        return;
      }
    }
  }

  if (settings && typeof settings === "object" && "lowConfidenceThreshold" in settings) {
    const val = settings.lowConfidenceThreshold;
    if (!Number.isInteger(val) || (val as number) < 1 || (val as number) > 99) {
      res.status(400).json({ error: "lowConfidenceThreshold must be an integer between 1 and 99." });
      return;
    }
  }

  if (settings && typeof settings === "object" && "customBuildingTypeMappings" in settings) {
    const val = settings.customBuildingTypeMappings;
    if (typeof val !== "object" || val === null || Array.isArray(val)) {
      res.status(400).json({ error: "customBuildingTypeMappings must be an object." });
      return;
    }
    const validProfiles = Object.keys(BUILDING_TRAITS);
    for (const [key, profile] of Object.entries(val as Record<string, unknown>)) {
      if (typeof key !== "string" || key.trim().length === 0) {
        res.status(400).json({ error: "Custom building type mapping keys must be non-empty strings." });
        return;
      }
      if (typeof profile !== "string" || !validProfiles.includes(profile)) {
        res.status(400).json({ error: `Invalid rules profile "${profile}". Must be one of: ${validProfiles.join(", ")}.` });
        return;
      }
    }
  }

  if (settings && typeof settings === "object" && "standardBuildingTypeMappings" in settings) {
    const val = settings.standardBuildingTypeMappings;
    if (typeof val !== "object" || val === null || Array.isArray(val)) {
      res.status(400).json({ error: "standardBuildingTypeMappings must be an object." });
      return;
    }
    const validProfiles = Object.keys(BUILDING_TRAITS);
    for (const [key, profile] of Object.entries(val as Record<string, unknown>)) {
      if (typeof key !== "string" || key.trim().length === 0) {
        res.status(400).json({ error: "Standard building type mapping keys must be non-empty strings." });
        return;
      }
      if (typeof profile !== "string" || !validProfiles.includes(profile)) {
        res.status(400).json({ error: `Invalid rules profile "${profile}". Must be one of: ${validProfiles.join(", ")}.` });
        return;
      }
    }
  }

  const [tenant] = await db.update(tenantsTable)
    .set({
      ...(name && { name }),
      ...(settings && { settings }),
    })
    .where(eq(tenantsTable.id, tenantId))
    .returning();

  res.json({
    ...tenant,
    settings: tenant.settings || {},
  });
});

router.get("/admin/users", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;

  const users = await db.select().from(usersTable)
    .where(eq(usersTable.tenantId, tenantId));

  res.json(users);
});

// LEGACY endpoint — kept for back-compat with older clients. Hardened so that:
// - only super_admin can call it (prevents an owner escalating themselves)
// - role must be one of the canonical RBAC values
// - caller cannot change their own role (no self-escalation / self-demotion)
// - cannot demote the last super_admin
router.patch("/admin/users/:userId/role", requireAuth, requireSuperAdmin, async (req, res): Promise<void> => {
  const ctx = req.auth_ctx!;
  const userId = String(req.params.userId);
  const { role } = req.body ?? {};

  const ALLOWED = ["super_admin", "owner", "user"] as const;
  if (!role || !ALLOWED.includes(role)) {
    res.status(400).json({ error: "role must be one of super_admin, owner, user" });
    return;
  }

  if (userId === ctx.userId) {
    res.status(400).json({ error: "You cannot change your own role." });
    return;
  }

  const [target] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!target) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  if (isSuperAdmin(target.role) && role !== "super_admin") {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(usersTable)
      .where(or(eq(usersTable.role, "super_admin"), eq(usersTable.role, "admin")));
    if (Number(count) <= 1) {
      res.status(400).json({ error: "Cannot demote the last super admin." });
      return;
    }
  }

  const [user] = await db.update(usersTable)
    .set({ role })
    .where(eq(usersTable.id, userId))
    .returning();

  res.json({ ...user, role: normalizeRole(user.role) });
});

router.get("/admin/tenants", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const tenants = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  res.json(tenants.map(t => ({ ...t, settings: t.settings || {} })));
});

router.get("/admin/config", requireAuth, requireAdmin, async (_req, res): Promise<void> => {
  res.json({
    rasterizeDpi,
    maxAiVisionCallsPerRun,
    cleanupHistoryMaxAgeDays: getCleanupHistoryMaxAgeDays(),
    cleanupHistoryMaxAgeDaysIsDefault,
    cleanupHistoryMaxRows: getCleanupHistoryMaxRows(),
    cleanupHistoryMaxRowsIsDefault,
    aiModel: CLAUDE_VISION_MODEL,
    aiProvider: CLAUDE_VISION_PROVIDER,
  });
});

router.patch("/admin/config", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const { cleanupHistoryMaxAgeDays: newMaxAgeDays, cleanupHistoryMaxRows: newMaxRows } = req.body;

  if (newMaxAgeDays !== undefined) {
    if (!Number.isInteger(newMaxAgeDays) || newMaxAgeDays < 1 || newMaxAgeDays > 3650) {
      res.status(400).json({ error: "cleanupHistoryMaxAgeDays must be an integer between 1 and 3650." });
      return;
    }
    setCleanupHistoryMaxAgeDays(newMaxAgeDays);
  }

  if (newMaxRows !== undefined) {
    if (!Number.isInteger(newMaxRows) || newMaxRows < 1 || newMaxRows > 100000) {
      res.status(400).json({ error: "cleanupHistoryMaxRows must be an integer between 1 and 100000." });
      return;
    }
    setCleanupHistoryMaxRows(newMaxRows);
  }

  await persistCleanupRetentionSettings();

  res.json({
    rasterizeDpi,
    maxAiVisionCallsPerRun,
    cleanupHistoryMaxAgeDays: getCleanupHistoryMaxAgeDays(),
    cleanupHistoryMaxAgeDaysIsDefault,
    cleanupHistoryMaxRows: getCleanupHistoryMaxRows(),
    cleanupHistoryMaxRowsIsDefault,
    aiModel: CLAUDE_VISION_MODEL,
    aiProvider: CLAUDE_VISION_PROVIDER,
    builtInMultiEntryKeywords: BUILT_IN_MULTI_ENTRY_KEYWORD_NAMES,
  });
});

router.get("/config/scan-limits", requireAuth, async (_req, res): Promise<void> => {
  res.json({ maxAiVisionCallsPerRun, aiModel: CLAUDE_VISION_MODEL, aiProvider: CLAUDE_VISION_PROVIDER });
});

router.get("/admin/guest-cleanup/stats", requireAuth, requireAdmin, async (_req, res): Promise<void> => {
  const [expiredGuestTenants, lastRun, history] = await Promise.all([
    countExpiredGuestTenants(),
    getLastCleanupResult(),
    getCleanupHistory(),
  ]);
  res.json({ expiredGuestTenants, lastRun: lastRun ?? null, history });
});

router.post("/admin/guest-cleanup/run", requireAuth, requireAdmin, async (_req, res): Promise<void> => {
  const result = await deleteExpiredGuestTenants();
  res.json({
    deletedGuestTenants: result.tenantsDeleted,
    filesDeleted: result.filesDeleted,
    bytesRecovered: result.bytesRecovered,
  });
});

export default router;
