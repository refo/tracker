import type { ItemId, User, WorkItem } from "../../model/types.ts";
import type { GitLabIssue, GitLabUser } from "./wire.ts";

export const TRAILER_RE = /^Tracker-Blocked-By:\s*(.+)$/im;

/** Parse the non-Premium dependency fallback trailer from a description. */
export function parseBlockedByTrailer(description: string | null | undefined): ItemId[] {
  const match = description?.match(TRAILER_RE);
  if (!match) return [];
  return match[1]!
    .split(",")
    .map((s) => s.trim().replace(/^#/, ""))
    .filter(Boolean);
}

/** Merge/insert a trailer line so the blocked-by set includes the given ids. */
export function upsertBlockedByTrailer(description: string, blockerIds: ItemId[]): string {
  const existing = parseBlockedByTrailer(description);
  const merged = [...new Set([...existing, ...blockerIds])];
  const line = `Tracker-Blocked-By: ${merged.map((id) => `#${id}`).join(", ")}`;
  if (TRAILER_RE.test(description)) return description.replace(TRAILER_RE, line);
  return description.trim() ? `${description.trimEnd()}\n\n${line}` : line;
}

export function mapUser(u: GitLabUser): User {
  return { id: String(u.id), username: u.username, ...(u.name ? { name: u.name } : {}) };
}

export interface HierarchyInfo {
  parent: ItemId | null;
  blockedBy: ItemId[];
  typeName: string | null;
}

export function mapIssue(issue: GitLabIssue, info?: HierarchyInfo): WorkItem {
  const description = issue.description ?? "";
  const blockedBy = new Set<ItemId>([
    ...(info?.blockedBy ?? []),
    ...parseBlockedByTrailer(description),
  ]);
  return {
    id: String(issue.iid),
    kind: info?.typeName === "Epic" ? "epic" : "task",
    title: issue.title,
    state: issue.state === "opened" ? "open" : "closed",
    labels: issue.labels ?? [],
    assignees: (issue.assignees ?? []).map(mapUser),
    author: issue.author ? mapUser(issue.author) : null,
    parent: info?.parent ?? null,
    blockedBy: [...blockedBy].sort((a, b) => Number(a) - Number(b) || (a < b ? -1 : 1)),
    url: issue.web_url,
    description,
    updatedAt: issue.updated_at,
    raw: issue,
  };
}
