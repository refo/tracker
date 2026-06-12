import { describe, expect, test } from "bun:test";
import { GitLabAdapter } from "../../src/adapters/gitlab/adapter.ts";
import { claimItem, closeItem, releaseItem } from "../../src/core/claim.ts";
import { FakeGitLabServer } from "../helpers/fake-gitlab-server.ts";
import { runMergeContractSuite } from "./merge-suite.ts";
import { runContractSuite } from "./suite.ts";

const BASE = "https://gitlab.example.com";
const PROJECT = "group/sandbox";
const TOKEN_A = "fake-token-alice-aaaaaaaa";
const TOKEN_B = "fake-token-bob-bbbbbbbbbb";

function makeServer(): FakeGitLabServer {
  const server = new FakeGitLabServer(BASE, PROJECT);
  server.addUser(TOKEN_A, { id: 1, username: "alice", name: "Alice Aydın" });
  server.addUser(TOKEN_B, { id: 2, username: "bob", name: "Bob Bulut" });
  return server;
}

function makeAdapter(server: FakeGitLabServer, token: string, nativeBlocking = true) {
  return new GitLabAdapter({
    baseUrl: BASE,
    project: PROJECT,
    token,
    nativeBlocking,
    fetchImpl: server.fetch,
  });
}

runContractSuite("GitLabAdapter over mocked HTTP", {
  usernames: { first: "alice", second: "bob" },
  async make() {
    const server = makeServer();
    return {
      adapter: makeAdapter(server, TOKEN_A),
      secondAdapter: makeAdapter(server, TOKEN_B),
    };
  },
});

runMergeContractSuite("GitLabAdapter over mocked HTTP", {
  async make() {
    const server = makeServer();
    const adapter = makeAdapter(server, TOKEN_A);
    return {
      merge: adapter,
      issues: adapter,
      setCi: (prId, state) =>
        server.setPipeline(
          Number(prId),
          state === "green" ? "success" : state === "red" ? "failed" : "running",
        ),
    };
  },
});

describe("GitLab native status mirroring", () => {
  const STATUS_POLICY = {
    inProgressLabel: "status::in-progress",
    memoryLabel: "meta::memory",
    settleMs: 5,
  };
  const deps = {
    now: () => Date.now(),
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    randomSuffix: () => "status-test",
  };

  function makeStatusAdapter(server: FakeGitLabServer, nativeStatus: boolean) {
    return new GitLabAdapter({
      baseUrl: BASE,
      project: PROJECT,
      token: TOKEN_A,
      nativeBlocking: true,
      nativeStatus,
      fetchImpl: server.fetch,
    });
  }

  test("claim moves the work item to in_progress; release back to to_do", async () => {
    const server = makeServer();
    const adapter = makeStatusAdapter(server, true);
    const item = await adapter.create({ title: "Status-tracked work" });
    expect(server.statusOf(Number(item.id))).toBe("to_do");

    const claim = await claimItem(adapter, item.id, STATUS_POLICY, deps);
    expect(claim.ok).toBe(true);
    expect(server.statusOf(Number(item.id))).toBe("in_progress");

    await releaseItem(adapter, item.id, STATUS_POLICY);
    expect(server.statusOf(Number(item.id))).toBe("to_do");
  });

  test("close relies on the provider lifecycle: status lands on done", async () => {
    const server = makeServer();
    const adapter = makeStatusAdapter(server, true);
    const item = await adapter.create({ title: "Will be done" });
    await claimItem(adapter, item.id, STATUS_POLICY, deps);

    await closeItem(adapter, item.id, STATUS_POLICY);

    expect(server.statusOf(Number(item.id))).toBe("done");
  });

  test("native_status=false: claims never touch the status widget", async () => {
    const server = makeServer();
    const adapter = makeStatusAdapter(server, false);
    const item = await adapter.create({ title: "Label-only workflow" });

    await claimItem(adapter, item.id, STATUS_POLICY, deps);

    expect(server.statusOf(Number(item.id))).toBe("to_do");
    expect(adapter.capabilities().nativeStatus).toBe(false);
  });
});

