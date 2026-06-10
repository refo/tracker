import { describe, expect, test } from "bun:test";
import {
  FORGET_MARK,
  MEM_MARK,
  parseForget,
  parseMemory,
  resolveMemories,
} from "../../src/core/memory.ts";
import type { Comment } from "../../src/model/types.ts";
import { alice } from "../helpers/items.ts";

let nextId = 1;
function note(body: string, ts = "2026-06-10T10:00:00Z"): Comment {
  return { id: String(nextId++), body, author: alice, createdAt: ts };
}

describe("parseMemory / parseForget", () => {
  test("parses key and multi-word text", () => {
    expect(parseMemory(`${MEM_MARK} key=deploy-cmd bun run deploy --prod`)).toEqual({
      key: "deploy-cmd",
      text: "bun run deploy --prod",
    });
  });

  test("multi-line text is preserved", () => {
    const m = parseMemory(`${MEM_MARK} key=steps line one\nline two`);
    expect(m?.text).toBe("line one\nline two");
  });

  test("non-memory notes are ignored", () => {
    expect(parseMemory("regular comment key=foo bar")).toBeNull();
    expect(parseForget("regular comment key=foo")).toBeNull();
  });

  test("forget mark parses the key", () => {
    expect(parseForget(`${FORGET_MARK} key=deploy-cmd`)).toBe("deploy-cmd");
  });
});

describe("resolveMemories", () => {
  test("latest note per key wins", () => {
    const memories = resolveMemories([
      note(`${MEM_MARK} key=a old value`, "2026-06-01T00:00:00Z"),
      note(`${MEM_MARK} key=a new value`, "2026-06-02T00:00:00Z"),
    ]);
    expect(memories).toEqual([{ key: "a", text: "new value", ts: "2026-06-02T00:00:00Z" }]);
  });

  test("forgotten keys are hidden even if remembered before the forget", () => {
    const memories = resolveMemories([
      note(`${MEM_MARK} key=a value`),
      note(`${MEM_MARK} key=b kept`),
      note(`${FORGET_MARK} key=a`),
    ]);
    expect(memories.map((m) => m.key)).toEqual(["b"]);
  });

  test("filter matches key or text, case-insensitive", () => {
    const comments = [
      note(`${MEM_MARK} key=deploy-cmd bun run deploy`),
      note(`${MEM_MARK} key=other Mentions DEPLOY too`),
      note(`${MEM_MARK} key=unrelated nothing here`),
    ];
    expect(resolveMemories(comments, "deploy").map((m) => m.key)).toEqual(["deploy-cmd", "other"]);
  });
});
