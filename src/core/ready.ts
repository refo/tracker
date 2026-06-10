import type { ItemId, WorkItem } from "../model/types.ts";

export interface ReadyPolicy {
  inProgressLabel: string;
  memoryLabel: string;
  parent?: ItemId | null;
}

/**
 * Ready = open AND not blocked by any open item AND unassigned AND not
 * in-progress AND not the memory issue; optional parent filter.
 * Blockers missing from the snapshot (e.g. cross-project) do not block.
 */
export function computeReady(items: WorkItem[], policy: ReadyPolicy): WorkItem[] {
  const stateById = new Map(items.map((i) => [i.id, i.state]));
  return items.filter((item) => {
    if (item.state !== "open") return false;
    if (policy.parent && item.parent !== policy.parent) return false;
    if (item.assignees.length > 0) return false;
    if (item.labels.includes(policy.inProgressLabel)) return false;
    if (item.labels.includes(policy.memoryLabel)) return false;
    return item.blockedBy.every((blocker) => stateById.get(blocker) !== "open");
  });
}

export interface EpicStatus {
  parent: ItemId;
  total: number;
  open: number;
  closed: number;
  pctClosed: number;
}

export function computeEpicStatus(parent: ItemId, children: WorkItem[]): EpicStatus | null {
  if (children.length === 0) return null;
  const closed = children.filter((c) => c.state === "closed").length;
  return {
    parent,
    total: children.length,
    open: children.length - closed,
    closed,
    pctClosed: Math.round((closed / children.length) * 100),
  };
}
