#!/usr/bin/env node
// Launcher: tracker runs on Bun (bun:sqlite). `bunx trackerctl` lands here
// already inside Bun; `npx trackerctl` lands here inside Node and re-executes
// via the bun binary, with a friendly error if Bun is not installed.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/tracker.js", import.meta.url));
const runtime = typeof Bun !== "undefined" ? process.execPath : "bun";
const result = spawnSync(runtime, [cli, ...process.argv.slice(2)], { stdio: "inherit" });

if (result.error && result.error.code === "ENOENT") {
  console.error(
    "tracker requires the Bun runtime, and `bun` was not found on your PATH.\n" +
      "Install it from https://bun.sh (curl -fsSL https://bun.sh/install | bash),\n" +
      "then re-run, or use `bunx trackerctl` directly.",
  );
  process.exit(1);
}
process.exit(result.status ?? 1);
