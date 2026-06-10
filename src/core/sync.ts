import type { TrackerAdapter } from "../adapters/types.ts";
import type { Cache } from "../cache/db.ts";

export async function syncCache(
  adapter: TrackerAdapter,
  cache: Cache,
  nowMs: number = Date.now(),
): Promise<{ count: number }> {
  const items = await adapter.fetchAll();
  cache.replaceAll(items, adapter.provider);
  cache.markSynced(nowMs);
  return { count: items.length };
}

/** Staleness-triggered auto-sync before read commands. Returns true if it synced. */
export async function ensureFresh(
  adapter: TrackerAdapter,
  cache: Cache,
  staleMs: number,
  nowMs: number = Date.now(),
  onSync?: () => void,
): Promise<boolean> {
  if (!cache.isStale(nowMs, staleMs)) return false;
  onSync?.();
  await syncCache(adapter, cache, nowMs);
  return true;
}
