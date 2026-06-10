#!/usr/bin/env bun
/**
 * Live end-to-end smoke test against the REAL GitLab project from
 * tracker.config.json. Creates clearly-marked issues, exercises the full
 * surface (create, hierarchy, dep, claim, release, search, memory, close),
 * and closes everything it created on the way out.
 *
 * Run only against a sandbox project:  bun scripts/smoke.ts
 */
import { GitLabAdapter } from "../src/adapters/gitlab/adapter.ts";
import { Cache } from "../src/cache/db.ts";
import { loadConfig, resolveToken } from "../src/config.ts";
import { claimItem, releaseItem } from "../src/core/claim.ts";
import { forget, listMemories, remember } from "../src/core/memory.ts";
import { computeEpicStatus, computeReady } from "../src/core/ready.ts";
import { searchLocal } from "../src/core/search.ts";
import { syncCache } from "../src/core/sync.ts";
import { redact } from "../src/errors.ts";
import type { ItemId } from "../src/model/types.ts";

const STAMP = `smoke-${Date.now().toString(36)}`;
const created: ItemId[] = [];
let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const config = loadConfig();
const { token } = resolveToken(config);
const adapter = new GitLabAdapter({
  baseUrl: config.gitlab.base_url,
  project: config.gitlab.project,
  token,
  nativeBlocking: config.gitlab.native_blocking,
});
const cache = new Cache(":memory:");
const policy = { inProgressLabel: config.labels.in_progress, memoryLabel: config.memory.label };

console.log(`smoke test against ${config.gitlab.base_url} / ${config.gitlab.project}`);
console.log(`marker: ${STAMP}\n`);

try {
  const me = await adapter.whoami();
  check("whoami", !!me.username, `@${me.username}`);

  // create: epic + child + independent blocker
  const epic = await adapter.create({ title: `[${STAMP}] epic`, description: "smoke epic" });
  created.push(epic.id);
  const child = await adapter.create({
    title: `[${STAMP}] child task`,
    description: "smoke child",
    parent: epic.id,
  });
  created.push(child.id);
  const blocker = await adapter.create({
    title: `[${STAMP}] blocker`,
    description: "smoke blocker xyzzy-needle",
    labels: ["smoke-test"],
  });
  created.push(blocker.id);
  check(
    "create epic/child/blocker",
    !!epic.id && !!child.id && !!blocker.id,
    `#${epic.id} #${child.id} #${blocker.id}`,
  );

  await adapter.link(blocker.id, child.id);
  check("dep link created", true, `#${blocker.id} blocks #${child.id}`);

  // sync → hierarchy + links visible through the canonical pipeline
  await syncCache(adapter, cache);
  const all = cache.allItems();
  const cachedChild = cache.getItem(child.id);
  check(
    "sync sees created items",
    created.every((id) => cache.getItem(id) !== null),
  );
  check("hierarchy synced", cachedChild?.parent === epic.id, `parent=${cachedChild?.parent}`);
  check(
    "dependency synced",
    cachedChild?.blockedBy.includes(blocker.id) ?? false,
    `blockedBy=[${cachedChild?.blockedBy}]`,
  );

  const ready = computeReady(all, policy);
  check(
    "ready excludes blocked child, includes blocker",
    !ready.some((i) => i.id === child.id) && ready.some((i) => i.id === blocker.id),
  );

  const status = computeEpicStatus(epic.id, cache.childrenOf(epic.id));
  check("epic-status", status?.total === 1 && status.open === 1);

  // search: text and assignee with no text
  const byText = searchLocal(cache, { text: "xyzzy-needle" });
  check("local FTS search", byText.length === 1 && byText[0]!.id === blocker.id);
  const remote = await adapter.searchRemote({ text: STAMP });
  check("remote search", remote.length >= 3, `${remote.length} hits`);

  // claim protocol on the blocker
  const claim1 = await claimItem(adapter, blocker.id, policy);
  check("claim succeeds", claim1.ok, claim1.ok ? claim1.token : claim1.reason);
  const claim2 = await claimItem(adapter, blocker.id, policy);
  check("second claim refused", !claim2.ok, claim2.ok ? "" : claim2.reason);
  const afterClaim = await adapter.get(blocker.id);
  check(
    "claim assigned + labeled",
    afterClaim.assignees.some((a) => a.username === me.username) &&
      afterClaim.labels.includes(policy.inProgressLabel),
  );
  const released = await releaseItem(adapter, blocker.id, policy);
  const afterRelease = await adapter.get(blocker.id);
  check(
    "release cleared",
    released.cleared >= 1 &&
      afterRelease.assignees.length === 0 &&
      !afterRelease.labels.includes(policy.inProgressLabel),
  );

  // memory
  if (config.memory.enabled) {
    const memPolicy = { title: config.memory.title, label: config.memory.label };
    await remember(adapter, cache, memPolicy, STAMP, "smoke value");
    const memories = await listMemories(adapter, cache, memPolicy, STAMP);
    check(
      "remember/memories",
      memories.some((m) => m.key === STAMP && m.text === "smoke value"),
    );
    await forget(adapter, cache, memPolicy, STAMP);
    const afterForget = await listMemories(adapter, cache, memPolicy, STAMP);
    check("forget hides the key", !afterForget.some((m) => m.key === STAMP));
  }

  // time tracking
  await adapter.addTimeSpent(blocker.id, 5400);
  await adapter.addTimeSpent(blocker.id, -1800);
  await adapter.setTimeEstimate(blocker.id, 8 * 3600);
  const timed = await adapter.get(blocker.id);
  check(
    "time tracking (spend/subtract/estimate)",
    timed.timeSpentSeconds === 3600 && timed.timeEstimateSeconds === 8 * 3600,
    `spent=${timed.timeSpentSeconds}s est=${timed.timeEstimateSeconds}s`,
  );

  // users
  const users = await adapter.resolveUsers(me.username);
  check(
    "resolveUsers finds me",
    users.some((u) => u.username === me.username),
  );
} catch (e) {
  failures++;
  console.error(`✗ unexpected error: ${redact(e instanceof Error ? e.message : String(e))}`);
} finally {
  for (const id of created) {
    try {
      await adapter.comment(id, "smoke-test cleanup");
      await adapter.transition(id, "closed");
      console.log(`  cleanup: closed #${id}`);
    } catch (e) {
      console.error(`  cleanup FAILED for #${id}: ${redact((e as Error).message)}`);
      failures++;
    }
  }
}

console.log(failures === 0 ? "\nsmoke test PASSED" : `\nsmoke test FAILED (${failures} problems)`);
process.exit(failures === 0 ? 0 : 1);