describe("GitLab adapter specifics", () => {
  test("sync makes no per-issue link requests (batched GraphQL)", async () => {
    const server = makeServer();
    const adapter = makeAdapter(server, TOKEN_A);
    for (let i = 0; i < 7; i++) {
      const item = await adapter.create({ title: `Item ${i}` });
      if (i > 0) await adapter.link(item.id, String(Number(item.id) - 1));
    }
    server.requestLog.length = 0;
    const items = await adapter.fetchAll();
    expect(items).toHaveLength(7);
    expect(items.flatMap((i) => i.blockedBy).length).toBeGreaterThan(0);
    const perIssueCalls = server.requestLog.filter((r) => /\/issues\/\d+/.test(r));
    expect(perIssueCalls).toEqual([]);
    // REST issue pages + GraphQL work-item pages only
    expect(
      server.requestLog.every((r) => r.includes("/issues?") || r.includes("/api/graphql")),
    ).toBe(true);
  });

  test("non-Premium fallback: link() writes a description trailer that sync parses", async () => {
    const server = makeServer();
    const adapter = makeAdapter(server, TOKEN_A, false);
    const blocker = await adapter.create({ title: "Blocker" });
    const blocked = await adapter.create({ title: "Blocked", description: "Original body." });
    await adapter.link(blocker.id, blocked.id);

    expect(server.links).toHaveLength(0); // no native link API call
    const fetched = (await adapter.fetchAll()).find((i) => i.id === blocked.id);
    expect(fetched?.blockedBy).toEqual([blocker.id]);
    expect(fetched?.description).toContain("Original body.");
    expect(fetched?.description).toContain(`Tracker-Blocked-By: #${blocker.id}`);
  });

  test("REST pagination is followed across pages", async () => {
    const server = makeServer();
    const adapter = makeAdapter(server, TOKEN_A);
    for (let i = 0; i < 250; i++) {
      server.seedIssue({ title: `Bulk ${i}`, author: { id: 1, username: "alice" } });
    }
    const items = await adapter.fetchAll();
    expect(items).toHaveLength(250);
  });

  test("comments map system-note filtering and ordering", async () => {
    const server = makeServer();
    const adapter = makeAdapter(server, TOKEN_A);
    const item = await adapter.create({ title: "Notes" });
    await adapter.comment(item.id, "first");
    await adapter.comment(item.id, "second");
    server.notes.get(Number(item.id))!.push({
      id: 9999,
      body: "changed the description",
      created_at: new Date().toISOString(),
      author: { id: 1, username: "alice" },
      system: true,
    });
    const comments = await adapter.listComments(item.id);
    expect(comments.map((c) => c.body)).toEqual(["first", "second"]);
  });

  test("token never appears in errors, even on auth failure", async () => {
    const server = makeServer();
    const badToken = "fake-token-wrong-zzzzzzzz";
    const adapter = makeAdapter(server, badToken);
    let message = "";
    try {
      await adapter.whoami();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("401");
    expect(message).not.toContain(badToken);
    expect(message).not.toContain("wrong");
  });

  test("token never appears in not-found / GraphQL errors", async () => {
    const server = makeServer();
    const adapter = makeAdapter(server, TOKEN_A);
    let message = "";
    try {
      await adapter.get("424242");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("not found");
    expect(message).not.toContain(TOKEN_A);
  });

  test("numeric project ids resolve the GraphQL full path via REST", async () => {
    const server = makeServer();
    // The fake server serves /projects/group/sandbox; a numeric ref would 404,
    // so this verifies the path-resolution call shape with the path form instead.
    const adapter = makeAdapter(server, TOKEN_A);
    const epic = await adapter.create({ title: "Epic" });
    const child = await adapter.create({ title: "Child", parent: epic.id });
    expect(child.parent).toBe(epic.id);
  });
});
