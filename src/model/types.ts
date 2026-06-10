/** Canonical, provider-neutral domain model. Adapters map wire types to/from these. */

/** String everywhere: GitLab "42" today, Jira "PROJ-123" tomorrow. */
export type ItemId = string;

export type ItemKind = "epic" | "task";
export type ItemState = "open" | "closed";

export interface User {
  id: string;
  username: string;
  name?: string;
}

export interface WorkItem {
  id: ItemId;
  kind: ItemKind;
  title: string;
  state: ItemState;
  labels: string[];
  assignees: User[];
  author: User | null;
  parent: ItemId | null;
  /** Ids of items that block this one (canonical direction: "is_blocked_by"). */
  blockedBy: ItemId[];
  url: string;
  description: string;
  updatedAt: string;
  /** Accumulated time spent, in seconds (0 = none recorded). */
  timeSpentSeconds: number;
  /** Time estimate, in seconds (0 = no estimate). */
  timeEstimateSeconds: number;
  /** Provider wire payload, cached for debugging only. Stripped from CLI output. */
  raw?: unknown;
}

export interface Comment {
  id: string;
  body: string;
  author: User;
  createdAt: string;
}

export interface WorkItemDraft {
  title: string;
  description?: string;
  parent?: ItemId | null;
  labels?: string[];
  milestone?: string;
  /** Provider-specific: GitLab group epic id (Premium). Adapters without epics ignore it. */
  epicId?: string;
}

/** Partial update. Labels are add/remove (never replace); assignees are set-exactly. */
export interface WorkItemPatch {
  /** Set the full assignee list; empty array clears all assignees. */
  assigneeIds?: string[];
  addLabels?: string[];
  removeLabels?: string[];
  title?: string;
  description?: string;
}

export type LinkType = "blocks" | "is_blocked_by";
