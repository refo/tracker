import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILENAME, parseConfig } from "../../src/config.ts";
import { UsageError } from "../../src/errors.ts";
import { initProject } from "../../src/init.ts";

const plainDir = () => mkdtempSync(join(tmpdir(), "tracker-init-"));

function gitDir(): string {
  const dir = plainDir();
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  return dir;
}

describe("initProject", () => {
  test("writes a config that loadConfig accepts, with the given url and project", () => {
    const dir = plainDir();
    const result = initProject(dir, { baseUrl: "https://git.example.io/", project: "team/repo" });
    expect(result.configPath).toBe(join(dir, CONFIG_FILENAME));
    const config = parseConfig(readFileSync(result.configPath, "utf8"), dir);
    expect(config.gitlab.base_url).toBe("https://git.example.io");
    expect(config.gitlab.project).toBe("team/repo");
    expect(result.placeholders).toBe(false);
  });

  test("falls back to placeholders and says so when flags are omitted", () => {
    const dir = plainDir();
    const result = initProject(dir, {});
    expect(result.placeholders).toBe(true);
    const config = parseConfig(readFileSync(result.configPath, "utf8"), dir);
    expect(config.gitlab.base_url).toBe("https://gitlab.example.com");
    expect(config.gitlab.project).toBe("group/project");
  });

  test("refuses to overwrite an existing config", () => {
    const dir = plainDir();
    initProject(dir, {});
    expect(() => initProject(dir, {})).toThrow(UsageError);
  });

  test("warns when a parent directory already has a config", () => {
    const parent = plainDir();
    writeFileSync(join(parent, CONFIG_FILENAME), "{}");
    const nested = join(parent, "sub");
    mkdirSync(nested);
    const result = initProject(nested, {});
    expect(result.warnings.some((w) => w.includes(parent))).toBe(true);
  });

  test("no parent-config warning in the plain case", () => {
    expect(initProject(plainDir(), {}).warnings).toHaveLength(0);
  });

  test("in a git repo, ignores config, cache dir and .env exactly once", () => {
    const dir = gitDir();
    const first = initProject(dir, {});
    expect(first.ignoreAdded.sort()).toEqual([".env", ".tracker/", CONFIG_FILENAME].sort());
    const gitignore = readFileSync(join(dir, ".gitignore"), "utf8");
    expect(gitignore).toContain(CONFIG_FILENAME);
    expect(gitignore).toContain(".tracker/");
    expect(gitignore).toContain(".env");
  });

  test("does not duplicate gitignore entries that already exist", () => {
    const dir = gitDir();
    writeFileSync(join(dir, ".gitignore"), `.env\n.tracker/\n${CONFIG_FILENAME}\n`);
    const result = initProject(dir, {});
    expect(result.ignoreAdded).toHaveLength(0);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(
      `.env\n.tracker/\n${CONFIG_FILENAME}\n`,
    );
  });

  test("outside a git repo, writes the config but touches no .gitignore", () => {
    const dir = plainDir();
    const result = initProject(dir, {});
    expect(result.ignoreAdded).toHaveLength(0);
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
    expect(existsSync(result.configPath)).toBe(true);
  });
});
