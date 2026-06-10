import type { TrackerAdapter } from "../adapters/types.ts";
import type { Cache } from "../cache/db.ts";
import { DomainError } from "../errors.ts";
import type { Comment, ItemId } from "../model/types.ts";

export const MEM_MARK = "📌 MEMORY";
export const FORGET_MARK = "🗑 FORGET";

export interface MemoryPolicy {
  title: string;
  label: string;
}

export interface Memory {
  key: string;
  text: string;
  ts: string;
}

export function parseMemory(body: string): { key: string; text: string } | null {
  if (!body.startsWith(MEM_MARK)) return null;
  const m = body.match(/^\S+\s+\S+\s+key=(\S+)\s+([\s\S]*)$/);
  if (!m) return null;
  return { key: m[1]!, text: m[2]!.trim() };
}

export function parseForget(body: string): string | null {
  if (!body.startsWith(FORGET_MARK)) return null;
  return body.match(/key=(\S+)/)?.[1] ?? null;
}

/** Latest note per key wins; forgotten keys are hidden. Comments must be in created order. */
export function resolveMemories(comments: Comment[], filter?: string): Memory[] {
  const forgotten = new Set<string>();
  for (const c of comments) {
    const key = parseForget(c.body);
    if (key) forgotten.add(key);
  }
  const latest = new Map<string, Memory>();
  for (const c of comments) {
    const m = parseMemory(c.body);
    if (!m || forgotten.has(m.key)) continue;
    latest.set(m.key, { key: m.key, text: m.text, ts: c.createdAt });
  }
  const all = [...latest.values()];
  if (!filter) return all;
  const f = filter.toLowerCase();
  return all.filter((m) => m.key.toLowerCase().includes(f) || m.text.toLowerCase().includes(f));
}

/** Find (cache → local snapshot → remote search) or create the pinned memory issue. */
export async function ensureMemoryItem(
  adapter: TrackerAdapter,
  cache: Cache,
  policy: MemoryPolicy,
): Promise<ItemId> {
  const cached = cache.metaGet("memory_id");
  if (cached) return cached;

  let found = cache.allItems().find((i) => i.title === policy.title && i.state === "open");
  if (!found && adapter.capabilities().serverSearch) {
    const hits = await adapter.searchRemote({ text: policy.title, state: "open" });
    found = hits.find((i) => i.title === policy.title);
  }
  const item =
    found ??
    (await adapter.create({
      title: policy.title,
      description:
        "Persistent project memories. Each note is a memory keyed by `key=<name>`. Do not close.",
      labels: [policy.label],
    }));
  cache.metaSet("memory_id", item.id);
  return item.id;
}

export async function remember(
  adapter: TrackerAdapter,
  cache: Cache,
  policy: MemoryPolicy,
  key: string,
  text: string,
): Promise<ItemId> {
  if (/\s/.test(key)) throw new DomainError("memory key cannot contain whitespace");
  const id = await ensureMemoryItem(adapter, cache, policy);
  await adapter.comment(id, `${MEM_MARK} key=${key} ${text}`);
  return id;
}

export async function forget(
  adapter: TrackerAdapter,
  cache: Cache,
  policy: MemoryPolicy,
  key: string,
): Promise<ItemId> {
  const id = await ensureMemoryItem(adapter, cache, policy);
  await adapter.comment(id, `${FORGET_MARK} key=${key}`);
  return id;
}

export async function listMemories(
  adapter: TrackerAdapter,
  cache: Cache,
  policy: MemoryPolicy,
  filter?: string,
): Promise<Memory[]> {
  const id = await ensureMemoryItem(adapter, cache, policy);
  const comments = await adapter.listComments(id);
  return resolveMemories(comments, filter);
}
