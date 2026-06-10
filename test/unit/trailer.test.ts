import { describe, expect, test } from "bun:test";
import { parseBlockedByTrailer, upsertBlockedByTrailer } from "../../src/adapters/gitlab/map.ts";

describe("Tracker-Blocked-By description trailer (non-Premium dep fallback)", () => {
  test("parses ids with and without #", () => {
    expect(parseBlockedByTrailer("Body\n\nTracker-Blocked-By: #12, 34,#56")).toEqual([
      "12",
      "34",
      "56",
    ]);
  });

  test("absent trailer → empty", () => {
    expect(parseBlockedByTrailer("just a description")).toEqual([]);
    expect(parseBlockedByTrailer(null)).toEqual([]);
    expect(parseBlockedByTrailer(undefined)).toEqual([]);
  });

  test("upsert appends a trailer to a plain description", () => {
    const out = upsertBlockedByTrailer("Fix the login flow.", ["7"]);
    expect(out).toBe("Fix the login flow.\n\nTracker-Blocked-By: #7");
  });

  test("upsert merges with existing ids without duplicates", () => {
    const out = upsertBlockedByTrailer("Body\n\nTracker-Blocked-By: #7, #9", ["9", "11"]);
    expect(parseBlockedByTrailer(out)).toEqual(["7", "9", "11"]);
    expect(out.match(/Tracker-Blocked-By/g)).toHaveLength(1);
  });

  test("upsert into an empty description", () => {
    expect(upsertBlockedByTrailer("", ["3"])).toBe("Tracker-Blocked-By: #3");
  });
});
