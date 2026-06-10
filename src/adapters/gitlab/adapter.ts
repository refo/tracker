import { DomainError, UsageError } from "../../errors.ts";
import type {
  Comment,
  ItemId,
  ItemState,
  User,
  WorkItem,
  WorkItemDraft,
  WorkItemPatch,
} from "../../model/types.ts";
import type { AdapterCapabilities, RemoteQuery, TrackerAdapter } from "../types.ts";
import { type FetchLike, GitLabClient, GitLabHttpError } from "./client.ts";
import { type HierarchyInfo, mapIssue, mapUser, upsertBlockedByTrailer } from "./map.ts";
import type { GitLabIssue, GitLabNote, GitLabUser, WorkItemsPage } from "./wire.ts";

export interface GitLabAdapterOptions {
  baseUrl: string;
  /** Project path ("group/repo") or numeric id. */
  project: string;
  token: string;
  nativeBlocking: boolean;
  fetchImpl?: FetchLike;
}

const WORK_ITEMS_QUERY = `
query trackerWorkItems($fullPath: ID!, $after: String) {
  project(fullPath: $fullPath) {
    workItems(first: 100, after: $after) {
      nodes {
        iid
        workItemType { name }
        widgets {
          ... on WorkItemWidgetHierarchy { parent { iid } }
          ... on WorkItemWidgetLinkedItems {
            linkedItems(first: 100) { nodes { linkType workItem { iid } } }
          }
        }
      }
      pageInfo { endCursor hasNextPage }
    }
  }
}`;

const WORK_ITEM_GIDS_QUERY = `
query trackerWorkItemGids($fullPath: ID!, $iids: [String!]) {
  project(fullPath: $fullPath) {
    workItems(iids: $iids) { nodes { id iid } }
  }
}`;

const WORK_ITEM_TYPES_QUERY = `
query trackerWorkItemTypes($fullPath: ID!) {
  project(fullPath: $fullPath) {
    workItemTypes { nodes { id name } }
  }
}`;

const WORK_ITEM_CREATE_MUTATION = `
mutation trackerWorkItemCreate($input: WorkItemCreateInput!) {
  workItemCreate(input: $input) {
    errors
    workItem { id iid }
  }
}`;

const WORK_ITEM_UPDATE_MUTATION = `
mutation trackerWorkItemSetParent($input: WorkItemUpdateInput!) {
  workItemUpdate(input: $input) {
    errors
    workItem { id }
  }
}`;

export class GitLabAdapter implements TrackerAdapter {
  readonly provider = "gitlab";
  private client: GitLabClient;
  private projectRef: string;
  private fullPath: string | null;
  private nativeBlocking: boolean;
  private me: User | null = null;
  private taskTypeGid: string | null = null;

  constructor(opts: GitLabAdapterOptions) {
    this.client = new GitLabClient({
      baseUrl: opts.baseUrl,
      token: opts.token,
      fetchImpl: opts.fetchImpl,
    });
    this.projectRef = encodeURIComponent(opts.project);
    this.fullPath = /^\d+$/.test(opts.project) ? null : opts.project;
    this.nativeBlocking = opts.nativeBlocking;
  }

  capabilities(): AdapterCapabilities {
    return { nativeBlocking: this.nativeBlocking, nativeHierarchy: true, serverSearch: true };
  }

  /** GraphQL needs the full path; resolve once when config only had a numeric id. */
  private async getFullPath(): Promise<string> {
    if (this.fullPath) return this.fullPath;
    const project = await this.client.rest<{ path_with_namespace: string }>(
      `projects/${this.projectRef}`,
    );
    this.fullPath = project.path_with_namespace;
    return this.fullPath;
  }

  async whoami(): Promise<User> {
    if (!this.me) this.me = mapUser(await this.client.rest<GitLabUser>("user"));
    return this.me;
  }

  private async fetchHierarchy(): Promise<Map<ItemId, HierarchyInfo>> {
    const fullPath = await this.getFullPath();
    const out = new Map<ItemId, HierarchyInfo>();
    let after: string | null = null;
    for (let page = 0; page < 100; page++) {
      const data: WorkItemsPage = await this.client.graphql<WorkItemsPage>(WORK_ITEMS_QUERY, {
        fullPath,
        after,
      });
      const conn = data.project?.workItems;
      if (!conn) break;
      for (const node of conn.nodes) {
        const parent = node.widgets.find((w) => w.parent !== undefined)?.parent;
        const linked = node.widgets.find((w) => w.linkedItems !== undefined)?.linkedItems;
        const blockedBy: ItemId[] = [];
        for (const link of linked?.nodes ?? []) {
          const type = link.linkType.toLowerCase();
          if (type === "is_blocked_by" || type === "blocked_by") blockedBy.push(link.workItem.iid);
        }
        out.set(node.iid, {
          parent: parent ? parent.iid : null,
          blockedBy,
          typeName: node.workItemType.name,
        });
      }
      if (!conn.pageInfo.hasNextPage) break;
      after = conn.pageInfo.endCursor;
    }
    return out;
  }

