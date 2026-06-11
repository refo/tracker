import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { UsageError, registerSecret } from "./errors.ts";

export interface TrackerConfig {
  provider: "gitlab";
  /** Where PRs/MRs live; defaults to `provider`. Issues and code hosting are separate capabilities. */
  merge_provider: "gitlab";
  gitlab: {
    base_url: string;
    project: string;
    token_env: string[];
    native_blocking: boolean;
  };
  labels: { in_progress: string };
  memory: { enabled: boolean; title: string; label: string };
  cache: { path: string; stale_minutes: number };
  /** Directory containing tracker.config.json; cache path and .env resolve against it. */
  rootDir: string;
}

export const CONFIG_FILENAME = "tracker.config.json";

export function findConfigFile(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

interface RawConfig {
  provider?: string;
  merge_provider?: string;
  gitlab?: {
    base_url?: string;
    project?: string;
    token_env?: string | string[];
    native_blocking?: boolean;
  };
  labels?: { in_progress?: string };
  memory?: { enabled?: boolean; title?: string; label?: string };
  cache?: { path?: string; stale_minutes?: number };
}

export function parseConfig(json: string, rootDir: string): TrackerConfig {
  let raw: RawConfig;
  try {
    raw = JSON.parse(json) as RawConfig;
  } catch (e) {
    throw new UsageError(`invalid ${CONFIG_FILENAME}: ${(e as Error).message}`);
  }
  if (raw.provider !== "gitlab") {
    throw new UsageError(`unsupported provider "${raw.provider}" (only "gitlab" for now)`);
  }
  if ((raw.merge_provider ?? raw.provider) !== "gitlab") {
    throw new UsageError(
      `unsupported merge_provider "${raw.merge_provider}" (only "gitlab" for now)`,
    );
  }
  const g = raw.gitlab ?? {};
  if (!g.base_url) throw new UsageError("config: gitlab.base_url is required");
  if (!g.project) throw new UsageError("config: gitlab.project is required");
  const tokenEnv =
    g.token_env === undefined
      ? ["TRACKER_GITLAB_TOKEN"]
      : Array.isArray(g.token_env)
        ? g.token_env
        : [g.token_env];
  return {
    provider: "gitlab",
    merge_provider: "gitlab",
    gitlab: {
      base_url: g.base_url.replace(/\/+$/, ""),
      project: String(g.project),
      token_env: tokenEnv,
      native_blocking: g.native_blocking ?? true,
    },
    labels: { in_progress: raw.labels?.in_progress ?? "status::in-progress" },
    memory: {
      enabled: raw.memory?.enabled ?? true,
      title: raw.memory?.title ?? "📌 Project Memory",
      label: raw.memory?.label ?? "meta::memory",
    },
    cache: {
      path: raw.cache?.path ?? ".tracker/cache.sqlite",
      stale_minutes: raw.cache?.stale_minutes ?? 15,
    },
    rootDir,
  };
}

export function loadConfig(startDir: string = process.cwd()): TrackerConfig {
  const file = findConfigFile(startDir);
  if (!file) {
    throw new UsageError(
      `no ${CONFIG_FILENAME} found in ${startDir} or any parent directory — run \`tracker init\` to create one, or cd into the project.`,
    );
  }
  return parseConfig(readFileSync(file, "utf8"), dirname(file));
}

/** Minimal .env parser: KEY=value lines, # comments, optional surrounding quotes. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export interface TokenResolution {
  token: string;
  /** Which env var name supplied it, and from where ("environment" | ".env"). */
  source: string;
}

export function resolveToken(
  config: TrackerConfig,
  env: Record<string, string | undefined> = process.env,
): TokenResolution {
  const dotEnvPath = join(config.rootDir, ".env");
  const dotEnv = existsSync(dotEnvPath) ? parseDotEnv(readFileSync(dotEnvPath, "utf8")) : {};
  for (const name of config.gitlab.token_env) {
    const fromEnv = env[name];
    if (fromEnv) {
      registerSecret(fromEnv);
      return { token: fromEnv, source: `${name} (environment)` };
    }
    const fromFile = dotEnv[name];
    if (fromFile) {
      registerSecret(fromFile);
      return { token: fromFile, source: `${name} (.env)` };
    }
  }
  throw new UsageError(
    `no GitLab token found. Set one of [${config.gitlab.token_env.join(", ")}] ` +
      `in the environment or in ${dotEnvPath} (gitignored).`,
  );
}
