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

/** A file to upload and attach to a work item. */
export interface AttachmentInput {
  filename: string;
  content: Uint8Array;
}

export interface Attachment {
  filename: string;
  /** URL of the uploaded file on the provider. */
  url: string;
  /** Markdown snippet that references the file from descriptions/comments. */
  markdown: string;
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

export type PullRequestState = "open" | "merged" | "closed";

/** Provider-neutral CI signal: GitLab pipelines / GitHub checks collapse to this. */
export type CiState = "none" | "pending" | "green" | "red";

export interface PullRequestDraft {
  title: string;
  /** Source branch. */
  source: string;
  /** Target branch. */
  target: string;
  description?: string;
  draft?: boolean;
  /** Work items this PR addresses; recorded as "Closes #N" trailers in the description. */
  issues?: ItemId[];
}

export interface PullRequest {
  id: string;
  title: string;
  state: PullRequestState;
  source: string;
  target: string;
  draft: boolean;
  ci: CiState;
  /** Issue ids parsed from "Closes #N" trailers in the description. */
  closesIssues: ItemId[];
  url: string;
  description: string;
  updatedAt: string;
}
