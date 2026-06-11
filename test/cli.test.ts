import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve(import.meta.dir, "../src/cli/index.ts");

async function runCli(
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

const emptyDir = () => mkdtempSync(join(tmpdir(), "tracker-cli-"));

describe("CLI exit codes and usage", () => {
  test("no args → usage on stdout, exit 1", async () => {
    const r = await runCli([], emptyDir());
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("usage: tracker");
  });

  test("help and per-command --help → exit 0", async () => {
    const dir = emptyDir();
    const help = await runCli(["help"], dir);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("exit codes");
    const claimHelp = await runCli(["claim", "--help"], dir);
    expect(claimHelp.code).toBe(0);
    expect(claimHelp.stdout).toContain("Race-safe claim");
  });

  test("unknown command → exit 1", async () => {
    const r = await runCli(["frobnicate"], emptyDir());
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unknown command");
  });

  test("unknown flag → exit 1 before any config is needed", async () => {
    const r = await runCli(["ready", "--bogus"], emptyDir());
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unknown flag");
  });

  test("missing config → exit 1 with actionable message", async () => {
    const r = await runCli(["sync"], emptyDir());
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("tracker.config.json");
    expect(r.stderr).toContain("tracker init");
  });

  test("config present but token missing → exit 1 naming the env vars", async () => {
    const dir = emptyDir();
    writeFileSync(
      join(dir, "tracker.config.json"),
      JSON.stringify({
        provider: "gitlab",
        gitlab: { base_url: "https://gitlab.example.com", project: "g/p" },
      }),
    );
    const r = await runCli(["sync"], dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("TRACKER_GITLAB_TOKEN");
  });

  test("doctor without config → exit 1, structured report, no crash", async () => {
    const r = await runCli(["doctor", "--json"], emptyDir());
    expect(r.code).toBe(1);
    const report = JSON.parse(r.stdout) as { ok: boolean; checks: { name: string }[] };
    expect(report.ok).toBe(false);
    expect(report.checks[0]?.name).toBe("config");
  });

  test("search with neither text nor filters → usage error", async () => {
    const dir = configuredDir();
    const r = await runCli(["search"], dir);
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toContain("usage: tracker search");
  });

  test("search with only --state is accepted (fails later on network, not usage)", async () => {
    const dir = configuredDir();
    const r = await runCli(["search", "--state", "closed"], dir);
    expect(r.code).toBe(1); // unreachable host in this test config
    expect(r.stdout + r.stderr).not.toContain("usage: tracker search");
  });

  test("spend/estimate reject bad durations before any network call", async () => {
    const dir = configuredDir();
    const bad = await runCli(["spend", "42", "ninety-minutes"], dir);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("invalid duration");
    const zero = await runCli(["spend", "42", "0"], dir);
    expect(zero.code).toBe(1);
    expect(zero.stderr).toContain("non-zero");
    const negEstimate = await runCli(["estimate", "42", "-1h"], dir);
    expect(negEstimate.code).toBe(1);
    expect(negEstimate.stderr).toContain("cannot be negative");
    const noDuration = await runCli(["spend", "42"], dir);
    expect(noDuration.code).toBe(1);
    expect(noDuration.stderr).toContain("usage: tracker spend");
  });

  test("attach without files → usage; missing file rejected before any network call", async () => {
    const dir = configuredDir();
    const noFiles = await runCli(["attach", "42"], dir);
    expect(noFiles.code).toBe(1);
    expect(noFiles.stderr).toContain("usage: tracker attach");

    const missing = await runCli(["attach", "42", "no-such-screenshot.png"], dir);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("no-such-screenshot.png");
    expect(missing.stderr).not.toContain("usage: tracker attach");
  });

  test("attach with an existing file proceeds past validation (fails on network, not usage)", async () => {
    const dir = configuredDir();
    writeFileSync(join(dir, "shot.png"), "png-bytes");
    const r = await runCli(["attach", "42", "shot.png", "-m", "evidence"], dir);
    expect(r.code).toBe(1); // unreachable host in this test config
    expect(r.stdout + r.stderr).not.toContain("usage: tracker attach");
    expect(r.stderr).not.toContain("shot.png: no such file");
  });

  test("pr: missing/unknown action and missing required flags → usage before network", async () => {
    const dir = configuredDir();
    const noAction = await runCli(["pr"], dir);
    expect(noAction.code).toBe(1);
    expect(noAction.stderr).toContain("usage: tracker pr");

    const badAction = await runCli(["pr", "frobnicate"], dir);
    expect(badAction.code).toBe(1);
    expect(badAction.stderr).toContain("usage: tracker pr");

    const noTitle = await runCli(["pr", "create", "--target", "dev", "--source", "x"], dir);
    expect(noTitle.code).toBe(1);
    expect(noTitle.stderr).toContain("--title");

    const noTarget = await runCli(["pr", "create", "-t", "Fix", "--source", "x"], dir);
    expect(noTarget.code).toBe(1);
    expect(noTarget.stderr).toContain("--target");

    const noText = await runCli(["pr", "comment", "5"], dir);
    expect(noText.code).toBe(1);
    expect(noText.stderr).toContain("usage: tracker pr");
  });

  test("mr is an alias for pr", async () => {
    const dir = configuredDir();
    const r = await runCli(["mr", "create", "--target", "dev", "--source", "x"], dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--title");
  });

  test("unsupported merge_provider → config error naming the field", async () => {
    const dir = emptyDir();
    writeFileSync(
      join(dir, "tracker.config.json"),
      JSON.stringify({
        provider: "gitlab",
        merge_provider: "github",
        gitlab: { base_url: "https://gitlab.example.com", project: "g/p" },
      }),
    );
    const r = await runCli(["pr", "status", "5"], dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("merge_provider");
  });

  test("comment without text and comments without id → usage errors", async () => {
    const dir = configuredDir();
    const noText = await runCli(["comment", "42"], dir);
    expect(noText.code).toBe(1);
    expect(noText.stderr).toContain("usage: tracker comment");
    const noId = await runCli(["comments"], dir);
    expect(noId.code).toBe(1);
    expect(noId.stderr).toContain("item id is required");
  });
});

describe("init", () => {
  test("creates a config with flag values and exits 0, no token needed", async () => {
    const dir = emptyDir();
    const r = await runCli(["init", "--base-url", "https://git.corp.io", "--project", "g/p"], dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("tracker.config.json");
    const written = readFileSync(join(dir, "tracker.config.json"), "utf8");
    expect(written).toContain("https://git.corp.io");
    expect(written).toContain('"g/p"');
  });

  test("without flags writes placeholders and tells the user to edit them", async () => {
    const dir = emptyDir();
    const r = await runCli(["init"], dir);
    expect(r.code).toBe(0);
    expect(r.stdout.toLowerCase()).toContain("edit");
    expect(existsSync(join(dir, "tracker.config.json"))).toBe(true);
  });

  test("re-running init fails with exit 1", async () => {
    const dir = emptyDir();
    await runCli(["init"], dir);
    const r = await runCli(["init"], dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("already exists");
  });

  test("init appears in help and has per-command help", async () => {
    const dir = emptyDir();
    const help = await runCli(["help"], dir);
    expect(help.stdout).toContain("init");
    const initHelp = await runCli(["init", "--help"], dir);
    expect(initHelp.code).toBe(0);
    expect(initHelp.stdout).toContain("usage: tracker init");
  });
});

function configuredDir(): string {
  const dir = emptyDir();
  writeFileSync(
    join(dir, "tracker.config.json"),
    JSON.stringify({
      provider: "gitlab",
      gitlab: { base_url: "https://gitlab.example.com", project: "g/p" },
    }),
  );
  writeFileSync(join(dir, ".env"), "TRACKER_GITLAB_TOKEN=local-test-token-not-real\n");
  return dir;
}
