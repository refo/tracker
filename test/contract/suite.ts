import { describe, expect, test } from "bun:test";
import type { TrackerAdapter } from "../../src/adapters/types.ts";
import { Cache } from "../../src/cache/db.ts";
import {
  type ClaimDeps,
  RELEASE_MARK,
  claimItem,
  electWinner,
  releaseItem,
} from "../../src/core/claim.ts";
import { ensureMemoryItem, forget, listMemories, remember } from "../../src/core/memory.ts";
import { computeEpicStatus, computeReady } from "../../src/core/ready.ts";
import { searchLocal } from "../../src/core/search.ts";
import { syncCache } from "../../src/core/sync.ts";

export interface ContractHarness {
  /** Fresh, empty backend; adapter and secondAdapter are two identities on it. */
  make(): Promise<{ adapter: TrackerAdapter; secondAdapter: TrackerAdapter }>;
  usernames: { first: string; second: string };
}

const POLICY = {
  inProgressLabel: "status::in-progress",
  memoryLabel: "meta::memory",
  settleMs: 5,
};

const fastDeps = (suffix: string): ClaimDeps => ({
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  randomSuffix: () => suffix,
});

/**
 * The adapter contract: every scenario here must pass for ANY TrackerAdapter.
 * Core policies (ready, claim, release, epic-status, search) appear only via
 * their provider-neutral implementations — that is the swappability proof.
 */
