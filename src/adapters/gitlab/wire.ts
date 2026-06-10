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
}

export interface GitLabNote {
  id: number;
  body: string;
  created_at: string;
  author: GitLabUser;
  system?: boolean;
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
