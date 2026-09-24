export const JOB_DETAIL_TAB_PREFIX = "job-detail.";
export const JOB_DETAIL_LRU_KEY = "job-detail.lru";
export const JOB_DETAIL_LRU_MAX = 50;
export const JOB_DETAIL_MIGRATION_FLAG = "job-detail.v1.migrated";

export function readLru(): string[] {
  try {
    const raw = localStorage.getItem(JOB_DETAIL_LRU_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function migrateJobDetailTabKeys(): void {
  try {
    if (localStorage.getItem(JOB_DETAIL_MIGRATION_FLAG)) return;

    const validPerJobPattern = /^job-detail\.(.+)\.activeTab$/;
    const managed = new Set(readLru());
    const toSeed: string[] = [];
    const toRemove: string[] = [];

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (!key.startsWith(JOB_DETAIL_TAB_PREFIX) || !key.endsWith(".activeTab")) continue;

      const match = key.match(validPerJobPattern);
      if (match) {
        const jobId = match[1];
        if (!managed.has(jobId)) {
          toSeed.push(jobId);
        }
      } else {
        toRemove.push(key);
      }
    }

    for (const key of toRemove) {
      localStorage.removeItem(key);
    }

    if (toSeed.length > 0) {
      const lru = readLru();
      for (const jobId of toSeed) {
        if (!lru.includes(jobId)) {
          lru.push(jobId);
        }
      }
      if (lru.length > JOB_DETAIL_LRU_MAX) {
        const evicted = lru.splice(JOB_DETAIL_LRU_MAX);
        for (const evictedId of evicted) {
          localStorage.removeItem(`${JOB_DETAIL_TAB_PREFIX}${evictedId}.activeTab`);
        }
      }
      localStorage.setItem(JOB_DETAIL_LRU_KEY, JSON.stringify(lru));
    }

    localStorage.setItem(JOB_DETAIL_MIGRATION_FLAG, "1");
  } catch {
    // ignore storage errors
  }
}
