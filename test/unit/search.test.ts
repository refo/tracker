import { describe, expect, test } from "bun:test";
import { Cache } from "../../src/cache/db.ts";
import { searchLocal } from "../../src/core/search.ts";
import { alice, bob, makeItem, mehmet } from "../helpers/items.ts";

function seededCache(): Cache {
  const cache = new Cache(":memory:");
  cache.replaceAll(
    [
      makeItem({
        id: "1",
        title: "Login button broken",
        description: "Clicking login throws a TypeError",
        assignees: [mehmet],
        author: alice,
        labels: ["bug", "frontend"],
        state: "open",
      }),
      makeItem({
        id: "2",
        title: "Add payment timeout handling",
        description: "Stripe calls hang forever",
        assignees: [bob],
        author: alice,
        labels: ["backend"],
        state: "open",
        parent: "10",
      }),
      makeItem({
        id: "3",
        title: "Login redesign epic",
        description: "New auth screens",
        author: mehmet,
        state: "closed",
      }),
    ],
    "fake",
  );
  return cache;
}

const ids = (items: { id: string }[]) => items.map((i) => i.id);

describe("searchLocal", () => {
  test("full-text over title and description", () => {
    const cache = seededCache();
    expect(ids(searchLocal(cache, { text: "login" }))).toEqual(["1", "3"]);
    expect(ids(searchLocal(cache, { text: "TypeError" }))).toEqual(["1"]);
    expect(ids(searchLocal(cache, { text: "nothing-matches-this" }))).toEqual([]);
  });

  test("assignee filter alone works — the 'issue I assigned to Mehmet' case", () => {
    const cache = seededCache();
    expect(ids(searchLocal(cache, { assignee: "mehmet" }))).toEqual(["1"]);
    expect(ids(searchLocal(cache, { assignee: "@MEHMET" }))).toEqual(["1"]);
  });

  test("author filter alone works", () => {
    const cache = seededCache();
    expect(ids(searchLocal(cache, { author: "mehmet" }))).toEqual(["3"]);
  });

  test("label, state, and parent filters", () => {
    const cache = seededCache();
    expect(ids(searchLocal(cache, { label: "backend" }))).toEqual(["2"]);
    expect(ids(searchLocal(cache, { state: "closed" }))).toEqual(["3"]);
    expect(ids(searchLocal(cache, { parent: "10" }))).toEqual(["2"]);
    expect(ids(searchLocal(cache, {}))).toEqual(["1", "2", "3"]);
  });

  test("combined text + filters", () => {
    const cache = seededCache();
    expect(ids(searchLocal(cache, { text: "login", state: "open" }))).toEqual(["1"]);
    expect(ids(searchLocal(cache, { text: "login", author: "mehmet" }))).toEqual(["3"]);
    expect(ids(searchLocal(cache, { text: "login", label: "bug", assignee: "mehmet" }))).toEqual([
      "1",
    ]);
  });

  test("FTS special characters do not crash the query", () => {
    const cache = seededCache();
    expect(ids(searchLocal(cache, { text: 'login "quoted" AND (weird:' }))).toEqual([]);
  });
});

describe("cache basics", () => {
  test("round-trips canonical items including links", () => {
    const cache = seededCache();
    const item = cache.getItem("2");
    expect(item?.title).toBe("Add payment timeout handling");
    expect(item?.assignees).toEqual([bob]);
    expect(item?.parent).toBe("10");
    cache.replaceAll([makeItem({ id: "5", blockedBy: ["1", "2"] })], "fake");
    expect(cache.getItem("5")?.blockedBy).toEqual(["1", "2"]);
    expect(cache.getItem("1")).toBeNull();
    expect(cache.count()).toBe(1);
  });

  test("staleness: never-synced is stale; fresh sync is not; old sync is", () => {
    const cache = new Cache(":memory:");
    const now = 1_000_000;
    expect(cache.isStale(now, 15 * 60_000)).toBe(true);
    cache.markSynced(now);
    expect(cache.isStale(now + 14 * 60_000, 15 * 60_000)).toBe(false);
    expect(cache.isStale(now + 16 * 60_000, 15 * 60_000)).toBe(true);
  });

  test("childrenOf orders numerically", () => {
    const cache = new Cache(":memory:");
    cache.replaceAll(
      [
        makeItem({ id: "10", parent: "1" }),
        makeItem({ id: "2", parent: "1" }),
        makeItem({ id: "1" }),
      ],
      "fake",
    );
    expect(ids(cache.childrenOf("1"))).toEqual(["2", "10"]);
  });
});
