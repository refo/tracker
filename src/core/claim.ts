import type { TrackerAdapter } from "../adapters/types.ts";
import type { Comment, ItemId } from "../model/types.ts";

export const CLAIM_MARK = "🔒 tracker-claim";
export const RELEASE_MARK = "🔓 tracker-release";
export const CLAIM_TTL_MS = 5 * 60_000;
export const SETTLE_MS = 2_000;

export interface ParsedClaim {
  token: string;
  agent: string;
  /** Claim timestamp in epoch ms, from the at=<iso> field. */
  ts: number;
}

export function parseClaim(body: string): ParsedClaim | null {
  if (!body.startsWith(CLAIM_MARK)) return null;
  const token = body.match(/token=(\S+)/)?.[1];
  const agent = body.match(/agent=(\S+)/)?.[1];
  const at = body.match(/at=(\S+)/)?.[1];
  if (!token || !agent || !at) return null;
  const ts = Date.parse(at);
  if (Number.isNaN(ts)) return null;
  return { token, agent, ts };
}

export function parseRelease(body: string): string | null {
  if (!body.startsWith(RELEASE_MARK)) return null;
  return body.match(/token=(\S+)/)?.[1] ?? null;
}

export interface LiveClaim extends ParsedClaim {
  commentId: string;
}

/** Numeric-aware comment-id comparison (GitLab note ids are numeric strings). */
function compareCommentIds(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Winner election over an issue's comments: drop released tokens and claims older
 * than the TTL, then the oldest live claim wins (timestamp, then comment id).
 */
export function electWinner(comments: Comment[], nowMs: number, ttlMs: number): LiveClaim | null {
  const released = new Set<string>();
  for (const c of comments) {
    const token = parseRelease(c.body);
    if (token) released.add(token);
  }
  const live: LiveClaim[] = [];
  for (const c of comments) {
    const claim = parseClaim(c.body);
    if (!claim) continue;
    if (released.has(claim.token)) continue;
    if (nowMs - claim.ts > ttlMs) continue;
    live.push({ ...claim, commentId: c.id });
  }
  live.sort((a, b) => a.ts - b.ts || compareCommentIds(a.commentId, b.commentId));
  return live[0] ?? null;
}

export interface ClaimDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  randomSuffix(): string;
}

export const realClaimDeps: ClaimDeps = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  randomSuffix: () => Math.random().toString(36).slice(2, 10),
};

export interface ClaimPolicy {
  inProgressLabel: string;
  memoryLabel: string;
  ttlMs?: number;
  settleMs?: number;
}

export type ClaimResult =
  | { ok: true; id: ItemId; agent: string; token: string }
  | { ok: false; id: ItemId; reason: string };

/**
 * The claim protocol (ported verbatim in behavior from spine):
 * pre-check → post claim note → settle window → re-read notes → elect winner →
 * loser posts a release note and reports failure; winner assigns themself and
 * adds the in-progress label.
 */
export async function claimItem(
  adapter: TrackerAdapter,
  id: ItemId,
  policy: ClaimPolicy,
  deps: ClaimDeps = realClaimDeps,
): Promise<ClaimResult> {
  const ttlMs = policy.ttlMs ?? CLAIM_TTL_MS;
  const settleMs = policy.settleMs ?? SETTLE_MS;
  const me = await adapter.whoami();
  const item = await adapter.get(id);

  if (item.state !== "open") return { ok: false, id, reason: `#${id} is ${item.state}` };
  if (item.labels.includes(policy.memoryLabel)) {
    return { ok: false, id, reason: `#${id} is the memory issue and cannot be claimed` };
  }
  if (item.labels.includes(policy.inProgressLabel)) {
    return {
      ok: false,
      id,
      reason: `#${id} already claimed (${policy.inProgressLabel} label set)`,
    };
  }
  if (item.assignees.length > 0) {
    const who = item.assignees.map((a) => `@${a.username}`).join(", ");
    return { ok: false, id, reason: `#${id} already assigned to ${who}` };
  }

  const token = `${deps.now()}-${deps.randomSuffix()}`;
  const at = new Date(deps.now()).toISOString();
  await adapter.comment(id, `${CLAIM_MARK} agent=${me.username} token=${token} at=${at}`);
  await deps.sleep(settleMs);

  const comments = await adapter.listComments(id);
  const winner = electWinner(comments, deps.now(), ttlMs);

  if (!winner || winner.token !== token) {
    await adapter.comment(id, `${RELEASE_MARK} token=${token} reason=lost-race`);
    return {
      ok: false,
      id,
      reason: `#${id} lost race to @${winner?.agent ?? "?"} (token=${winner?.token ?? "?"})`,
    };
  }

  await adapter.update(id, { assigneeIds: [me.id], addLabels: [policy.inProgressLabel] });
  return { ok: true, id, agent: me.username, token };
}

/**
 * Release: clear assignees + in-progress label, then tombstone every live claim
 * token with a release mark so stale claims cannot win future elections.
 */
export async function releaseItem(
  adapter: TrackerAdapter,
  id: ItemId,
  policy: ClaimPolicy,
): Promise<{ id: ItemId; cleared: number }> {
  const me = await adapter.whoami();
  await adapter.update(id, { assigneeIds: [], removeLabels: [policy.inProgressLabel] });
  const comments = await adapter.listComments(id);
  const released = new Set<string>();
  for (const c of comments) {
    const token = parseRelease(c.body);
    if (token) released.add(token);
  }
  let cleared = 0;
  for (const c of comments) {
    const claim = parseClaim(c.body);
    if (!claim || released.has(claim.token)) continue;
    await adapter.comment(
      id,
      `${RELEASE_MARK} token=${claim.token} agent=${me.username} reason=manual-release`,
    );
    cleared++;
  }
  return { id, cleared };
}
