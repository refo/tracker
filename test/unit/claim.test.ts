import { describe, expect, test } from "bun:test";
import {
  CLAIM_MARK,
  CLAIM_TTL_MS,
  RELEASE_MARK,
  electWinner,
  parseClaim,
  parseRelease,
  secondsSinceClaim,
} from "../../src/core/claim.ts";
import type { Comment } from "../../src/model/types.ts";
import { alice } from "../helpers/items.ts";

const T0 = Date.parse("2026-06-10T12:00:00.000Z");

function claimComment(id: string, agent: string, token: string, atMs: number): Comment {
  return {
    id,
    body: `${CLAIM_MARK} agent=${agent} token=${token} at=${new Date(atMs).toISOString()}`,
    author: alice,
    createdAt: new Date(atMs).toISOString(),
  };
}

function releaseComment(id: string, token: string): Comment {
  return {
    id,
    body: `${RELEASE_MARK} token=${token} reason=lost-race`,
    author: alice,
    createdAt: new Date(T0).toISOString(),
  };
}

describe("parseClaim", () => {
  test("parses a well-formed claim note", () => {
    const c = parseClaim(`${CLAIM_MARK} agent=alice token=123-abc at=2026-06-10T12:00:00.000Z`);
    expect(c).toEqual({ token: "123-abc", agent: "alice", ts: T0 });
  });

  test("rejects notes without the mark, missing fields, or bad timestamps", () => {
    expect(parseClaim("just a comment token=x agent=y at=2026-01-01T00:00:00Z")).toBeNull();
    expect(parseClaim(`${CLAIM_MARK} agent=alice at=2026-06-10T12:00:00Z`)).toBeNull();
    expect(parseClaim(`${CLAIM_MARK} agent=alice token=t at=not-a-date`)).toBeNull();
  });
});

describe("parseRelease", () => {
  test("extracts the released token", () => {
    expect(parseRelease(`${RELEASE_MARK} token=123-abc reason=manual-release`)).toBe("123-abc");
  });

  test("ignores non-release notes", () => {
    expect(parseRelease(`${CLAIM_MARK} agent=a token=t at=2026-01-01T00:00:00Z`)).toBeNull();
  });
});

describe("electWinner", () => {
  test("oldest live claim wins by timestamp", () => {
    const winner = electWinner(
      [claimComment("10", "bob", "tok-b", T0 + 500), claimComment("11", "alice", "tok-a", T0)],
      T0 + 1000,
      CLAIM_TTL_MS,
    );
    expect(winner?.token).toBe("tok-a");
  });

  test("equal timestamps fall back to comment id (numeric-aware)", () => {
    const winner = electWinner(
      [claimComment("9", "alice", "tok-a", T0), claimComment("10", "bob", "tok-b", T0)],
      T0 + 1000,
      CLAIM_TTL_MS,
    );
    expect(winner?.token).toBe("tok-a");
  });

  test("released tokens are excluded, even when older", () => {
    const winner = electWinner(
      [
        claimComment("1", "alice", "tok-a", T0),
        claimComment("2", "bob", "tok-b", T0 + 100),
        releaseComment("3", "tok-a"),
      ],
      T0 + 1000,
      CLAIM_TTL_MS,
    );
    expect(winner?.token).toBe("tok-b");
  });

  test("a release posted before its claim still tombstones it", () => {
    const winner = electWinner(
      [releaseComment("1", "tok-a"), claimComment("2", "alice", "tok-a", T0)],
      T0 + 1000,
      CLAIM_TTL_MS,
    );
    expect(winner).toBeNull();
  });

  test("claims older than the TTL expire", () => {
    const winner = electWinner(
      [
        claimComment("1", "alice", "tok-old", T0 - CLAIM_TTL_MS - 1),
        claimComment("2", "bob", "tok-new", T0),
      ],
      T0,
      CLAIM_TTL_MS,
    );
    expect(winner?.token).toBe("tok-new");
  });

  test("claim exactly at the TTL boundary is still live", () => {
    const winner = electWinner(
      [claimComment("1", "alice", "tok", T0 - CLAIM_TTL_MS)],
      T0,
      CLAIM_TTL_MS,
    );
    expect(winner?.token).toBe("tok");
  });

  test("no live claims → null", () => {
    expect(electWinner([], T0, CLAIM_TTL_MS)).toBeNull();
    expect(
      electWinner(
        [claimComment("1", "a", "t", T0), releaseComment("2", "t")],
        T0 + 1,
        CLAIM_TTL_MS,
      ),
    ).toBeNull();
  });
});

describe("secondsSinceClaim", () => {
  test("returns elapsed seconds from the LATEST claim note", () => {
    const comments: Comment[] = [
      claimComment("1", "alice", "old1", T0 - 3 * 3600_000),
      releaseComment("2", "old1"),
      claimComment("3", "alice", "cur1", T0 - 90 * 60_000),
      { id: "4", body: "ordinary note", author: alice, createdAt: new Date(T0).toISOString() },
    ];
    expect(secondsSinceClaim(comments, T0)).toBe(90 * 60);
  });

  test("returns null when no claim note exists", () => {
    const comments: Comment[] = [
      { id: "1", body: "just a comment", author: alice, createdAt: new Date(T0).toISOString() },
    ];
    expect(secondsSinceClaim(comments, T0)).toBeNull();
    expect(secondsSinceClaim([], T0)).toBeNull();
  });
});
