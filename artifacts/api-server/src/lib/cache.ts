import { db } from "@workspace/db";
import { cacheEntriesTable } from "@workspace/db";
import { eq, lt, sql } from "drizzle-orm";

export class CacheService {
  async get<T>(key: string): Promise<T | null> {
    const now = new Date();
    const [entry] = await db
      .select()
      .from(cacheEntriesTable)
      .where(eq(cacheEntriesTable.key, key))
      .limit(1);

    if (!entry) return null;
    if (entry.expiresAt <= now) {
      await db.delete(cacheEntriesTable).where(eq(cacheEntriesTable.key, key));
      return null;
    }

    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    const expiresAt = new Date(Date.now() + ttlMs);
    await db
      .insert(cacheEntriesTable)
      .values({ key, value: value as object, expiresAt })
      .onConflictDoUpdate({
        target: cacheEntriesTable.key,
        set: { value: value as object, expiresAt },
      });
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    const escapedPrefix = prefix.replace(/[%_\\]/g, "\\$&");
    await db
      .delete(cacheEntriesTable)
      .where(sql`${cacheEntriesTable.key} LIKE ${escapedPrefix + "%"} ESCAPE '\\'`);
  }

  async evictExpired(): Promise<void> {
    await db
      .delete(cacheEntriesTable)
      .where(lt(cacheEntriesTable.expiresAt, new Date()));
  }
}

export const cacheService = new CacheService();
