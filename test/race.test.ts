import { describe, expect, test } from "bun:test";
import {
  type ClaimDeps,
  type ClaimResult,
  RELEASE_MARK,
  claimItem,
  electWinner,
} from "../src/core/claim.ts";
import type { ItemId } from "../src/model/types.ts";
import { FakeAdapter, FakeBackend } from "./helpers/fake-adapter.ts";

const POLICY = { inProgressLabel: "status::in-progress", memoryLabel: "meta::memory" };

/** Deps whose settle-sleep parks until the test explicitly releases it. */
function manualDeps(now: () => number, suffix: string) {
  const gates: Array<() => void> = [];
  const deps: ClaimDeps = {
    now,
    sleep: () =>
      new Promise<void>((resolve) => {
        gates.push(resolve);
      }),
    randomSuffix: () => suffix,
  };
  return { deps, gates };
}

/** Spin the microtask/timer queue until cond() holds. */
async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !cond(); i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
  if (!cond()) throw new Error("condition never became true");
}

interface RaceSetup {
  backend: FakeBackend;
  itemId: ItemId;
  a: { adapter: FakeAdapter; deps: ClaimDeps; gates: Array<() => void> };
  b: { adapter: FakeAdapter; deps: ClaimDeps; gates: Array<() => void> };
}

async function setupRace(nowA: () => number, nowB: () => number): Promise<RaceSetup> {
  const backend = new FakeBackend();
  const alice = { id: "1", username: "alice" };
  const bob = { id: "2", username: "bob" };
  const adapterA = new FakeAdapter(backend, alice);
  const adapterB = new FakeAdapter(backend, bob);
  const item = await adapterA.create({ title: "Contended" });
  const a = { adapter: adapterA, ...manualDeps(nowA, "aaaa") };
  const b = { adapter: adapterB, ...manualDeps(nowB, "bbbb") };
  return { backend, itemId: item.id, a, b };
}

async function assertSingleWinner(
  setup: RaceSetup,
  results: [ClaimResult, ClaimResult],
  electionNowMs: number,
): Promise<ClaimResult> {
  const winners = results.filter((r) => r.ok);
  const losers = results.filter((r) => !r.ok);
  expect(winners).toHaveLength(1);
  expect(losers).toHaveLength(1);

  // Winner is assigned and labeled; the loser tombstoned its own token.
  const item = await setup.a.adapter.get(setup.itemId);
  expect(item.assignees).toHaveLength(1);
  expect(item.labels).toContain(POLICY.inProgressLabel);

  const comments = await setup.a.adapter.listComments(setup.itemId);
  const winnerToken = (winners[0] as { token: string }).token;
  const releaseBodies = comments.filter((c) => c.body.startsWith(RELEASE_MARK));
  expect(releaseBodies.some((c) => c.body.includes(winnerToken))).toBe(false);
  expect(releaseBodies).toHaveLength(1);
  expect(electWinner(comments, electionNowMs, 5 * 60_000)?.token).toBe(winnerToken);
  return winners[0]!;
}

