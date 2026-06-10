import type { FetchLike } from "../../src/adapters/gitlab/client.ts";
import type { GitLabIssue, GitLabNote, GitLabUser } from "../../src/adapters/gitlab/wire.ts";

interface StoredIssue extends GitLabIssue {
  description: string;
  author: GitLabUser;
  time_stats: { time_estimate: number; total_time_spent: number };
  /** Work-item parent iid, exposed via GraphQL hierarchy widget. */
  parent_iid: number | null;
  work_item_type: string;
}

/** GitLab's ChronicDuration subset: "1h30m", "-30m", h/m/s units. */
function parseGlDuration(duration: string): number {
  const negative = duration.startsWith("-");
  const body = negative ? duration.slice(1) : duration;
  let seconds = 0;
  for (const m of body.matchAll(/(\d+)([hms])/g)) {
    seconds += Number(m[1]) * (m[2] === "h" ? 3600 : m[2] === "m" ? 60 : 1);
  }
  return negative ? -seconds : seconds;
}

interface StoredLink {
  blocker_iid: number;
  blocked_iid: number;
  link_type: "blocks" | "relates_to";
}

/**
 * In-memory GitLab for contract tests: serves the REST + GraphQL surface the
 * adapter uses, with response shapes written from the GitLab API docs.
 * Returned via fetchImpl — no real network involved.
 */
export class FakeGitLabServer {
  issues = new Map<number, StoredIssue>();
  notes = new Map<number, GitLabNote[]>();
  links: StoredLink[] = [];
  users: GitLabUser[] = [];
  requestLog: string[] = [];
  private tokenUsers = new Map<string, GitLabUser>();
  private currentUser: GitLabUser = { id: 0, username: "nobody" };
  private nextIid = 1;
  private nextNoteId = 1;

  constructor(
    readonly baseUrl: string,
    readonly projectPath: string,
  ) {}

  /** Register an authorized token and the user it authenticates as. */
  addUser(token: string, user: GitLabUser): GitLabUser {
    if (!this.users.some((u) => u.id === user.id)) this.users.push(user);
    this.tokenUsers.set(token, user);
    return user;
  }

  seedIssue(partial: Partial<StoredIssue> & { title: string; author: GitLabUser }): StoredIssue {
    const iid = this.nextIid++;
    const issue: StoredIssue = {
      state: "opened",
      labels: [],
      assignees: [],
      description: "",
      updated_at: new Date().toISOString(),
      web_url: `${this.baseUrl}/${this.projectPath}/-/issues/${iid}`,
      issue_type: "issue",
      time_stats: { time_estimate: 0, total_time_spent: 0 },
      parent_iid: null,
      work_item_type: "Issue",
      ...partial,
      iid: partial.iid ?? iid,
    };
    this.issues.set(issue.iid, issue);
    this.notes.set(issue.iid, this.notes.get(issue.iid) ?? []);
    return issue;
  }

  /** The fetch implementation to hand to GitLabClient. */
  fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    this.requestLog.push(`${method} ${u.pathname}${u.search}`);

    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const user = this.tokenUsers.get(auth.replace(/^Bearer /, ""));
    if (!user) return json(401, { message: "401 Unauthorized" });
    this.currentUser = user;