  /**
   * Complete snapshot in two batched passes (never one request per issue):
   * REST issue pages for core fields + GraphQL work-item pages carrying both
   * hierarchy and dependency links.
   */
  async fetchAll(): Promise<WorkItem[]> {
    const [issues, hierarchy] = await Promise.all([
      this.client.rest<GitLabIssue[]>(`projects/${this.projectRef}/issues`, {
        query: { state: "all" },
        paginate: true,
      }),
      this.fetchHierarchy(),
    ]);
    return issues.map((issue) => mapIssue(issue, hierarchy.get(String(issue.iid))));
  }

  async get(id: ItemId): Promise<WorkItem> {
    let issue: GitLabIssue;
    try {
      issue = await this.client.rest<GitLabIssue>(`projects/${this.projectRef}/issues/${id}`);
    } catch (e) {
      if (e instanceof GitLabHttpError && e.status === 404) {
        throw new DomainError(`#${id} not found`);
      }
      throw e;
    }
    return mapIssue(issue);
  }

  private async resolveGids(iids: ItemId[]): Promise<Map<ItemId, string>> {
    const fullPath = await this.getFullPath();
    const data = await this.client.graphql<{
      project: { workItems: { nodes: Array<{ id: string; iid: string }> } | null } | null;
    }>(WORK_ITEM_GIDS_QUERY, { fullPath, iids });
    const out = new Map<ItemId, string>();
    for (const node of data.project?.workItems?.nodes ?? []) out.set(node.iid, node.id);
    return out;
  }

  private async getTaskTypeGid(): Promise<string> {
    if (this.taskTypeGid) return this.taskTypeGid;
    const fullPath = await this.getFullPath();
    const data = await this.client.graphql<{
      project: { workItemTypes: { nodes: Array<{ id: string; name: string }> } | null } | null;
    }>(WORK_ITEM_TYPES_QUERY, { fullPath });
    const task = data.project?.workItemTypes?.nodes.find((t) => t.name === "Task");
    if (!task) throw new UsageError("project has no Task work-item type");
    this.taskTypeGid = task.id;
    return task.id;
  }

  async create(draft: WorkItemDraft): Promise<WorkItem> {
    if (draft.parent) {
      const gids = await this.resolveGids([draft.parent]);
      const parentGid = gids.get(draft.parent);
      if (!parentGid) throw new DomainError(`parent #${draft.parent} not found`);
      const fullPath = await this.getFullPath();
      const data = await this.client.graphql<{
        workItemCreate: { errors: string[]; workItem: { iid: string } | null };
      }>(WORK_ITEM_CREATE_MUTATION, {
        input: {
          namespacePath: fullPath,
          title: draft.title,
          description: draft.description ?? "",
          workItemTypeId: await this.getTaskTypeGid(),
          hierarchyWidget: { parentId: parentGid },
        },
      });
      if (data.workItemCreate.errors.length || !data.workItemCreate.workItem) {
        throw new DomainError(`workItemCreate: ${data.workItemCreate.errors.join("; ")}`);
      }
      const iid = data.workItemCreate.workItem.iid;
      if (draft.labels?.length || draft.milestone) {
        await this.client.rest(`projects/${this.projectRef}/issues/${iid}`, {
          method: "PUT",
          body: {
            ...(draft.labels?.length ? { add_labels: draft.labels.join(",") } : {}),
            ...(draft.milestone ? { milestone_id: draft.milestone } : {}),
          },
        });
      }
      const created = await this.get(iid);
      return { ...created, parent: draft.parent };
    }

    const issue = await this.client.rest<GitLabIssue>(`projects/${this.projectRef}/issues`, {
      method: "POST",
      body: {
        title: draft.title,
        description: draft.description ?? "",
        ...(draft.labels?.length ? { labels: draft.labels.join(",") } : {}),
        ...(draft.milestone ? { milestone_id: draft.milestone } : {}),
        ...(draft.epicId ? { epic_id: Number(draft.epicId) } : {}),
      },
    });
    return mapIssue(issue);
  }

