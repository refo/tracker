import type {
  Comment,
  ItemId,
  ItemState,
  User,
  WorkItem,
  WorkItemDraft,
  WorkItemPatch,
} from "../model/types.ts";

export interface AdapterCapabilities {
  /** Provider supports first-class blocking links (GitLab Premium). */
  nativeBlocking: boolean;
  /** Provider supports parent/child hierarchy natively. */
  nativeHierarchy: boolean;
  /** Provider supports server-side search (tracker search --remote). */
  serverSearch: boolean;
}

export interface RemoteQuery {
  text?: string;
  assignee?: string;
  author?: string;
  label?: string;
  state?: ItemState | "all";
}

/**
 * The provider port. Core policies (ready, claim, release, epic-status, memory,
 * local search) are built ONLY on this interface plus the local cache —
 * they must never import provider code.
 */
export interface TrackerAdapter {
  readonly provider: string;
  capabilities(): AdapterCapabilities;
  whoami(): Promise<User>;
  /** Complete snapshot including links and hierarchy; the sync source of truth. */
  fetchAll(): Promise<WorkItem[]>;
  get(id: ItemId): Promise<WorkItem>;
  create(draft: WorkItemDraft): Promise<WorkItem>;
  update(id: ItemId, patch: WorkItemPatch): Promise<void>;
  transition(id: ItemId, to: ItemState): Promise<void>;
  /** Record "blocker blocks blocked". Falls back to description trailers when not native. */
  link(blocker: ItemId, blocked: ItemId): Promise<void>;
  setParent(child: ItemId, parent: ItemId | null): Promise<void>;
  comment(id: ItemId, body: string): Promise<void>;
  listComments(id: ItemId): Promise<Comment[]>;
  /** Server-side search; only called when capabilities().serverSearch is true. */
  searchRemote(q: RemoteQuery): Promise<WorkItem[]>;
  resolveUsers(query: string): Promise<User[]>;
}
