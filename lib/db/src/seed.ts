/**
 * Idempotent production seeder.
 *
 * Safe to run on every deploy. Uses ON CONFLICT DO NOTHING / DO UPDATE so
 * existing rows are never destroyed. Seeds:
 *   - Default tenant ("Default Workspace") + initial admin user
 *   - Canonical building-type profiles (8 types + legacy aliases used by the
 *     rules engine) so /admin/building-types is populated on first boot
 *   - Building-type lexicon starter keywords for the semantic mapper
 *   - Default empty pricing-settings row for the default tenant
 *   - System settings: cleanup-retention defaults
 *
 * Usage:
 *   pnpm --filter @workspace/db run seed
 * or programmatically:
 *   import { runSeed } from "@workspace/db/seed";
 */

import { sql } from "drizzle-orm";
import { db, pool } from "./index";
import {
  tenantsTable,
  usersTable,
  buildingTypeProfilesTable,
  buildingTypeLexiconsTable,
  tenantPricingSettingsTable,
  systemSettingsTable,
} from "./schema";

const DEFAULT_TENANT_ID = process.env.SEED_TENANT_ID ?? "default";
const DEFAULT_TENANT_SLUG = process.env.SEED_TENANT_SLUG ?? "default";
const DEFAULT_TENANT_NAME = process.env.SEED_TENANT_NAME ?? "Default Workspace";
const DEFAULT_ADMIN_ID = process.env.SEED_ADMIN_ID ?? "admin-default";
const DEFAULT_ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? "admin@signtakeoffiq.local";
const DEFAULT_ADMIN_NAME = process.env.SEED_ADMIN_NAME ?? "Default Admin";

interface ProfileSeed {
  buildingType: string;
  evacMapMaxPerFloor: number;
  minExitsPerFloor: number;
  ibcOccupancyGroup: string | null;
  stairSignVariant: string;
  unitMountSide: string | null;
  requiresAreaOfRescue: boolean;
  stairCountDefault: number | null;
  stairNamePatterns: string[] | null;
  exitFormula: string | null;
  assemblyLexicon: string[] | null;
  mepLexicon: string[] | null;
  restroomLexicon: string[] | null;
  corridorLexicon: string[] | null;
}

const COMMON_STAIR_PATTERNS = [
  "STAIR A", "STAIR B", "STAIR C", "STAIR 1", "STAIR 2",
  "EXIT STAIR", "EMERGENCY STAIR", "STAIRWELL", "S1", "S2", "SA", "SB",
];
const COMMON_RESTROOM = ["TOILET", "RESTROOM", "BATHROOM", "WC", "MEN", "WOMEN", "UNISEX"];
const COMMON_MEP = ["MECHANICAL", "ELECTRICAL", "IDF", "MDF", "JANITOR", "TELECOM", "UTILITY", "BOILER", "HVAC"];
const COMMON_CORRIDOR = ["CORRIDOR", "HALL", "HALLWAY", "PASSAGE", "GALLERY", "CIRCULATION", "WALKWAY", "BREEZEWAY"];
const COMMON_ASSEMBLY = ["CONFERENCE", "MEETING", "AUDITORIUM", "TRAINING", "ASSEMBLY"];

