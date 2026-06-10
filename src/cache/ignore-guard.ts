import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export interface IgnoreGuardResult {
  action: "ok" | "added" | "warn" | "skipped";
  detail: string;
}

/** Find the enclosing git work tree (directory containing .git), if any. */
export function findGitRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Ask git whether a path is ignored; null when git is unavailable/errored. */
export function isGitIgnored(gitRoot: string, path: string): boolean | null {
  try {
    const proc = Bun.spawnSync(["git", "-C", gitRoot, "check-ignore", "-q", "--", path], {
      stdout: "ignore",
      stderr: "ignore",
    });
    if (proc.exitCode === 0) return true;
    if (proc.exitCode === 1) return false;
    return null;
  } catch {
    return null;
  }
}

/**
 * Run before the cache directory is first created: if the project is a git
 * repository and the cache path is not ignored, append it to the config-root
 * .gitignore so the sqlite cache can never be committed by accident.
 */
export function guardCacheIgnored(rootDir: string, absCachePath: string): IgnoreGuardResult {
  const cacheDir = dirname(absCachePath);
  const gitRoot = findGitRoot(rootDir);
  if (!gitRoot) return { action: "skipped", detail: "not inside a git repository" };

  const ignored = isGitIgnored(gitRoot, absCachePath);
  if (ignored === null) return { action: "skipped", detail: "git not available" };
  if (ignored) return { action: "ok", detail: "cache path is git-ignored" };

  const rel = relative(rootDir, cacheDir);
  if (rel.startsWith("..")) {
    return {
      action: "warn",
      detail: `cache dir ${cacheDir} is outside the config root and NOT git-ignored — add it to a .gitignore manually`,
    };
  }
  const pattern = `${rel.replaceAll("\\", "/")}/`;
  const gitignorePath = join(rootDir, ".gitignore");
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  appendFileSync(gitignorePath, `${prefix}${pattern}\n`);
  return { action: "added", detail: `added "${pattern}" to ${gitignorePath}` };
}
