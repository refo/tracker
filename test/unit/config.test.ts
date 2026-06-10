import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_FILENAME,
  findConfigFile,
  parseConfig,
  parseDotEnv,
  resolveToken,
} from "../../src/config.ts";
import { UsageError } from "../../src/errors.ts";

const VALID = JSON.stringify({
  provider: "gitlab",
  gitlab: { base_url: "https://gitlab.example.com/", project: "group/repo" },
});

describe("parseConfig", () => {
  test("applies defaults and trims trailing slash from base_url", () => {
    const c = parseConfig(VALID, "/tmp/x");
    expect(c.gitlab.base_url).toBe("https://gitlab.example.com");
    expect(c.gitlab.token_env).toEqual(["TRACKER_GITLAB_TOKEN"]);
    expect(c.gitlab.native_blocking).toBe(true);
    expect(c.labels.in_progress).toBe("status::in-progress");
    expect(c.memory.enabled).toBe(true);
    expect(c.cache.stale_minutes).toBe(15);
    expect(c.rootDir).toBe("/tmp/x");
  });

  test("token_env accepts a single string or a list", () => {
    const single = parseConfig(
      JSON.stringify({
        provider: "gitlab",
        gitlab: { base_url: "https://x", project: "p", token_env: "MY_TOKEN" },
      }),
      "/tmp",
    );
    expect(single.gitlab.token_env).toEqual(["MY_TOKEN"]);
  });

  test("rejects unknown providers and missing fields", () => {
    expect(() => parseConfig(JSON.stringify({ provider: "jira" }), "/tmp")).toThrow(UsageError);
    expect(() =>
      parseConfig(JSON.stringify({ provider: "gitlab", gitlab: { project: "p" } }), "/tmp"),
    ).toThrow(/base_url/);
    expect(() => parseConfig("{not json", "/tmp")).toThrow(UsageError);
  });
});

describe("findConfigFile", () => {
  test("walks up from a nested directory", () => {
    const root = mkdtempSync(join(tmpdir(), "tracker-test-"));
    writeFileSync(join(root, CONFIG_FILENAME), VALID);
    const nested = join(root, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    expect(findConfigFile(nested)).toBe(join(root, CONFIG_FILENAME));
  });

  test("returns null when no config exists up the tree", () => {
    const lonely = mkdtempSync(join(tmpdir(), "tracker-lonely-"));
    expect(findConfigFile(lonely)).toBeNull();
  });
});

describe("parseDotEnv", () => {
  test("parses keys, ignores comments/blanks, strips quotes", () => {
    expect(parseDotEnv("# c\n\nA=1\nB=\"two words\"\nC='x'\nbroken\n=nope")).toEqual({
      A: "1",
      B: "two words",
      C: "x",
    });
  });
});

describe("resolveToken", () => {
  const makeConfig = (rootDir: string, tokenEnv: string[]) =>
    parseConfig(
      JSON.stringify({
        provider: "gitlab",
        gitlab: { base_url: "https://x", project: "p", token_env: tokenEnv },
      }),
      rootDir,
    );

  test("environment wins, in token_env order", () => {
    const root = mkdtempSync(join(tmpdir(), "tracker-tok-"));
    const config = makeConfig(root, ["PRIMARY_TOKEN", "FALLBACK_TOKEN"]);
    const r = resolveToken(config, { FALLBACK_TOKEN: "fall", PRIMARY_TOKEN: "prim" });
    expect(r.token).toBe("prim");
    expect(r.source).toBe("PRIMARY_TOKEN (environment)");
  });

  test("falls back to the second env var, then to .env", () => {
    const root = mkdtempSync(join(tmpdir(), "tracker-tok-"));
    const config = makeConfig(root, ["PRIMARY_TOKEN", "FALLBACK_TOKEN"]);
    expect(resolveToken(config, { FALLBACK_TOKEN: "fall" }).source).toBe(
      "FALLBACK_TOKEN (environment)",
    );
    writeFileSync(join(root, ".env"), "PRIMARY_TOKEN=from-file\n");
    const r = resolveToken(config, {});
    expect(r.token).toBe("from-file");
    expect(r.source).toBe("PRIMARY_TOKEN (.env)");
  });

  test("missing token is a usage error naming the candidates", () => {
    const root = mkdtempSync(join(tmpdir(), "tracker-tok-"));
    const config = makeConfig(root, ["PRIMARY_TOKEN"]);
    expect(() => resolveToken(config, {})).toThrow(/PRIMARY_TOKEN/);
  });
});