const PROFILE_SEEDS: ProfileSeed[] = [
  {
    buildingType: "commercial",
    evacMapMaxPerFloor: 4, minExitsPerFloor: 2, ibcOccupancyGroup: "B",
    stairSignVariant: "STAIR [X]", unitMountSide: null, requiresAreaOfRescue: false,
    stairCountDefault: 2, stairNamePatterns: COMMON_STAIR_PATTERNS,
    exitFormula: "stairCount × floorCount + minExterior",
    assemblyLexicon: COMMON_ASSEMBLY, mepLexicon: COMMON_MEP,
    restroomLexicon: COMMON_RESTROOM, corridorLexicon: COMMON_CORRIDOR,
  },
  {
    buildingType: "healthcare",
    evacMapMaxPerFloor: 6, minExitsPerFloor: 2, ibcOccupancyGroup: "I-2",
    stairSignVariant: "STAIR [X] — SMOKE COMPARTMENT: SEE PLANS",
    unitMountSide: null, requiresAreaOfRescue: true,
    stairCountDefault: 2, stairNamePatterns: COMMON_STAIR_PATTERNS,
    exitFormula: "stairCount × floorCount + minExterior",
    assemblyLexicon: [...COMMON_ASSEMBLY, "WAITING", "EXAM"],
    mepLexicon: [...COMMON_MEP, "STERILE STORAGE", "MED GAS"],
    restroomLexicon: COMMON_RESTROOM, corridorLexicon: COMMON_CORRIDOR,
  },
  {
    buildingType: "education",
    evacMapMaxPerFloor: 4, minExitsPerFloor: 2, ibcOccupancyGroup: "E",
    stairSignVariant: "STAIR [X]", unitMountSide: null, requiresAreaOfRescue: false,
    stairCountDefault: 2, stairNamePatterns: COMMON_STAIR_PATTERNS,
    exitFormula: "stairCount × floorCount + minExterior",
    assemblyLexicon: [...COMMON_ASSEMBLY, "GYMNASIUM", "GYM", "CAFETERIA", "AUDITORIUM", "LECTURE HALL"],
    mepLexicon: COMMON_MEP, restroomLexicon: [...COMMON_RESTROOM, "BOYS", "GIRLS"],
    corridorLexicon: COMMON_CORRIDOR,
  },
  {
    buildingType: "residential",
    evacMapMaxPerFloor: 2, minExitsPerFloor: 2, ibcOccupancyGroup: "R-2",
    stairSignVariant: "STAIR [X]", unitMountSide: "latch", requiresAreaOfRescue: false,
    stairCountDefault: 2, stairNamePatterns: COMMON_STAIR_PATTERNS,
    exitFormula: "stairCount × floorCount + minExterior",
    assemblyLexicon: ["CLUBROOM", "FITNESS", "POOL", "LOUNGE", "COMMUNITY"],
    mepLexicon: COMMON_MEP, restroomLexicon: COMMON_RESTROOM, corridorLexicon: COMMON_CORRIDOR,
  },
  {
    buildingType: "hotel",
    evacMapMaxPerFloor: 4, minExitsPerFloor: 2, ibcOccupancyGroup: "R-1",
    stairSignVariant: "STAIR [X]", unitMountSide: "latch", requiresAreaOfRescue: false,
    stairCountDefault: 2, stairNamePatterns: COMMON_STAIR_PATTERNS,
    exitFormula: "stairCount × floorCount + minExterior",
    assemblyLexicon: [...COMMON_ASSEMBLY, "BALLROOM", "BANQUET", "DINING", "FITNESS"],
    mepLexicon: COMMON_MEP, restroomLexicon: COMMON_RESTROOM, corridorLexicon: COMMON_CORRIDOR,
  },
  {
    buildingType: "retail",
    evacMapMaxPerFloor: 4, minExitsPerFloor: 2, ibcOccupancyGroup: "M",
    stairSignVariant: "STAIR [X]", unitMountSide: null, requiresAreaOfRescue: false,
    stairCountDefault: 2, stairNamePatterns: COMMON_STAIR_PATTERNS,
    exitFormula: "stairCount × floorCount + minExterior",
    assemblyLexicon: COMMON_ASSEMBLY,
    mepLexicon: [...COMMON_MEP, "STOCK ROOM", "RECEIVING"],
    restroomLexicon: COMMON_RESTROOM, corridorLexicon: COMMON_CORRIDOR,
  },
  {
    buildingType: "assembly",
    evacMapMaxPerFloor: 6, minExitsPerFloor: 3, ibcOccupancyGroup: "A-3",
    stairSignVariant: "STAIR [X]", unitMountSide: null, requiresAreaOfRescue: true,
    stairCountDefault: 2, stairNamePatterns: COMMON_STAIR_PATTERNS,
    exitFormula: "stairCount × floorCount + minExterior",
    assemblyLexicon: [...COMMON_ASSEMBLY, "SANCTUARY", "NAVE", "THEATER", "ARENA"],
    mepLexicon: COMMON_MEP, restroomLexicon: COMMON_RESTROOM, corridorLexicon: COMMON_CORRIDOR,
  },
  {
    buildingType: "warehouse",
    evacMapMaxPerFloor: 2, minExitsPerFloor: 2, ibcOccupancyGroup: "S-1",
    stairSignVariant: "STAIR [X]", unitMountSide: null, requiresAreaOfRescue: false,
    stairCountDefault: 1, stairNamePatterns: COMMON_STAIR_PATTERNS,
    exitFormula: "stairCount × floorCount + minExterior",
    assemblyLexicon: [], mepLexicon: COMMON_MEP,
    restroomLexicon: COMMON_RESTROOM, corridorLexicon: COMMON_CORRIDOR,
  },
  {
    buildingType: "unknown",
    evacMapMaxPerFloor: 4, minExitsPerFloor: 2, ibcOccupancyGroup: null,
    stairSignVariant: "STAIR [X]", unitMountSide: null, requiresAreaOfRescue: false,
    stairCountDefault: 2, stairNamePatterns: COMMON_STAIR_PATTERNS,
    exitFormula: "stairCount × floorCount + minExterior",
    assemblyLexicon: COMMON_ASSEMBLY, mepLexicon: COMMON_MEP,
    restroomLexicon: COMMON_RESTROOM, corridorLexicon: COMMON_CORRIDOR,
  },
];

