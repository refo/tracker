import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findGitRoot, guardCacheIgnored, isGitIgnored } from "../../src/cache/ignore-guard.ts";

function gitDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tracker-guard-"));
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  return dir;
}

const CACHE = ".tracker/cache.sqlite";

describe("guardCacheIgnored", () => {
  test("adds the cache dir to .gitignore when missing, exactly once", () => {
    const root = gitDir();
    const first = guardCacheIgnored(root, join(root, CACHE));
    expect(first.action).toBe("added");
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(".tracker/");

    const second = guardCacheIgnored(root, join(root, CACHE));
    expect(second.action).toBe("ok");
    expect(readFileSync(join(root, ".gitignore"), "utf8").match(/\.tracker\//g)).toHaveLength(1);
  });

  test("appends with a clean newline to an existing .gitignore", () => {
    const root = gitDir();
    writeFileSync(join(root, ".gitignore"), "node_modules/"); // no trailing newline
    const result = guardCacheIgnored(root, join(root, CACHE));
    expect(result.action).toBe("added");
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("node_modules/\n.tracker/\n");
  });

  test("already-ignored cache path → ok, file untouched", () => {
    const root = gitDir();
    writeFileSync(join(root, ".gitignore"), ".tracker/\n");
    const result = guardCacheIgnored(root, join(root, CACHE));
    expect(result.action).toBe("ok");
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(".tracker/\n");
  });

  test("outside a git repository → skipped, no .gitignore created", () => {
    const root = mkdtempSync(join(tmpdir(), "tracker-nogit-"));
    const result = guardCacheIgnored(root, join(root, CACHE));
    expect(result.action).toBe("skipped");
  });

  test("config root nested inside the git repo still works", () => {
    const gitRoot = gitDir();
    const nested = join(gitRoot, "tools", "tracker");
    mkdirSync(nested, { recursive: true });
    const result = guardCacheIgnored(nested, join(nested, CACHE));
    expect(result.action).toBe("added");
    expect(readFileSync(join(nested, ".gitignore"), "utf8")).toBe(".tracker/\n");
    expect(isGitIgnored(gitRoot, join(nested, CACHE))).toBe(true);
  });
});

describe("findGitRoot", () => {
  test("walks up to the repository root", () => {
    const root = gitDir();
    const deep = join(root, "a", "b");
    mkdirSync(deep, { recursive: true });
    expect(findGitRoot(deep)).toBe(root);
  });
});
