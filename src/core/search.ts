import type { Cache } from "../cache/db.ts";
import type { ItemId, ItemState, WorkItem } from "../model/types.ts";

export interface SearchQuery {
  text?: string;
  assignee?: string;
  author?: string;
  label?: string;
  state?: ItemState | "all";
  parent?: ItemId;
}

const normalizeUser = (u: string) => u.replace(/^@/, "").toLowerCase();

/**
 * Local-first search: FTS5 narrows by text, structured filters narrow the rest.
 * A query with no text and only filters is fully supported (the
 * "find that issue I assigned to Mehmet" case). Default state: all.
 */
export function searchLocal(cache: Cache, q: SearchQuery): WorkItem[] {
  let items = cache.allItems();
  if (q.text?.trim()) {
    const ids = cache.searchText(q.text);
    items = items.filter((i) => ids.has(i.id));
  }
  const state = q.state ?? "all";
  if (state !== "all") items = items.filter((i) => i.state === state);
  if (q.parent) items = items.filter((i) => i.parent === q.parent);
  if (q.label) items = items.filter((i) => i.labels.includes(q.label!));
  if (q.assignee) {
    const want = normalizeUser(q.assignee);
    items = items.filter((i) => i.assignees.some((a) => a.username.toLowerCase() === want));
  }
  if (q.author) {
    const want = normalizeUser(q.author);
    items = items.filter((i) => i.author !== null && i.author.username.toLowerCase() === want);
  }
  return items;
}