interface LexiconSeed {
  buildingType: string;
  flagName: string;
  keywords: string[];
}

const LEXICON_SEEDS: LexiconSeed[] = [
  { buildingType: "healthcare", flagName: "isMepUnoccupied",
    keywords: ["STERILE STORAGE", "MED GAS", "SOILED UTILITY", "CLEAN UTILITY"] },
  { buildingType: "healthcare", flagName: "isPublicFacing",
    keywords: ["WAITING", "TRIAGE", "REGISTRATION"] },
  { buildingType: "education", flagName: "isAssembly",
    keywords: ["GYMNASIUM", "CAFETERIA", "AUDITORIUM", "LECTURE HALL", "MULTIPURPOSE"] },
  { buildingType: "education", flagName: "isRestroom",
    keywords: ["BOYS", "GIRLS"] },
  { buildingType: "residential", flagName: "isAssembly",
    keywords: ["CLUBROOM", "FITNESS", "POOL", "LOUNGE", "COMMUNITY ROOM"] },
  { buildingType: "hotel", flagName: "isAssembly",
    keywords: ["BALLROOM", "BANQUET", "DINING ROOM"] },
  { buildingType: "assembly", flagName: "isAssembly",
    keywords: ["SANCTUARY", "NAVE", "THEATER", "AUDITORIUM", "ARENA", "CHAPEL"] },
  { buildingType: "commercial", flagName: "isAssembly",
    keywords: ["CONFERENCE", "TRAINING", "BOARDROOM"] },
  { buildingType: "warehouse", flagName: "isVehicleBay",
    keywords: ["LOADING DOCK", "RECEIVING", "SHIPPING"] },
];

export async function runSeed(opts: { verbose?: boolean } = {}): Promise<void> {
  const log = opts.verbose === false ? () => {} : (m: string) => console.log(`[seed] ${m}`);

  log(`Seeding default tenant "${DEFAULT_TENANT_NAME}" (${DEFAULT_TENANT_ID})…`);
  await db.insert(tenantsTable).values({
    id: DEFAULT_TENANT_ID,
    name: DEFAULT_TENANT_NAME,
    slug: DEFAULT_TENANT_SLUG,
    plan: "starter",
    settings: {},
  }).onConflictDoNothing({ target: tenantsTable.id });

  log(`Seeding admin user ${DEFAULT_ADMIN_EMAIL}…`);
  await db.insert(usersTable).values({
    id: DEFAULT_ADMIN_ID,
    tenantId: DEFAULT_TENANT_ID,
    email: DEFAULT_ADMIN_EMAIL,
    fullName: DEFAULT_ADMIN_NAME,
    role: "admin",
  }).onConflictDoNothing({ target: usersTable.id });

  log(`Seeding ${PROFILE_SEEDS.length} building-type profiles…`);
  for (const p of PROFILE_SEEDS) {
    await db.insert(buildingTypeProfilesTable).values(p)
      .onConflictDoNothing({ target: buildingTypeProfilesTable.buildingType });
  }

  let lexCount = 0;
  for (const grp of LEXICON_SEEDS) {
    for (const keyword of grp.keywords) {
      lexCount += 1;
      await db.insert(buildingTypeLexiconsTable).values({
        id: `btl-${grp.buildingType}-${grp.flagName}-${keyword}`
          .toLowerCase().replace(/[^a-z0-9-]+/g, "_"),
        buildingType: grp.buildingType,
        flagName: grp.flagName,
        keyword,
        active: true,
      }).onConflictDoNothing();
    }
  }
  log(`Seeded ${lexCount} lexicon keyword rows.`);

  log("Seeding default pricing-settings row for default tenant…");
  await db.insert(tenantPricingSettingsTable).values({
    tenantId: DEFAULT_TENANT_ID,
    materials: [], finishings: [], laser: [], additionalCharges: [],
    rushFee: {}, shipping: {}, signDefaults: [], customProducts: [], installation: {},
  }).onConflictDoNothing({ target: tenantPricingSettingsTable.tenantId });

  log("Seeding cleanup-retention system settings…");
  await db.insert(systemSettingsTable).values({
    key: "cleanup_retention",
    value: { guestRetentionDays: 7, signedInRetentionDays: 90 },
  }).onConflictDoNothing({ target: systemSettingsTable.key });

  log("Seed complete.");
}

// Touch sql import so it is preserved for future use in raw migrations.
void sql;
void pool;