export function runContractSuite(name: string, harness: ContractHarness): void {
  describe(`adapter contract: ${name}`, () => {
    test("create → appears in fetchAll with correct canonical mapping", async () => {
      const { adapter } = await harness.make();
      const created = await adapter.create({
        title: "Implement login",
        description: "OAuth via Keycloak",
        labels: ["auth", "backend"],
      });
      expect(created.id).toBeTruthy();
      expect(created.state).toBe("open");

      const all = await adapter.fetchAll();
      const found = all.find((i) => i.id === created.id);
      expect(found).toBeDefined();
      expect(found!.title).toBe("Implement login");
      expect(found!.description).toBe("OAuth via Keycloak");
      expect(found!.state).toBe("open");
      expect(found!.labels.sort()).toEqual(["auth", "backend"]);
      expect(found!.assignees).toEqual([]);
      expect(found!.author?.username).toBe(harness.usernames.first);
      expect(found!.parent).toBeNull();
      expect(found!.blockedBy).toEqual([]);
      expect(typeof found!.url).toBe("string");
      expect(typeof found!.updatedAt).toBe("string");
    });

    test("create with parent → hierarchy reflected; children/epic-status correct", async () => {
      const { adapter } = await harness.make();
      const epic = await adapter.create({ title: "Login epic" });
      const childA = await adapter.create({ title: "Backend part", parent: epic.id });
      const childB = await adapter.create({ title: "Frontend part", parent: epic.id });
      expect(childA.parent).toBe(epic.id);

      const all = await adapter.fetchAll();
      const children = all.filter((i) => i.parent === epic.id);
      expect(children.map((c) => c.id).sort()).toEqual([childA.id, childB.id].sort());

      await adapter.transition(childA.id, "closed");
      const after = (await adapter.fetchAll()).filter((i) => i.parent === epic.id);
      const status = computeEpicStatus(epic.id, after);
      expect(status).toEqual({ parent: epic.id, total: 2, open: 1, closed: 1, pctClosed: 50 });
    });

    test("setParent attaches an existing item into the hierarchy", async () => {
      const { adapter } = await harness.make();
      const epic = await adapter.create({ title: "Epic" });
      const orphan = await adapter.create({ title: "Orphan" });
      await adapter.setParent(orphan.id, epic.id);
      const all = await adapter.fetchAll();
      expect(all.find((i) => i.id === orphan.id)?.parent).toBe(epic.id);
    });

    test("dep A blocks B → B not ready while A open; B ready after A closes", async () => {
      const { adapter } = await harness.make();
      const a = await adapter.create({ title: "Blocker work" });
      const b = await adapter.create({ title: "Dependent work" });
      await adapter.link(a.id, b.id);

      let ready = computeReady(await adapter.fetchAll(), POLICY);
      expect(ready.map((i) => i.id)).toContain(a.id);
      expect(ready.map((i) => i.id)).not.toContain(b.id);

      await adapter.transition(a.id, "closed");
      ready = computeReady(await adapter.fetchAll(), POLICY);
      expect(ready.map((i) => i.id)).toContain(b.id);
    });

    test("two concurrent claimers → exactly one wins, loser posts a release", async () => {
      const { adapter, secondAdapter } = await harness.make();
      const item = await adapter.create({ title: "Contended work" });

      const [r1, r2] = await Promise.all([
        claimItem(adapter, item.id, POLICY, fastDeps("aaaa")),
        claimItem(secondAdapter, item.id, POLICY, fastDeps("bbbb")),
      ]);
      const winners = [r1, r2].filter((r) => r.ok);
      const losers = [r1, r2].filter((r) => !r.ok);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect((losers[0] as { reason: string }).reason).toContain("lost race");

      const updated = await adapter.get(item.id);
      expect(updated.assignees).toHaveLength(1);
      expect(updated.labels).toContain(POLICY.inProgressLabel);

      const comments = await adapter.listComments(item.id);
      const releases = comments.filter((c) => c.body.startsWith(RELEASE_MARK));
      expect(releases.length).toBeGreaterThanOrEqual(1);
      const winnerToken = (winners[0] as { token: string }).token;
      expect(electWinner(comments, Date.now(), 5 * 60_000)?.token).toBe(winnerToken);
    });

    test("claim on closed / assigned / in-progress items → refused", async () => {
      const { adapter, secondAdapter } = await harness.make();
      const me = await secondAdapter.whoami();

      const closed = await adapter.create({ title: "Closed" });
      await adapter.transition(closed.id, "closed");
      const r1 = await claimItem(adapter, closed.id, POLICY, fastDeps("x1"));
      expect(r1.ok).toBe(false);

      const assigned = await adapter.create({ title: "Assigned" });
      await adapter.update(assigned.id, { assigneeIds: [me.id] });
      const r2 = await claimItem(adapter, assigned.id, POLICY, fastDeps("x2"));
      expect(r2).toMatchObject({ ok: false });
      expect((r2 as { reason: string }).reason).toContain(me.username);

      const labeled = await adapter.create({
        title: "In progress",
        labels: [POLICY.inProgressLabel],
      });
      const r3 = await claimItem(adapter, labeled.id, POLICY, fastDeps("x3"));
      expect(r3.ok).toBe(false);

      // refusals happen before any note is posted
      for (const id of [closed.id, assigned.id, labeled.id]) {
        expect(await adapter.listComments(id)).toEqual([]);
      }
    });

    test("release clears assignee + label and tombstones live tokens", async () => {
      const { adapter, secondAdapter } = await harness.make();
      const item = await adapter.create({ title: "Mine for now" });
      const claimed = await claimItem(adapter, item.id, POLICY, fastDeps("rrrr"));
      expect(claimed.ok).toBe(true);

      const { cleared } = await releaseItem(secondAdapter, item.id, POLICY);
      expect(cleared).toBe(1);

      const updated = await adapter.get(item.id);
      expect(updated.assignees).toEqual([]);
      expect(updated.labels).not.toContain(POLICY.inProgressLabel);

      const comments = await adapter.listComments(item.id);
      expect(electWinner(comments, Date.now(), 5 * 60_000)).toBeNull();
    });

    test("label patch ADDS without clobbering existing labels", async () => {
      const { adapter } = await harness.make();
      const item = await adapter.create({ title: "Labeled", labels: ["keep-me", "and-me"] });
      await adapter.update(item.id, { addLabels: ["status::in-progress"] });
      let updated = await adapter.get(item.id);
      expect(updated.labels.sort()).toEqual(["and-me", "keep-me", "status::in-progress"]);

      await adapter.update(item.id, { removeLabels: ["status::in-progress"] });
      updated = await adapter.get(item.id);
      expect(updated.labels.sort()).toEqual(["and-me", "keep-me"]);
    });

    test("search: text/assignee/author/label combinations, local and remote", async () => {
      const { adapter, secondAdapter } = await harness.make();
      const me = await adapter.whoami();
      const other = await secondAdapter.whoami();

      const a = await adapter.create({
        title: "Login button broken",
        description: "TypeError on click",
        labels: ["bug"],
      });
      const b = await secondAdapter.create({ title: "Payment timeout", labels: ["backend"] });
      await adapter.update(a.id, { assigneeIds: [other.id] });
      await adapter.transition(b.id, "closed");

      // local: sync through the provider-neutral pipeline, then FTS + filters
      const cache = new Cache(":memory:");
      await syncCache(adapter, cache);
      expect(searchLocal(cache, { text: "login" }).map((i) => i.id)).toEqual([a.id]);
      expect(searchLocal(cache, { assignee: other.username }).map((i) => i.id)).toEqual([a.id]);
      expect(searchLocal(cache, { author: other.username }).map((i) => i.id)).toEqual([b.id]);
      expect(searchLocal(cache, { label: "bug" }).map((i) => i.id)).toEqual([a.id]);
      expect(searchLocal(cache, { state: "closed" }).map((i) => i.id)).toEqual([b.id]);
      expect(
        searchLocal(cache, { text: "login", assignee: other.username, label: "bug" }).map(
          (i) => i.id,
        ),
      ).toEqual([a.id]);

      // remote: server-side filtering through the adapter
      if (adapter.capabilities().serverSearch) {
        const byText = await adapter.searchRemote({ text: "login" });
        expect(byText.map((i) => i.id)).toEqual([a.id]);
        const byAssignee = await adapter.searchRemote({ assignee: other.username });
        expect(byAssignee.map((i) => i.id)).toEqual([a.id]);
        const byAuthor = await adapter.searchRemote({ author: me.username });
        expect(byAuthor.map((i) => i.id)).toEqual([a.id]);
        const closedOnly = await adapter.searchRemote({ state: "closed" });
        expect(closedOnly.map((i) => i.id)).toEqual([b.id]);
        const combo = await adapter.searchRemote({ text: "login", label: "bug", state: "open" });
        expect(combo.map((i) => i.id)).toEqual([a.id]);
      }
    });

    test("memory: remember/forget round-trips through the pinned issue", async () => {
      const { adapter, secondAdapter } = await harness.make();
      const memPolicy = { title: "📌 Project Memory", label: "meta::memory" };
      const cache = new Cache(":memory:");

      await remember(adapter, cache, memPolicy, "deploy-cmd", "bun run deploy");
      await remember(adapter, cache, memPolicy, "deploy-cmd", "bun run deploy --prod");
      await remember(adapter, cache, memPolicy, "tmp-note", "scratch");
      await forget(adapter, cache, memPolicy, "tmp-note");

      const memories = await listMemories(adapter, cache, memPolicy);
      expect(memories).toEqual([
        { key: "deploy-cmd", text: "bun run deploy --prod", ts: expect.any(String) },
      ]);

      // a different agent with a cold cache finds the same issue, no duplicate
      const coldCache = new Cache(":memory:");
      const memId = await ensureMemoryItem(secondAdapter, coldCache, memPolicy);
      const sameMemories = await listMemories(secondAdapter, coldCache, memPolicy);
      expect(sameMemories.map((m) => m.key)).toEqual(["deploy-cmd"]);
      expect((await adapter.fetchAll()).filter((i) => i.title === memPolicy.title)).toHaveLength(1);

      // the memory issue is never ready and refuses claims
      const ready = computeReady(await adapter.fetchAll(), POLICY);
      expect(ready.map((i) => i.id)).not.toContain(memId);
      const claim = await claimItem(adapter, memId, POLICY, fastDeps("mm"));
      expect(claim.ok).toBe(false);
    });

    test("comments round-trip: ordered oldest-first with correct authors", async () => {
      const { adapter, secondAdapter } = await harness.make();
      const item = await adapter.create({ title: "Discussion" });
      await adapter.comment(item.id, "first note");
      await secondAdapter.comment(item.id, "reply from the other agent");
      await adapter.comment(item.id, "closing thought\nwith a second line");

      const comments = await adapter.listComments(item.id);
      expect(comments.map((c) => c.body)).toEqual([
        "first note",
        "reply from the other agent",
        "closing thought\nwith a second line",
      ]);
      expect(comments.map((c) => c.author.username)).toEqual([
        harness.usernames.first,
        harness.usernames.second,
        harness.usernames.first,
      ]);
      expect(comments.every((c) => typeof c.id === "string" && c.createdAt)).toBe(true);
    });

    test("attach: files upload, return per-file markdown, and are reachable via a comment", async () => {
      const { adapter } = await harness.make();
      const item = await adapter.create({ title: "Visual bug" });
      const attachments = await adapter.attach(
        item.id,
        [
          { filename: "before.png", content: new TextEncoder().encode("png-bytes-before") },
          { filename: "after.png", content: new TextEncoder().encode("png-bytes-after") },
        ],
        "reference screenshots",
      );

      expect(attachments).toHaveLength(2);
      expect(attachments[0]!.filename).toBe("before.png");
      expect(attachments[1]!.filename).toBe("after.png");
      for (const att of attachments) {
        expect(att.url).toBeTruthy();
        expect(att.markdown).toContain(att.filename);
      }
      // distinct files must not collide on the same URL
      expect(attachments[0]!.url).not.toBe(attachments[1]!.url);

      // zero-context reachability: a fresh reader finds the files on the item itself
      const bodies = (await adapter.listComments(item.id)).map((c) => c.body).join("\n");
      expect(bodies).toContain("reference screenshots");
      expect(bodies).toContain(attachments[0]!.markdown);
      expect(bodies).toContain(attachments[1]!.markdown);
    });

    test("attach without a message still references every file from the item", async () => {
      const { adapter } = await harness.make();
      const item = await adapter.create({ title: "Screenshot only" });
      const [att] = await adapter.attach(item.id, [
        { filename: "evidence.png", content: new TextEncoder().encode("png-bytes") },
      ]);
      const bodies = (await adapter.listComments(item.id)).map((c) => c.body).join("\n");
      expect(bodies).toContain(att!.markdown);
    });

    test("time tracking: spend accumulates, negative subtracts, estimate sets/clears", async () => {
      const { adapter } = await harness.make();
      if (!adapter.capabilities().timeTracking) return;
      const item = await adapter.create({ title: "Timed work" });

      await adapter.addTimeSpent(item.id, 5400); // 1h30m
      await adapter.addTimeSpent(item.id, 1800); // +30m
      expect((await adapter.get(item.id)).timeSpentSeconds).toBe(7200);

      await adapter.addTimeSpent(item.id, -3600); // logged too much
      expect((await adapter.get(item.id)).timeSpentSeconds).toBe(3600);

      await adapter.setTimeEstimate(item.id, 8 * 3600);
      let fetched = (await adapter.fetchAll()).find((i) => i.id === item.id);
      expect(fetched?.timeEstimateSeconds).toBe(8 * 3600);
      expect(fetched?.timeSpentSeconds).toBe(3600);

      await adapter.setTimeEstimate(item.id, 0);
      fetched = (await adapter.fetchAll()).find((i) => i.id === item.id);
      expect(fetched?.timeEstimateSeconds).toBe(0);

      // subtracting below zero is refused and leaves the total unchanged
      await expect(adapter.addTimeSpent(item.id, -7200)).rejects.toThrow();
      expect((await adapter.get(item.id)).timeSpentSeconds).toBe(3600);
    });

    test("whoami and resolveUsers", async () => {
      const { adapter } = await harness.make();
      const me = await adapter.whoami();
      expect(me.username).toBe(harness.usernames.first);
      const hits = await adapter.resolveUsers(harness.usernames.second.slice(0, 4));
      expect(hits.map((u) => u.username)).toContain(harness.usernames.second);
    });
  });
}
