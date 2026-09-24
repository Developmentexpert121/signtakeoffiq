import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { savedDateRangesTable } from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";
import { requireAuth } from "../lib/tenantAuth";
import { newId } from "../lib/ids";

const router: IRouter = Router();

router.get("/saved-date-ranges", requireAuth, async (req, res): Promise<void> => {
  const { userId, tenantId } = req.auth_ctx!;

  const ranges = await db
    .select()
    .from(savedDateRangesTable)
    .where(
      and(
        eq(savedDateRangesTable.userId, userId),
        eq(savedDateRangesTable.tenantId, tenantId),
      ),
    )
    .orderBy(asc(savedDateRangesTable.sortOrder), asc(savedDateRangesTable.createdAt));

  res.json(ranges.map(r => ({
    id: r.id,
    name: r.name,
    start: r.start,
    end: r.end,
    sortOrder: r.sortOrder,
  })));
});

router.post("/saved-date-ranges", requireAuth, async (req, res): Promise<void> => {
  const { userId, tenantId } = req.auth_ctx!;
  const { name, start, end } = req.body;

  if (!name || typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (!start || typeof start !== "string") {
    res.status(400).json({ error: "start is required" });
    return;
  }
  if (!end || typeof end !== "string") {
    res.status(400).json({ error: "end is required" });
    return;
  }

  const existing = await db
    .select({ id: savedDateRangesTable.id })
    .from(savedDateRangesTable)
    .where(
      and(
        eq(savedDateRangesTable.userId, userId),
        eq(savedDateRangesTable.tenantId, tenantId),
      ),
    );

  const [range] = await db
    .insert(savedDateRangesTable)
    .values({
      id: newId("sdr"),
      userId,
      tenantId,
      name: name.trim(),
      start,
      end,
      sortOrder: existing.length,
    })
    .returning();

  res.status(201).json({
    id: range.id,
    name: range.name,
    start: range.start,
    end: range.end,
    sortOrder: range.sortOrder,
  });
});

router.patch("/saved-date-ranges/reorder", requireAuth, async (req, res): Promise<void> => {
  const { userId, tenantId } = req.auth_ctx!;
  const { orderedIds } = req.body;

  if (!Array.isArray(orderedIds) || orderedIds.some(id => typeof id !== "string")) {
    res.status(400).json({ error: "orderedIds must be an array of strings" });
    return;
  }

  await db.transaction(async (tx) => {
    for (let i = 0; i < orderedIds.length; i++) {
      await tx
        .update(savedDateRangesTable)
        .set({ sortOrder: i })
        .where(
          and(
            eq(savedDateRangesTable.id, orderedIds[i]),
            eq(savedDateRangesTable.userId, userId),
            eq(savedDateRangesTable.tenantId, tenantId),
          ),
        );
    }
  });

  res.status(204).send();
});

router.delete("/saved-date-ranges/:rangeId", requireAuth, async (req, res): Promise<void> => {
  const { userId, tenantId } = req.auth_ctx!;
  const rangeId = String(req.params.rangeId);

  const [deleted] = await db
    .delete(savedDateRangesTable)
    .where(
      and(
        eq(savedDateRangesTable.id, rangeId),
        eq(savedDateRangesTable.userId, userId),
        eq(savedDateRangesTable.tenantId, tenantId),
      ),
    )
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Saved date range not found" });
    return;
  }

  res.status(204).send();
});

export default router;
