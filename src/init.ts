import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { findGitRoot, isGitIgnored } from "./cache/ignore-guard.ts";
import { CONFIG_FILENAME, findConfigFile } from "./config.ts";
import { UsageError } from "./errors.ts";

export interface InitOptions {
  baseUrl?: string;
  project?: string;
}

export interface InitResult {
  configPath: string;
  /** True when base_url/project were not supplied and the file needs editing. */
  placeholders: boolean;
  /** Patterns appended to .gitignore (empty outside a git repo or when already ignored). */
  ignoreAdded: string[];
  warnings: string[];
}

const PLACEHOLDER_URL = "https://gitlab.example.com";
const PLACEHOLDER_PROJECT = "group/project";

function configTemplate(baseUrl: string, project: string): string {
  const config = {
    provider: "gitlab",
    gitlab: {
      base_url: baseUrl.replace(/\/+$/, ""),
      project,
      token_env: ["TRACKER_GITLAB_TOKEN", "GITLAB_PERSONAL_ACCESS_TOKEN"],
      native_blocking: true,
      native_status: false,
    },
    labels: { in_progress: "status::in-progress" },
    memory: { enabled: true, title: "📌 Project Memory", label: "meta::memory" },
    cache: { path: ".tracker/cache.sqlite", stale_minutes: 15 },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * The config (and .env) carry instance/project identifiers that must stay out
 * of git, so init also makes sure all local-only paths are git-ignored.
 */
function ensureIgnored(dir: string, warnings: string[]): string[] {
  const gitRoot = findGitRoot(dir);
  if (!gitRoot) return [];
  // pattern to append → representative path for git check-ignore
  const entries: Array<[string, string]> = [
    [CONFIG_FILENAME, join(dir, CONFIG_FILENAME)],
    [".tracker/", join(dir, ".tracker", "cache.sqlite")],
    [".env", join(dir, ".env")],
  ];
  const added: string[] = [];
  for (const [pattern, path] of entries) {
    const ignored = isGitIgnored(gitRoot, path);
    if (ignored === null) {
      warnings.push(`git not available — verify ${pattern} is git-ignored yourself`);
      return added;
    }
    if (ignored) continue;
    const gitignorePath = join(dir, ".gitignore");
    const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
    const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
    appendFileSync(gitignorePath, `${prefix}${pattern}\n`);
    added.push(pattern);
  }
  return added;
}

export function initProject(targetDir: string, opts: InitOptions): InitResult {
  const dir = resolve(targetDir);
  const configPath = join(dir, CONFIG_FILENAME);
  if (existsSync(configPath)) {
    throw new UsageError(`${configPath} already exists — edit it instead of re-running init`);
  }
  const warnings: string[] = [];
  const parentConfig = findConfigFile(dirname(dir));
  if (parentConfig) {
    warnings.push(
      `a ${CONFIG_FILENAME} already exists in ${dirname(parentConfig)} — the one created here will shadow it for everything under ${dir}`,
    );
  }
  const placeholders = !opts.baseUrl || !opts.project;
  writeFileSync(
    configPath,
    configTemplate(opts.baseUrl ?? PLACEHOLDER_URL, opts.project ?? PLACEHOLDER_PROJECT),
  );
  const ignoreAdded = ensureIgnored(dir, warnings);
  return { configPath, placeholders, ignoreAdded, warnings };
}