  async update(id: ItemId, patch: WorkItemPatch): Promise<void> {
    const body: Record<string, unknown> = {};
    if (patch.assigneeIds) {
      body.assignee_ids = patch.assigneeIds.length ? patch.assigneeIds.map(Number) : [0];
    }
    if (patch.addLabels?.length) body.add_labels = patch.addLabels.join(",");
    if (patch.removeLabels?.length) body.remove_labels = patch.removeLabels.join(",");
    if (patch.title !== undefined) body.title = patch.title;
    if (patch.description !== undefined) body.description = patch.description;
    if (Object.keys(body).length === 0) return;
    await this.client.rest(`projects/${this.projectRef}/issues/${id}`, { method: "PUT", body });
  }

  async transition(id: ItemId, to: ItemState): Promise<void> {
    await this.client.rest(`projects/${this.projectRef}/issues/${id}`, {
      method: "PUT",
      body: { state_event: to === "closed" ? "close" : "reopen" },
    });
  }

  async link(blocker: ItemId, blocked: ItemId): Promise<void> {
    if (this.nativeBlocking) {
      await this.client.rest(`projects/${this.projectRef}/issues/${blocker}/links`, {
        method: "POST",
        body: {
          target_project_id: decodeURIComponent(this.projectRef),
          target_issue_iid: Number(blocked),
          link_type: "blocks",
        },
      });
      return;
    }
    // Fallback (no Premium blocking links): a machine-readable trailer in the
    // blocked issue's description; parsed back out on every sync at zero cost.
    const item = await this.get(blocked);
    await this.update(blocked, {
      description: upsertBlockedByTrailer(item.description, [blocker]),
    });
  }

  async setParent(child: ItemId, parent: ItemId | null): Promise<void> {
    const wanted = parent === null ? [child] : [child, parent];
    const gids = await this.resolveGids(wanted);
    const childGid = gids.get(child);
    if (!childGid) throw new DomainError(`#${child} not found`);
    let parentGid: string | null = null;
    if (parent !== null) {
      parentGid = gids.get(parent) ?? null;
      if (!parentGid) throw new DomainError(`parent #${parent} not found`);
    }
    const data = await this.client.graphql<{ workItemUpdate: { errors: string[] } }>(
      WORK_ITEM_UPDATE_MUTATION,
      { input: { id: childGid, hierarchyWidget: { parentId: parentGid } } },
    );
    if (data.workItemUpdate.errors.length) {
      throw new DomainError(`workItemUpdate: ${data.workItemUpdate.errors.join("; ")}`);
    }
  }

  async comment(id: ItemId, body: string): Promise<void> {
    await this.client.rest(`projects/${this.projectRef}/issues/${id}/notes`, {
      method: "POST",
      body: { body },
    });
  }

  async listComments(id: ItemId): Promise<Comment[]> {
    const notes = await this.client.rest<GitLabNote[]>(
      `projects/${this.projectRef}/issues/${id}/notes`,
      { query: { sort: "asc", order_by: "created_at" }, paginate: true },
    );
    return notes
      .filter((n) => !n.system)
      .map((n) => ({
        id: String(n.id),
        body: n.body,
        author: mapUser(n.author),
        createdAt: n.created_at,
      }));
  }

  async searchRemote(q: RemoteQuery): Promise<WorkItem[]> {
    const state = q.state ?? "all";
    const issues = await this.client.rest<GitLabIssue[]>(`projects/${this.projectRef}/issues`, {
      query: {
        ...(q.text ? { search: q.text, in: "title,description" } : {}),
        ...(q.assignee ? { assignee_username: q.assignee.replace(/^@/, "") } : {}),
        ...(q.author ? { author_username: q.author.replace(/^@/, "") } : {}),
        ...(q.label ? { labels: q.label } : {}),
        ...(state !== "all" ? { state: state === "open" ? "opened" : "closed" } : {}),
      },
      paginate: true,
    });
    return issues.map((issue) => mapIssue(issue));
  }

  async resolveUsers(query: string): Promise<User[]> {
    const users = await this.client.rest<GitLabUser[]>(`projects/${this.projectRef}/users`, {
      query: { search: query },
      paginate: true,
    });
    return users.map(mapUser);
  }

  /** Extra connectivity probes for `tracker doctor` (not part of the port). */
  async probeProject(): Promise<{ name: string; webUrl: string }> {
    const project = await this.client.rest<{ name_with_namespace: string; web_url: string }>(
      `projects/${this.projectRef}`,
    );
    return { name: project.name_with_namespace, webUrl: project.web_url };
  }

  async probeGraphql(): Promise<boolean> {
    await this.getTaskTypeGid();
    return true;
  }
}
