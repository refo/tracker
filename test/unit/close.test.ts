import { describe, expect, test } from "bun:test";
import { CLAIM_MARK, RELEASE_MARK, closeItem } from "../../src/core/claim.ts";
import { FakeAdapter, FakeBackend } from "../helpers/fake-adapter.ts";
import { alice, bob } from "../helpers/items.ts";

const POLICY = { inProgressLabel: "status::in-progress", memoryLabel: "meta::memory" };

function make() {
  const backend = new FakeBackend();
  backend.addUser(bob);
  return { backend, adapter: new FakeAdapter(backend, alice) };
}

async function seedClaimed(adapter: FakeAdapter) {
  const item = await adapter.create({ title: "Claimed work" });
  await adapter.comment(
    item.id,
    `${CLAIM_MARK} agent=alice token=tok-1 at=2026-06-10T12:00:00.000Z`,
  );
  await adapter.update(item.id, {
    assigneeIds: [alice.id],
    addLabels: [POLICY.inProgressLabel],
  });
  return item;
}

describe("closeItem", () => {
  test("claimed item: clears assignee + label, tombstones the token, closes", async () => {
    const { adapter } = make();
    const item = await seedClaimed(adapter);

    const { clearedClaims } = await closeItem(adapter, item.id, POLICY);

    expect(clearedClaims).toBe(1);
    const after = await adapter.get(item.id);
    expect(after.state).toBe("closed");
    expect(after.assignees).toEqual([]);
    expect(after.labels).not.toContain(POLICY.inProgressLabel);
    const bodies = (await adapter.listComments(item.id)).map((c) => c.body);
    expect(bodies.some((b) => b.startsWith(RELEASE_MARK) && b.includes("token=tok-1"))).toBe(true);
  });

  test("human-assigned item with no claim: assignee is preserved", async () => {
    const { adapter } = make();
    const item = await adapter.create({ title: "Human work" });
    await adapter.update(item.id, { assigneeIds: [bob.id] });

    const { clearedClaims } = await closeItem(adapter, item.id, POLICY);

    expect(clearedClaims).toBe(0);
    const after = await adapter.get(item.id);
    expect(after.state).toBe("closed");
    expect(after.assignees.map((a) => a.username)).toEqual([bob.username]);
  });

  test("manually-labeled item with no claim: label removed, assignee preserved", async () => {
    const { adapter } = make();
    const item = await adapter.create({ title: "Kanban-style card" });
    await adapter.update(item.id, {
      assigneeIds: [bob.id],
      addLabels: [POLICY.inProgressLabel],
    });

    await closeItem(adapter, item.id, POLICY);

    const after = await adapter.get(item.id);
    expect(after.labels).not.toContain(POLICY.inProgressLabel);
    expect(after.assignees.map((a) => a.username)).toEqual([bob.username]);
  });

  test("released claims do not count as live: assignee preserved", async () => {
    const { adapter } = make();
    const item = await adapter.create({ title: "Reclaimed by a human" });
    await adapter.comment(
      item.id,
      `${CLAIM_MARK} agent=alice token=tok-9 at=2026-06-10T12:00:00.000Z`,
    );
    await adapter.comment(item.id, `${RELEASE_MARK} token=tok-9 reason=manual-release`);
    await adapter.update(item.id, { assigneeIds: [bob.id] });

    const { clearedClaims } = await closeItem(adapter, item.id, POLICY);

    expect(clearedClaims).toBe(0);
    const after = await adapter.get(item.id);
    expect(after.assignees.map((a) => a.username)).toEqual([bob.username]);
  });

  test("claims older than the election TTL are still cleaned up", async () => {
    // TTL gates claim elections, not close-time hygiene: a claim from hours ago
    // still owns the assignee field and must be cleared when its issue closes.
    const { adapter } = make();
    const item = await seedClaimed(adapter); // claim note dated 2026-06-10, long past TTL

    const { clearedClaims } = await closeItem(adapter, item.id, POLICY);

    expect(clearedClaims).toBe(1);
    expect((await adapter.get(item.id)).assignees).toEqual([]);
  });

  test("note is posted as a comment before closing", async () => {
    const { adapter } = make();
    const item = await adapter.create({ title: "With reason" });

    await closeItem(adapter, item.id, POLICY, "closed: superseded by #99");

    const bodies = (await adapter.listComments(item.id)).map((c) => c.body);
    expect(bodies).toContain("closed: superseded by #99");
    expect((await adapter.get(item.id)).state).toBe("closed");
  });
});
