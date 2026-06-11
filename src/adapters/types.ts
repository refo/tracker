import type {
  Attachment,
  AttachmentInput,
  Comment,
  ItemId,
  ItemState,
  PullRequest,
  PullRequestDraft,
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
  /** Provider supports time tracking (tracker spend / estimate). */
  timeTracking: boolean;
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
  /**
   * Upload files and attach them to the item so a zero-context reader finds
   * them on the item itself (one comment containing the optional message plus
   * every file's markdown reference). Returns one Attachment per input file.
   */
  attach(id: ItemId, files: AttachmentInput[], message?: string): Promise<Attachment[]>;
  /** Add to time spent; negative seconds subtract. Only when capabilities().timeTracking. */
  addTimeSpent(id: ItemId, seconds: number): Promise<void>;
  /** Set the time estimate; 0 clears it. Only when capabilities().timeTracking. */
  setTimeEstimate(id: ItemId, seconds: number): Promise<void>;
  /** Server-side search; only called when capabilities().serverSearch is true. */
  searchRemote(q: RemoteQuery): Promise<WorkItem[]>;
  resolveUsers(query: string): Promise<User[]>;
}

/**
 * The merge port: pull/merge requests + their CI signal. Deliberately separate
 * from TrackerAdapter — issues and code hosting are different capabilities
 * (Jira + GitHub is a common mix), selected independently via merge_provider.
 * Issue closing on merge lives in core (mergeAndCloseIssues), never in
 * provider magic, so it works across mixed providers by construction.
 */
export interface MergeAdapter {
  readonly provider: string;
  prCreate(draft: PullRequestDraft): Promise<PullRequest>;
  prGet(id: string): Promise<PullRequest>;
  /** Merge an open PR. Throws DomainError when the provider refuses (not open, conflicts). */
  prMerge(id: string): Promise<void>;
  prComment(id: string, body: string): Promise<void>;
  prListComments(id: string): Promise<Comment[]>;
  prClose(id: string): Promise<void>;
  prReopen(id: string): Promise<void>;
}
