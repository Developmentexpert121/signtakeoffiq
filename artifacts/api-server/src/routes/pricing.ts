import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { tenantPricingSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, requireOwnerOrAbove } from "../lib/tenantAuth";

const router: IRouter = Router();

router.get("/pricing/settings", requireAuth, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const [row] = await db
    .select()
    .from(tenantPricingSettingsTable)
    .where(eq(tenantPricingSettingsTable.tenantId, tenantId));
  if (!row) {
    res.json(null);
    return;
  }
  res.json(row);
});

router.put("/pricing/settings", requireAuth, requireOwnerOrAbove, async (req, res): Promise<void> => {
  const { tenantId } = req.auth_ctx!;
  const {
    materials,
    finishings,
    laser,
    additionalCharges,
    rushFee,
    shipping,
    signDefaults,
    customProducts,
    installation,
  } = req.body as Record<string, unknown>;

  const payload = {
    materials: materials ?? [],
    finishings: finishings ?? [],
    laser: laser ?? [],
    additionalCharges: additionalCharges ?? [],
    rushFee: rushFee ?? {},
    shipping: shipping ?? {},
    signDefaults: signDefaults ?? [],
    customProducts: customProducts ?? [],
    installation: installation ?? {},
    updatedAt: new Date(),
  };

  await db
    .insert(tenantPricingSettingsTable)
    .values({ tenantId, ...payload })
    .onConflictDoUpdate({
      target: tenantPricingSettingsTable.tenantId,
      set: payload,
    });

  res.json({ ok: true });
});

export default router;
