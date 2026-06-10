import { describe, expect, test } from "bun:test";
import { computeEpicStatus, computeReady } from "../../src/core/ready.ts";
import { alice, makeItem } from "../helpers/items.ts";

const policy = { inProgressLabel: "status::in-progress", memoryLabel: "meta::memory" };
const ids = (items: { id: string }[]) => items.map((i) => i.id);

describe("computeReady", () => {
  test("open, unassigned, unblocked, unlabeled items are ready", () => {
    const items = [
      makeItem({ id: "1" }),
      makeItem({ id: "2", state: "closed" }),
      makeItem({ id: "3", assignees: [alice] }),
      makeItem({ id: "4", labels: ["status::in-progress"] }),
      makeItem({ id: "5", labels: ["meta::memory"] }),
    ];
    expect(ids(computeReady(items, policy))).toEqual(["1"]);
  });

  test("blocked by an open item → not ready; blocker closes → ready", () => {
    const blocked = makeItem({ id: "2", blockedBy: ["1"] });
    expect(ids(computeReady([makeItem({ id: "1" }), blocked], policy))).toEqual(["1"]);
    expect(ids(computeReady([makeItem({ id: "1", state: "closed" }), blocked], policy))).toEqual([
      "2",
    ]);
  });

  test("a blocker missing from the snapshot does not block", () => {
    const items = [makeItem({ id: "2", blockedBy: ["999"] })];
    expect(ids(computeReady(items, policy))).toEqual(["2"]);
  });

  test("parent filter", () => {
    const items = [
      makeItem({ id: "1", parent: "10" }),
      makeItem({ id: "2", parent: "20" }),
      makeItem({ id: "3" }),
    ];
    expect(ids(computeReady(items, { ...policy, parent: "10" }))).toEqual(["1"]);
    expect(ids(computeReady(items, policy))).toEqual(["1", "2", "3"]);
  });

  test("other labels do not interfere", () => {
    const items = [makeItem({ id: "1", labels: ["backend", "p1"] })];
    expect(ids(computeReady(items, policy))).toEqual(["1"]);
  });
});

describe("computeEpicStatus", () => {
  test("counts open/closed children", () => {
    const children = [
      makeItem({ state: "closed" }),
      makeItem({ state: "closed" }),
      makeItem({ state: "open" }),
    ];
    expect(computeEpicStatus("12", children)).toEqual({
      parent: "12",
      total: 3,
      open: 1,
      closed: 2,
      pctClosed: 67,
    });
  });

  test("no children → null", () => {
    expect(computeEpicStatus("12", [])).toBeNull();
  });
});
