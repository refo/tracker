import type { AdapterCapabilities, RemoteQuery, TrackerAdapter } from "../../src/adapters/types.ts";
import { DomainError } from "../../src/errors.ts";
import type {
  Comment,
  ItemId,
  ItemState,
  User,
  WorkItem,
  WorkItemDraft,
  WorkItemPatch,
} from "../../src/model/types.ts";

/**
 * Shared in-memory backend so multiple FakeAdapter identities (concurrent
 * claimers) mutate the same state, like two agents hitting one GitLab.
 */
export class FakeBackend {
  items = new Map<ItemId, WorkItem>();
  comments = new Map<ItemId, Comment[]>();
  users: User[] = [];
  private nextItemId = 1;
  private nextCommentId = 1;

  newItemId(): ItemId {
    return String(this.nextItemId++);
  }

  newCommentId(): string {
    return String(this.nextCommentId++);
  }

  addUser(user: User): User {
    if (!this.users.some((u) => u.id === user.id)) this.users.push(user);
    return user;
  }

  mustGet(id: ItemId): WorkItem {
    const item = this.items.get(id);
    if (!item) throw new DomainError(`#${id} not found`);
    return item;
  }
}

const clone = <T>(v: T): T => structuredClone(v);

export class FakeAdapter implements TrackerAdapter {
  readonly provider = "fake";

  constructor(
    readonly backend: FakeBackend,
    private me: User,
    private caps: Partial<AdapterCapabilities> = {},
  ) {
    backend.addUser(me);
  }

  capabilities(): AdapterCapabilities {
    return {
      nativeBlocking: true,
      nativeHierarchy: true,
      serverSearch: true,
      ...this.caps,
    };
  }

  async whoami(): Promise<User> {
    return clone(this.me);
  }

  async fetchAll(): Promise<WorkItem[]> {
    return clone([...this.backend.items.values()]);
  }

  async get(id: ItemId): Promise<WorkItem> {
    return clone(this.backend.mustGet(id));
  }

  async create(draft: WorkItemDraft): Promise<WorkItem> {
    if (draft.parent && !this.backend.items.has(draft.parent)) {
      throw new DomainError(`parent #${draft.parent} not found`);
    }
    const id = this.backend.newItemId();
    const item: WorkItem = {
      id,
      kind: "task",
      title: draft.title,
      state: "open",
      labels: [...(draft.labels ?? [])],
      assignees: [],
      author: clone(this.me),
      parent: draft.parent ?? null,
      blockedBy: [],
      url: `fake://item/${id}`,
      description: draft.description ?? "",
      updatedAt: new Date().toISOString(),
    };
    this.backend.items.set(id, item);
    this.backend.comments.set(id, []);
    return clone(item);
  }

  async update(id: ItemId, patch: WorkItemPatch): Promise<void> {
    const item = this.backend.mustGet(id);
    if (patch.assigneeIds) {
      item.assignees = patch.assigneeIds.map(
        (uid) =>
          this.backend.users.find((u) => u.id === uid) ?? { id: uid, username: `user-${uid}` },
      );
    }
    if (patch.addLabels) {
      for (const l of patch.addLabels) if (!item.labels.includes(l)) item.labels.push(l);
    }
    if (patch.removeLabels) {
      item.labels = item.labels.filter((l) => !patch.removeLabels!.includes(l));
    }
    if (patch.title !== undefined) item.title = patch.title;
    if (patch.description !== undefined) item.description = patch.description;
    item.updatedAt = new Date().toISOString();
  }

  async transition(id: ItemId, to: ItemState): Promise<void> {
    const item = this.backend.mustGet(id);
    item.state = to;
    item.updatedAt = new Date().toISOString();
  }

  async link(blocker: ItemId, blocked: ItemId): Promise<void> {
    this.backend.mustGet(blocker);
    const target = this.backend.mustGet(blocked);
    if (!target.blockedBy.includes(blocker)) target.blockedBy.push(blocker);
  }

  async setParent(child: ItemId, parent: ItemId | null): Promise<void> {
    const item = this.backend.mustGet(child);
    if (parent !== null) this.backend.mustGet(parent);
    item.parent = parent;
  }

  async comment(id: ItemId, body: string): Promise<void> {
    this.backend.mustGet(id);
    const list = this.backend.comments.get(id) ?? [];
    list.push({
      id: this.backend.newCommentId(),
      body,
      author: clone(this.me),
      createdAt: new Date().toISOString(),
    });
    this.backend.comments.set(id, list);
  }

  async listComments(id: ItemId): Promise<Comment[]> {
    this.backend.mustGet(id);
    return clone(this.backend.comments.get(id) ?? []);
  }

  async searchRemote(q: RemoteQuery): Promise<WorkItem[]> {
    const text = q.text?.toLowerCase();
    const state = q.state ?? "all";
    const assignee = q.assignee?.replace(/^@/, "").toLowerCase();
    const author = q.author?.replace(/^@/, "").toLowerCase();
    return clone(
      [...this.backend.items.values()].filter((i) => {
        if (text && !`${i.title}\n${i.description}`.toLowerCase().includes(text)) return false;
        if (state !== "all" && i.state !== state) return false;
        if (q.label && !i.labels.includes(q.label)) return false;
        if (assignee && !i.assignees.some((a) => a.username.toLowerCase() === assignee))
          return false;
        if (author && i.author?.username.toLowerCase() !== author) return false;
        return true;
      }),
    );
  }

  async resolveUsers(query: string): Promise<User[]> {
    const q = query.toLowerCase();
    return clone(
      this.backend.users.filter(
        (u) => u.username.toLowerCase().includes(q) || (u.name ?? "").toLowerCase().includes(q),
      ),
    );
  }
}
