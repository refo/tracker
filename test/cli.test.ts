import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
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