    if (u.pathname === "/api/graphql") {
      return this.handleGraphql(JSON.parse(String(init?.body ?? "{}")));
    }
    return this.handleRest(u, method, init?.body ? JSON.parse(String(init.body)) : {});
  };

  // ---------- REST ----------

  private handleRest(u: URL, method: string, body: Record<string, unknown>): Response {
    const path = decodeURIComponent(u.pathname).replace(/^\/api\/v4\//, "/");
    const projectPrefix = `/projects/${this.projectPath}`;
    if (!path.startsWith(projectPrefix) && path !== "/user") {
      return json(404, { message: "404 Not Found" });
    }
    const sub = path === "/user" ? "/user" : path.slice(projectPrefix.length) || "/";

    if (sub === "/user") return json(200, this.currentUser);
    if (sub === "/" && method === "GET") {
      return json(200, {
        id: 999,
        path_with_namespace: this.projectPath,
        name_with_namespace: this.projectPath,
        web_url: `${this.baseUrl}/${this.projectPath}`,
      });
    }
    if (sub === "/users") {
      const q = (u.searchParams.get("search") ?? "").toLowerCase();
      return paged(
        u,
        this.users.filter(
          (usr) =>
            usr.username.toLowerCase().includes(q) || (usr.name ?? "").toLowerCase().includes(q),
        ),
      );
    }
    if (sub === "/issues" && method === "GET") return paged(u, this.filterIssues(u));
    if (sub === "/issues" && method === "POST") {
      const author = this.currentUser;
      const issue = this.seedIssue({
        title: String(body.title ?? ""),
        description: String(body.description ?? ""),
        labels: body.labels ? String(body.labels).split(",").filter(Boolean) : [],
        author,
      });
      return json(201, this.publicIssue(issue));
    }

    const issueMatch = sub.match(/^\/issues\/(\d+)(\/.*)?$/);
    if (issueMatch) {
      const iid = Number(issueMatch[1]);
      const rest = issueMatch[2] ?? "";
      const issue = this.issues.get(iid);
      if (!issue) return json(404, { message: "404 Issue Not Found" });
      if (rest === "" && method === "GET") return json(200, this.publicIssue(issue));
      if (rest === "" && method === "PUT") return this.updateIssue(issue, body);
      if (rest === "/notes" && method === "GET") {
        return paged(
          u,
          [...(this.notes.get(iid) ?? [])].sort((a, b) => a.id - b.id),
        );
      }
      if (rest === "/notes" && method === "POST") {
        const note: GitLabNote = {
          id: this.nextNoteId++,
          body: String(body.body ?? ""),
          created_at: new Date().toISOString(),
          author: this.currentUser,
        };
        this.notes.get(iid)!.push(note);
        return json(201, note);
      }
      if (rest === "/add_spent_time" && method === "POST") {
        const delta = parseGlDuration(String(body.duration ?? ""));
        const next = issue.time_stats.total_time_spent + delta;
        if (next < 0) {
          return json(400, {
            message: "400 Bad request - Time to subtract exceeds the total time spent",
          });
        }
        issue.time_stats.total_time_spent = next;
        return json(201, issue.time_stats);
      }
      if (rest === "/time_estimate" && method === "POST") {
        issue.time_stats.time_estimate = Math.max(0, parseGlDuration(String(body.duration ?? "")));
        return json(200, issue.time_stats);
      }
      if (rest === "/reset_time_estimate" && method === "POST") {
        issue.time_stats.time_estimate = 0;
        return json(200, issue.time_stats);
      }
      if (rest === "/links" && method === "POST") {
        const target = Number(body.target_issue_iid);
        if (!this.issues.has(target)) return json(404, { message: "404 Issue Not Found" });
        this.links.push({
          blocker_iid: iid,
          blocked_iid: target,
          link_type: (body.link_type as "blocks") ?? "relates_to",
        });
        return json(201, { source_issue: this.publicIssue(issue) });
      }
    }
    return json(404, { message: `404 Not Found: ${method} ${sub}` });
  }

  private filterIssues(u: URL): GitLabIssue[] {
    const p = u.searchParams;
    let out = [...this.issues.values()];
    const state = p.get("state");
    if (state && state !== "all") out = out.filter((i) => i.state === state);
    const search = p.get("search")?.toLowerCase();
    if (search) {
      out = out.filter((i) => `${i.title}\n${i.description}`.toLowerCase().includes(search));
    }
    const assignee = p.get("assignee_username");
    if (assignee) out = out.filter((i) => i.assignees.some((a) => a.username === assignee));
    const author = p.get("author_username");
    if (author) out = out.filter((i) => i.author.username === author);
    const labels = p.get("labels");
    if (labels) {
      const wanted = labels.split(",");
      out = out.filter((i) => wanted.every((l) => i.labels.includes(l)));
    }
    return out.map((i) => this.publicIssue(i));
  }

  private updateIssue(issue: StoredIssue, body: Record<string, unknown>): Response {
    if (body.assignee_ids !== undefined) {
      const ids = (body.assignee_ids as number[]).filter((n) => n !== 0);
      issue.assignees = ids.map(
        (id) => this.users.find((usr) => usr.id === id) ?? { id, username: `user-${id}` },
      );
    }
    if (body.add_labels) {
      for (const l of String(body.add_labels).split(",")) {
        if (l && !issue.labels.includes(l)) issue.labels.push(l);
      }
    }
    if (body.remove_labels) {
      const drop = String(body.remove_labels).split(",");
      issue.labels = issue.labels.filter((l) => !drop.includes(l));
    }
    if (body.title !== undefined) issue.title = String(body.title);
    if (body.description !== undefined) issue.description = String(body.description);
    if (body.state_event === "close") issue.state = "closed";
    if (body.state_event === "reopen") issue.state = "opened";
    issue.updated_at = new Date().toISOString();
    return json(200, this.publicIssue(issue));
  }

  private publicIssue(issue: StoredIssue): GitLabIssue {
    const { parent_iid: _p, work_item_type: _w, ...wire } = issue;
    return structuredClone(wire);
  }

  // ---------- GraphQL ----------

  private handleGraphql(payload: { query: string; variables: Record<string, unknown> }): Response {
    const { query, variables } = payload;
    if ((variables.fullPath ?? null) !== null && variables.fullPath !== this.projectPath) {
      return json(200, { data: { project: null } });
    }

    if (query.includes("workItemCreate")) {
      const input = variables.input as {
        title: string;
        description?: string;
        hierarchyWidget?: { parentId?: string };
      };
      const parentIid = input.hierarchyWidget?.parentId
        ? gidToIid(input.hierarchyWidget.parentId)
        : null;
      if (parentIid !== null && !this.issues.has(parentIid)) {
        return json(200, {
          data: { workItemCreate: { errors: ["Parent not found"], workItem: null } },
        });
      }
      const issue = this.seedIssue({
        title: input.title,
        description: input.description ?? "",
        author: this.currentUser,
        issue_type: "task",
        work_item_type: "Task",
        parent_iid: parentIid,
      });
      return json(200, {
        data: {
          workItemCreate: {
            errors: [],
            workItem: { id: iidToGid(issue.iid), iid: String(issue.iid) },
          },
        },
      });
    }

    if (query.includes("workItemUpdate")) {
      const input = variables.input as {
        id: string;
        hierarchyWidget?: { parentId: string | null };
      };
      const issue = this.issues.get(gidToIid(input.id));
      if (!issue) {
        return json(200, { data: { workItemUpdate: { errors: ["Not found"], workItem: null } } });
      }
      if (input.hierarchyWidget) {
        issue.parent_iid = input.hierarchyWidget.parentId
          ? gidToIid(input.hierarchyWidget.parentId)
          : null;
      }
      return json(200, {
        data: { workItemUpdate: { errors: [], workItem: { id: input.id } } },
      });
    }

    if (query.includes("workItemTypes")) {
      return json(200, {
        data: {
          project: {
            workItemTypes: {
              nodes: [
                { id: "gid://gitlab/WorkItems::Type/1", name: "Issue" },
                { id: "gid://gitlab/WorkItems::Type/5", name: "Task" },
                { id: "gid://gitlab/WorkItems::Type/8", name: "Epic" },
              ],
            },
          },
        },
      });
    }

    if (query.includes("workItems(iids:")) {
      const iids = (variables.iids as string[]).map(Number);
      const nodes = iids
        .filter((iid) => this.issues.has(iid))
        .map((iid) => ({ id: iidToGid(iid), iid: String(iid) }));
      return json(200, { data: { project: { workItems: { nodes } } } });
    }

    // Paginated snapshot: hierarchy + linked items, 2 per page to exercise paging.
    if (query.includes("workItems(first:")) {
      const all = [...this.issues.values()].sort((a, b) => a.iid - b.iid);
      const pageSize = 2;
      const afterIdx = variables.after ? Number(variables.after) : 0;
      const page = all.slice(afterIdx, afterIdx + pageSize);
      const nodes = page.map((issue) => ({
        iid: String(issue.iid),
        workItemType: { name: issue.work_item_type },
        widgets: [
          { parent: issue.parent_iid === null ? null : { iid: String(issue.parent_iid) } },
          {
            linkedItems: {
              nodes: this.links
                .filter((l) => l.link_type === "blocks" && l.blocked_iid === issue.iid)
                .map((l) => ({
                  linkType: "is_blocked_by",
                  workItem: { iid: String(l.blocker_iid) },
                }))
                .concat(
                  this.links
                    .filter((l) => l.link_type === "blocks" && l.blocker_iid === issue.iid)
                    .map((l) => ({ linkType: "blocks", workItem: { iid: String(l.blocked_iid) } })),
                ),
            },
          },
        ],
      }));
      const end = afterIdx + page.length;
      return json(200, {
        data: {
          project: {
            workItems: {
              nodes,
              pageInfo: { endCursor: String(end), hasNextPage: end < all.length },
            },
          },
        },
      });
    }

    return json(200, { errors: [{ message: `unhandled query: ${query.slice(0, 80)}` }] });
  }
}

const iidToGid = (iid: number) => `gid://gitlab/WorkItem/${10_000 + iid}`;
const gidToIid = (gid: string) => Number(gid.split("/").pop()) - 10_000;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** REST list pagination via per_page/page + x-next-page, like real GitLab. */
function paged(u: URL, items: unknown[]): Response {
  const perPage = Number(u.searchParams.get("per_page") ?? "20");
  const page = Number(u.searchParams.get("page") ?? "1");
  const start = (page - 1) * perPage;
  const chunk = items.slice(start, start + perPage);
  const hasNext = start + perPage < items.length;
  return new Response(JSON.stringify(chunk), {
    status: 200,
    headers: {
      "content-type": "application/json",
      ...(hasNext ? { "x-next-page": String(page + 1) } : {}),
    },
  });
}