describe("claim race: single-winner invariant across interleavings", () => {
  test("both post before either reads → earlier timestamp wins", async () => {
    let clock = 1_000_000;
    const setup = await setupRace(
      () => clock,
      () => clock,
    );
    const pA = claimItem(setup.a.adapter, setup.itemId, POLICY, setup.a.deps);
    await waitFor(() => setup.a.gates.length === 1); // A posted, parked in settle
    clock += 100;
    const pB = claimItem(setup.b.adapter, setup.itemId, POLICY, setup.b.deps);
    await waitFor(() => setup.b.gates.length === 1); // B posted, parked in settle
    setup.a.gates[0]!();
    setup.b.gates[0]!();
    const winner = await assertSingleWinner(setup, [await pA, await pB], clock + 1000);
    expect((winner as { agent: string }).agent).toBe("alice");
  });

  test("reversed read order does not change the outcome", async () => {
    let clock = 1_000_000;
    const setup = await setupRace(
      () => clock,
      () => clock,
    );
    const pA = claimItem(setup.a.adapter, setup.itemId, POLICY, setup.a.deps);
    await waitFor(() => setup.a.gates.length === 1);
    clock += 100;
    const pB = claimItem(setup.b.adapter, setup.itemId, POLICY, setup.b.deps);
    await waitFor(() => setup.b.gates.length === 1);
    setup.b.gates[0]!(); // B reads first this time
    await Bun.sleep(5);
    setup.a.gates[0]!();
    const winner = await assertSingleWinner(setup, [await pA, await pB], clock + 1000);
    expect((winner as { agent: string }).agent).toBe("alice");
  });

  test("A completes its read before B even posts → A wins, B defers", async () => {
    let clock = 1_000_000;
    const setup = await setupRace(
      () => clock,
      () => clock,
    );
    const pA = claimItem(setup.a.adapter, setup.itemId, POLICY, setup.a.deps);
    await waitFor(() => setup.a.gates.length === 1);
    setup.a.gates[0]!();
    const rA = await pA; // A finished entirely before B starts
    expect(rA.ok).toBe(true);

    clock += 1000;
    const pB = claimItem(setup.b.adapter, setup.itemId, POLICY, setup.b.deps);
    const rB = await pB.then(async (r) => {
      return r;
    });
    // B is refused up-front: A is already assigned + labeled.
    expect(rB.ok).toBe(false);
    expect((rB as { reason: string }).reason).toContain("already");
  });

  test("identical timestamps → comment-id tiebreak picks the first poster", async () => {
    const frozen = 2_000_000;
    const setup = await setupRace(
      () => frozen,
      () => frozen,
    );
    const pB = claimItem(setup.b.adapter, setup.itemId, POLICY, setup.b.deps);
    await waitFor(() => setup.b.gates.length === 1); // B posts first
    const pA = claimItem(setup.a.adapter, setup.itemId, POLICY, setup.a.deps);
    await waitFor(() => setup.a.gates.length === 1);
    setup.a.gates[0]!();
    setup.b.gates[0]!();
    const winner = await assertSingleWinner(setup, [await pA, await pB], frozen + 1000);
    expect((winner as { agent: string }).agent).toBe("bob");
  });

  test("stale claim past the TTL cannot beat a live claim", async () => {
    let clock = 3_000_000;
    const setup = await setupRace(
      () => clock,
      () => clock,
    );
    // A posts a claim, then stalls (crashed agent) — its note stays unreleased.
    const pA = claimItem(setup.a.adapter, setup.itemId, POLICY, setup.a.deps);
    await waitFor(() => setup.a.gates.length === 1);

    clock += 6 * 60_000; // beyond the 5-minute TTL
    const pB = claimItem(setup.b.adapter, setup.itemId, POLICY, setup.b.deps);
    await waitFor(() => setup.b.gates.length === 1);
    setup.b.gates[0]!();
    const rB = await pB;
    expect(rB.ok).toBe(true);
    expect((rB as { agent: string }).agent).toBe("bob");

    // A finally wakes up: its own claim has expired, so it loses and releases.
    setup.a.gates[0]!();
    const rA = await pA;
    expect(rA.ok).toBe(false);
    const comments = await setup.a.adapter.listComments(setup.itemId);
    expect(comments.some((c) => c.body.startsWith(RELEASE_MARK) && c.body.includes("aaaa"))).toBe(
      true,
    );
  });

  test("three-way race still produces exactly one winner", async () => {
    const backend = new FakeBackend();
    const adapters = ["alice", "bob", "cem"].map(
      (name, i) => new FakeAdapter(backend, { id: String(i + 1), username: name }),
    );
    const item = await adapters[0]!.create({ title: "Hot ticket" });
    const results = await Promise.all(
      adapters.map((adapter, i) =>
        claimItem(
          adapter,
          item.id,
          { ...POLICY, settleMs: 5 },
          {
            now: () => Date.now(),
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
            randomSuffix: () => `tok${i}`,
          },
        ),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const updated = await adapters[0]!.get(item.id);
    expect(updated.assignees).toHaveLength(1);
  });
});
