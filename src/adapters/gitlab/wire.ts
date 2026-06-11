/** GitLab wire types (REST /api/v4 + GraphQL) — confined to the adapter. */

export interface GitLabUser {
  id: number;
  username: string;
  name?: string;
}

export interface GitLabIssue {
  iid: number;
  title: string;
  state: "opened" | "closed";
  labels: string[];
  assignees: GitLabUser[];
  author?: GitLabUser | null;
  description?: string | null;
  updated_at: string;
  web_url: string;
  issue_type?: string;
  time_stats?: {
    time_estimate: number;
    total_time_spent: number;
  };
}

export interface GitLabNote {
  id: number;
  body: string;
  created_at: string;
  author: GitLabUser;
  system?: boolean;
}

/** Response of POST /projects/:id/uploads. */
export interface GitLabUpload {
  /** Instance-relative URL, e.g. "/uploads/<hash>/file.png". */
  url: string;
  /** Project-rooted path, e.g. "/-/project/999/uploads/<hash>/file.png". */
  full_path: string;
  markdown: string;
}

/** Single-MR GET/POST/PUT response subset (the list endpoint omits head_pipeline). */
export interface GitLabMergeRequest {
  iid: number;
  title: string;
  description: string | null;
  state: "opened" | "closed" | "merged" | "locked";
  source_branch: string;
  target_branch: string;
  draft?: boolean;
  web_url: string;
  updated_at: string;
  head_pipeline?: { status: string } | null;
}

export interface WorkItemNode {
  iid: string;
  workItemType: { name: string };
  widgets: Array<{
    parent?: { iid: string } | null;
    linkedItems?: { nodes: Array<{ linkType: string; workItem: { iid: string } }> };
  }>;
}

export interface WorkItemsPage {
  project: {
    workItems: {
      nodes: WorkItemNode[];
      pageInfo: { endCursor: string | null; hasNextPage: boolean };
    } | null;
  } | null;
}
