#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { GitLabAdapter } from "../adapters/gitlab/adapter.ts";
import type { TrackerAdapter } from "../adapters/types.ts";
import { Cache } from "../cache/db.ts";
import { findGitRoot, guardCacheIgnored, isGitIgnored } from "../cache/ignore-guard.ts";
import { type TrackerConfig, loadConfig, resolveToken } from "../config.ts";
import { claimItem, releaseItem } from "../core/claim.ts";
import { formatDuration, parseDuration } from "../core/duration.ts";
import { normalizeId } from "../core/ids.ts";
import { forget, listMemories, remember } from "../core/memory.ts";
import { mergeAndCloseIssues } from "../core/merge.ts";
import { computeEpicStatus, computeReady } from "../core/ready.ts";
import { type SearchQuery, searchLocal } from "../core/search.ts";
import { ensureFresh, syncCache } from "../core/sync.ts";
import { DomainError, UsageError, redact } from "../errors.ts";
import { initProject } from "../init.ts";
import type { ItemState } from "../model/types.ts";
import { HELP, commandHelp } from "./help.ts";
import { itemToJson, printItemDetail, printItemLines, printJson, printUsers } from "./output.ts";

type FlagKind = "value" | "bool";

interface ParsedArgs {
  flags: Map<string, string | true>;
  positionals: string[];
}

function parseArgs(
  args: string[],
  spec: Record<string, FlagKind>,
  aliases: Record<string, string> = {},
): ParsedArgs {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    // "-30m" style negative durations are positionals, not flags
    if (!arg.startsWith("-") || arg === "-" || /^-\d/.test(arg)) {
      positionals.push(arg);
      continue;
    }
    const name = aliases[arg] ?? arg;
    const kind = spec[name];
    if (!kind) throw new UsageError(`unknown flag ${arg} (see tracker help)`);
    if (kind === "bool") {
      flags.set(name, true);
    } else {
      const value = args[++i];
      if (value === undefined) throw new UsageError(`flag ${arg} needs a value`);
      flags.set(name, value);
    }
  }
  return { flags, positionals };
}

const str = (p: ParsedArgs, name: string): string | undefined => {
  const v = p.flags.get(name);
  return typeof v === "string" ? v : undefined;
};

interface Ctx {
  config: TrackerConfig;
  cache: Cache;
  adapter: TrackerAdapter & GitLabAdapter;
}

function buildCtx(): Ctx {
  const config = loadConfig();
  const { token } = resolveToken(config);
  const adapter = new GitLabAdapter({
    baseUrl: config.gitlab.base_url,
    project: config.gitlab.project,
    token,
    nativeBlocking: config.gitlab.native_blocking,
  });
  const cachePath = resolve(config.rootDir, config.cache.path);
  // First creation of the cache dir: make sure it can never be committed.
  if (!existsSync(cachePath)) {
    const guard = guardCacheIgnored(config.rootDir, cachePath);
    if (guard.action === "added" || guard.action === "warn") console.error(`(${guard.detail})`);
  }
  const cache = new Cache(cachePath);
  return { config, cache, adapter };
}

const claimPolicy = (config: TrackerConfig) => ({
  inProgressLabel: config.labels.in_progress,
  memoryLabel: config.memory.label,
});

async function freshen(ctx: Ctx): Promise<void> {
  await ensureFresh(
    ctx.adapter,
    ctx.cache,
    ctx.config.cache.stale_minutes * 60_000,
    Date.now(),
    () => console.error("(cache stale, syncing...)"),
  );
}

/** Writes invalidate the cache so the next read auto-syncs instead of lying. */
const invalidate = (ctx: Ctx) => ctx.cache.metaSet("last_sync_at", "0");

const memoryPolicy = (ctx: Ctx) => {
  if (!ctx.config.memory.enabled) {
    throw new UsageError("the memory feature is disabled in tracker.config.json");
  }
  return { title: ctx.config.memory.title, label: ctx.config.memory.label };
};

// ---------- commands ----------

async function cmdSync(ctx: Ctx): Promise<void> {
  const t0 = performance.now();
  const { count } = await syncCache(ctx.adapter, ctx.cache);
  const ms = Math.round(performance.now() - t0);
  console.log(
    `synced ${count} items in ${ms}ms → ${resolve(ctx.config.rootDir, ctx.config.cache.path)}`,
  );
}

async function cmdReady(ctx: Ctx, args: ParsedArgs): Promise<void> {
  await freshen(ctx);
  const items = computeReady(ctx.cache.allItems(), {
    ...claimPolicy(ctx.config),
    parent: str(args, "--parent") ? normalizeId(str(args, "--parent")) : null,
  });
  if (args.flags.get("--json")) return printJson(items.map(itemToJson));
  if (items.length === 0) return console.error("(no ready items)");
  printItemLines(items);
}

async function cmdShow(ctx: Ctx, args: ParsedArgs): Promise<void> {
  await freshen(ctx);
  const id = normalizeId(args.positionals[0]);
  const item = ctx.cache.getItem(id);
  if (!item) throw new DomainError(`#${id} not found in cache (try: tracker sync)`);
  const blocks = ctx.cache
    .allItems()
    .filter((i) => i.blockedBy.includes(id))
    .map((i) => i.id);
  if (args.flags.get("--json")) return printJson({ ...itemToJson(item), blocks });
  printItemDetail(item, blocks);
}

async function cmdChildren(ctx: Ctx, args: ParsedArgs): Promise<void> {
  await freshen(ctx);
  const id = normalizeId(args.positionals[0]);
  const children = ctx.cache.childrenOf(id);
  if (args.flags.get("--json")) return printJson(children.map(itemToJson));
  if (children.length === 0) return console.error(`(no children of #${id})`);
  printItemLines(children);
}

async function cmdEpicStatus(ctx: Ctx, args: ParsedArgs): Promise<void> {
  await freshen(ctx);
  const id = normalizeId(args.positionals[0]);
  const status = computeEpicStatus(id, ctx.cache.childrenOf(id));
  if (args.flags.get("--json")) {
    return printJson(status ?? { parent: id, total: 0, open: 0, closed: 0, pctClosed: 0 });
  }
  if (!status) return console.error(`(no children of #${id})`);
  console.log(
    `#${status.parent}\t${status.closed}/${status.total} closed (${status.pctClosed}%)\topen=${status.open}`,
  );
}

async function cmdClaim(ctx: Ctx, args: ParsedArgs): Promise<void> {
  const id = normalizeId(args.positionals[0]);
  const result = await claimItem(ctx.adapter, id, claimPolicy(ctx.config));
  invalidate(ctx);
  if (!result.ok) throw new DomainError(result.reason);
  console.log(`#${id} claimed by @${result.agent} (token=${result.token})`);
}

async function cmdRelease(ctx: Ctx, args: ParsedArgs): Promise<void> {
  const id = normalizeId(args.positionals[0]);
  const { cleared } = await releaseItem(ctx.adapter, id, claimPolicy(ctx.config));
  invalidate(ctx);
  console.log(`#${id} released (${cleared} live claim${cleared === 1 ? "" : "s"} cleared)`);
}

async function cmdCreate(ctx: Ctx, args: ParsedArgs): Promise<void> {
  const title = str(args, "--title");
  if (!title) throw new UsageError(commandHelp("create"));
  const parent = str(args, "--parent");
  const item = await ctx.adapter.create({
    title,
    description: str(args, "--description") ?? "",
    parent: parent ? normalizeId(parent) : null,
    labels: str(args, "--label")
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    milestone: str(args, "--milestone"),
    epicId: str(args, "--epic"),
  });
  const blockers = (str(args, "--blocked-by") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(normalizeId);
  for (const blocker of blockers) await ctx.adapter.link(blocker, item.id);
  invalidate(ctx);
  const withDeps = { ...item, blockedBy: [...new Set([...item.blockedBy, ...blockers])] };
  if (args.flags.get("--json")) return printJson(itemToJson(withDeps));
  console.log(`#${item.id}\t${item.title}\t${item.url}`);
}

async function cmdClose(ctx: Ctx, args: ParsedArgs): Promise<void> {
  const id = normalizeId(args.positionals[0]);
  const reason = str(args, "--reason");
  if (reason) await ctx.adapter.comment(id, `closed: ${reason}`);
  await ctx.adapter.update(id, {
    assigneeIds: [],
    removeLabels: [ctx.config.labels.in_progress],
  });
  await ctx.adapter.transition(id, "closed");
  invalidate(ctx);
  console.log(`#${id} closed`);
}

async function cmdDep(ctx: Ctx, args: ParsedArgs): Promise<void> {
  const id = normalizeId(args.positionals[0]);
  const blockedBy = str(args, "--blocked-by");
  const blocks = str(args, "--blocks");
  if ((blockedBy === undefined) === (blocks === undefined)) {
    throw new UsageError(commandHelp("dep"));
  }
  const [blocker, blocked] = blockedBy ? [normalizeId(blockedBy), id] : [id, normalizeId(blocks)];
  await ctx.adapter.link(blocker, blocked);
  invalidate(ctx);
  console.log(`#${blocker} blocks #${blocked}`);
}

async function cmdParent(ctx: Ctx, args: ParsedArgs): Promise<void> {
  const child = normalizeId(args.positionals[0]);
  const parent = normalizeId(args.positionals[1]);
  await ctx.adapter.setParent(child, parent);
  invalidate(ctx);
  console.log(`#${child} parent=#${parent}`);
}

async function cmdRemember(ctx: Ctx, args: ParsedArgs): Promise<void> {
  const [key, ...text] = args.positionals;
  if (!key || text.length === 0) throw new UsageError(commandHelp("remember"));
  const id = await remember(ctx.adapter, ctx.cache, memoryPolicy(ctx), key, text.join(" "));
  console.log(`remembered ${key} on #${id}`);
}

async function cmdForget(ctx: Ctx, args: ParsedArgs): Promise<void> {
  const key = args.positionals[0];
  if (!key) throw new UsageError(commandHelp("forget"));
  await forget(ctx.adapter, ctx.cache, memoryPolicy(ctx), key);
  console.log(`forgot ${key}`);
}

async function cmdMemories(ctx: Ctx, args: ParsedArgs): Promise<void> {
  const memories = await listMemories(
    ctx.adapter,
    ctx.cache,
    memoryPolicy(ctx),
    args.positionals[0],
  );
  if (args.flags.get("--json")) return printJson(memories);
  if (memories.length === 0) return console.error("(no memories)");
  for (const m of memories) console.log(`${m.key}\t${m.ts}\t${m.text}`);
}

function requireTimeTracking(ctx: Ctx): void {
  if (!ctx.adapter.capabilities().timeTracking) {
    throw new UsageError(`the ${ctx.adapter.provider} adapter does not support time tracking`);
  }
}

async function cmdSpend(ctx: Ctx, args: ParsedArgs): Promise<void> {
  requireTimeTracking(ctx);
  const [idArg, durationArg] = args.positionals;
  const id = normalizeId(idArg);
  if (!durationArg) throw new UsageError(commandHelp("spend"));
  const seconds = parseDuration(durationArg);
  if (seconds === 0) throw new UsageError("spend needs a non-zero duration (e.g. 1h30m or -30m)");
  await ctx.adapter.addTimeSpent(id, seconds);
  invalidate(ctx);
  const item = await ctx.adapter.get(id);
  console.log(
    `#${id} ${seconds > 0 ? "spent" : "subtracted"} ${formatDuration(Math.abs(seconds))} → total ${formatDuration(item.timeSpentSeconds)}`,
  );
}

async function cmdEstimate(ctx: Ctx, args: ParsedArgs): Promise<void> {
  requireTimeTracking(ctx);
  const [idArg, durationArg] = args.positionals;
  const id = normalizeId(idArg);
  if (durationArg === undefined) throw new UsageError(commandHelp("estimate"));
  const seconds = parseDuration(durationArg);
  if (seconds < 0) throw new UsageError("an estimate cannot be negative (use 0 to clear it)");
  await ctx.adapter.setTimeEstimate(id, seconds);
  invalidate(ctx);
  console.log(
    seconds === 0 ? `#${id} estimate cleared` : `#${id} estimate ${formatDuration(seconds)}`,
  );
}

async function cmdComment(ctx: Ctx, args: ParsedArgs): Promise<void> {
  const [idArg, ...textParts] = args.positionals;
  const id = normalizeId(idArg);
  const body = textParts.join(" ").trim();
  if (!body) throw new UsageError(commandHelp("comment"));
  await ctx.adapter.comment(id, body);
  console.log(`commented on #${id}`);
}

async function cmdAttach(ctx: Ctx, args: ParsedArgs): Promise<void> {
  const [idArg, ...paths] = args.positionals;
  const id = normalizeId(idArg);
  if (paths.length === 0) throw new UsageError(commandHelp("attach"));
  const files = paths.map((p) => {
    if (!existsSync(p)) throw new UsageError(`${p}: no such file`);
    return { filename: basename(p), content: new Uint8Array(readFileSync(p)) };
  });
  const attachments = await ctx.adapter.attach(id, files, str(args, "--message"));
  if (args.flags.get("--json")) return printJson(attachments);
  for (const a of attachments) console.log(a.markdown);
  console.error(`attached ${attachments.length} file(s) to #${id}`);
}

/** PR ids tolerate GitLab's "!5" and "#5" spellings. */
function normalizePrId(raw: string | undefined): string {
  if (!raw) throw new UsageError("PR id is required");
  return raw.replace(/^[!#]/, "");
}

function currentGitBranch(): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = proc.success ? proc.stdout.toString().trim() : "";
  if (!branch || branch === "HEAD") {
    throw new UsageError("could not determine the current git branch — pass --source");
  }
  return branch;
}

async function cmdPr(ctx: Ctx, args: ParsedArgs): Promise<void> {
  const [action, ...positionals] = args.positionals;
  const json = args.flags.get("--json");

  switch (action) {
    case "create": {
      const title = str(args, "--title");
      const target = str(args, "--target");
      if (!title) throw new UsageError(`--title is required\n\n${commandHelp("pr")}`);
      if (!target) throw new UsageError(`--target is required\n\n${commandHelp("pr")}`);
      const pr = await ctx.adapter.prCreate({
        title,
        target,
        source: str(args, "--source") ?? currentGitBranch(),
        description: str(args, "--description"),
        draft: args.flags.get("--draft") === true,
        issues: (str(args, "--issue") ?? "")
          .split(",")
          .filter(Boolean)
          .map((s) => s.replace(/^#/, "")),
      });
      if (json) return printJson(pr);
      console.log(pr.url);
      console.error(`created PR !${pr.id}: ${pr.source} → ${pr.target}`);
      return;
    }
    case "status": {
      const pr = await ctx.adapter.prGet(normalizePrId(positionals[0]));
      if (json) return printJson(pr);
      const closes = pr.closesIssues.length
        ? ` · closes ${pr.closesIssues.map((i) => `#${i}`).join(",")}`
        : "";
      console.log(`!${pr.id} ${pr.state} · ci ${pr.ci}${pr.draft ? " · draft" : ""}${closes}`);
      console.log(pr.url);
      return;
    }
    case "merge": {
      const id = normalizePrId(positionals[0]);
      if (args.flags.get("--close-issues")) {
        const { closed } = await mergeAndCloseIssues(ctx.adapter, ctx.adapter, id);
        invalidate(ctx);
        console.log(
          closed.length
            ? `merged !${id}, closed ${closed.map((i) => `#${i}`).join(", ")}`
            : `merged !${id} (no Closes trailers found)`,
        );
      } else {
        await ctx.adapter.prMerge(id);
        console.log(`merged !${id}`);
      }
      return;
    }
    case "comment": {
      const id = normalizePrId(positionals[0]);
      const body = positionals.slice(1).join(" ").trim();
      if (!body) throw new UsageError(commandHelp("pr"));
      await ctx.adapter.prComment(id, body);
      console.log(`commented on !${id}`);
      return;
    }
    case "comments": {
      const id = normalizePrId(positionals[0]);
      const comments = await ctx.adapter.prListComments(id);
      if (json) return printJson(comments);
      if (comments.length === 0) return console.error(`(no comments on !${id})`);
      for (const c of comments) {
        console.log(`@${c.author.username}\t${c.createdAt}`);
        console.log(c.body);
        console.log("");
      }
      return;
    }
    case "close": {
      const id = normalizePrId(positionals[0]);
      const reason = str(args, "--message");
      if (reason) await ctx.adapter.prComment(id, reason);
      await ctx.adapter.prClose(id);
      console.log(`closed !${id}`);
      return;
    }
    case "reopen": {
      const id = normalizePrId(positionals[0]);
      await ctx.adapter.prReopen(id);
      console.log(`reopened !${id}`);
      return;
    }
    default:
      throw new UsageError(commandHelp("pr"));
  }
}

async function cmdComments(ctx: Ctx, args: ParsedArgs): Promise<void> {
  const id = normalizeId(args.positionals[0]);
  const comments = await ctx.adapter.listComments(id);
  if (args.flags.get("--json")) return printJson(comments);
  if (comments.length === 0) return console.error(`(no comments on #${id})`);
  for (const c of comments) {
    console.log(`@${c.author.username}\t${c.createdAt}`);
    console.log(c.body);
    console.log("");
  }
}

async function cmdSearch(ctx: Ctx, args: ParsedArgs): Promise<void> {
  const query: SearchQuery = {
    text: args.positionals.join(" ") || undefined,
    assignee: str(args, "--assignee"),
    author: str(args, "--author"),
    label: str(args, "--label"),
    state: (str(args, "--state") as ItemState | "all" | undefined) ?? "all",
    parent: str(args, "--parent") ? normalizeId(str(args, "--parent")) : undefined,
  };
  if (!["open", "closed", "all"].includes(query.state!)) {
    throw new UsageError("--state must be open, closed or all");
  }
  // An explicit --state counts as a filter: `search --state closed` lists all closed items.
  const hasFilter =
    query.assignee || query.author || query.label || query.parent || args.flags.has("--state");
  if (!query.text && !hasFilter) {
    throw new UsageError(commandHelp("search"));
  }

  let items: ReturnType<typeof searchLocal>;
  if (args.flags.get("--remote")) {
    if (query.parent)
      throw new UsageError("--parent is local-only (remote search cannot filter by parent)");
    items = await ctx.adapter.searchRemote(query);
  } else {
    await freshen(ctx);
    items = searchLocal(ctx.cache, query);
  }
  if (args.flags.get("--json")) return printJson(items.map(itemToJson));
  if (items.length === 0) return console.error("(no matches)");
  printItemLines(items);
}

async function cmdUsers(ctx: Ctx, args: ParsedArgs): Promise<void> {
  const query = args.positionals.join(" ");
  if (!query) throw new UsageError(commandHelp("users"));
  const users = await ctx.adapter.resolveUsers(query);
  if (args.flags.get("--json")) return printJson(users);
  if (users.length === 0) return console.error("(no users matched)");
  printUsers(users);
}

async function cmdWhoami(ctx: Ctx, args: ParsedArgs): Promise<void> {
  const me = await ctx.adapter.whoami();
  if (args.flags.get("--json")) return printJson(me);
  console.log(`@${me.username} (id=${me.id})${me.name ? ` — ${me.name}` : ""}`);
}

interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  fix?: string;
}

async function cmdDoctor(args: ParsedArgs): Promise<number> {
  const checks: DoctorCheck[] = [];
  let config: TrackerConfig | null = null;
  try {
    config = loadConfig();
    checks.push({ name: "config", status: "ok", detail: `${config.rootDir}/tracker.config.json` });
  } catch (e) {
    checks.push({
      name: "config",
      status: "fail",
      detail: (e as Error).message,
      fix: "run `tracker init` in the project root to create tracker.config.json",
    });
  }
  let ctx: Ctx | null = null;
  if (config) {
    try {
      const { source } = resolveToken(config);
      checks.push({ name: "token", status: "ok", detail: `found via ${source}` });
      ctx = buildCtx();
    } catch (e) {
      checks.push({
        name: "token",
        status: "fail",
        detail: (e as Error).message,
        fix: `export ${config.gitlab.token_env[0]} or add it to ${config.rootDir}/.env`,
      });
    }
  }
  if (ctx) {
    try {
      const me = await ctx.adapter.whoami();
      checks.push({ name: "auth", status: "ok", detail: `authenticated as @${me.username}` });
    } catch (e) {
      checks.push({
        name: "auth",
        status: "fail",
        detail: (e as Error).message,
        fix: "check the token's validity and `api` scope, and the base_url",
      });
    }
    try {
      const project = await ctx.adapter.probeProject();
      checks.push({ name: "project", status: "ok", detail: project.name });
    } catch (e) {
      checks.push({
        name: "project",
        status: "fail",
        detail: (e as Error).message,
        fix: `check gitlab.project ("${config?.gitlab.project}") and that the token can read it`,
      });
    }
    try {
      await ctx.adapter.probeGraphql();
      checks.push({
        name: "graphql",
        status: "ok",
        detail: "work-item API reachable (Task type found)",
      });
    } catch (e) {
      checks.push({
        name: "graphql",
        status: "fail",
        detail: (e as Error).message,
        fix: "hierarchy commands (create --parent, parent) need the GraphQL work-item API",
      });
    }
    checks.push({
      name: "blocking-links",
      status: "ok",
      detail: `native_blocking=${config?.gitlab.native_blocking} (configured; tier is not verifiable without mutating). Fallback: Tracker-Blocked-By description trailers.`,
    });
    const last = ctx.cache.lastSyncAt();
    checks.push({
      name: "cache",
      status: "ok",
      detail: last
        ? `${ctx.cache.count()} items, synced ${Math.round((Date.now() - last) / 60_000)}m ago`
        : "empty (run: tracker sync)",
    });
    const cachePath = resolve(config!.rootDir, config!.cache.path);
    const gitRoot = findGitRoot(config!.rootDir);
    if (gitRoot) {
      const ignored = isGitIgnored(gitRoot, cachePath);
      checks.push({
        name: "cache-ignored",
        status: ignored === false ? "warn" : "ok",
        detail:
          ignored === null
            ? "git not available, cannot verify"
            : ignored
              ? "cache path is git-ignored"
              : "cache path is NOT git-ignored",
        ...(ignored === false
          ? { fix: `add "${config!.cache.path.replace(/\/[^/]*$/, "")}/" to ${gitRoot}/.gitignore` }
          : {}),
      });
    }
  }
  const failed = checks.some((c) => c.status === "fail");
  if (args.flags.get("--json")) {
    printJson({ ok: !failed, checks });
  } else {
    for (const c of checks) {
      const icon = c.status === "ok" ? "✓" : c.status === "warn" ? "!" : "✗";
      console.log(`${icon} ${c.name.padEnd(15)} ${c.detail}`);
      if (c.fix && c.status !== "ok") console.log(`  fix: ${c.fix}`);
    }
    console.log(failed ? "\nproblems found." : "\nall good.");
  }
  return failed ? 1 : 0;
}

function cmdInit(args: ParsedArgs): void {
  const result = initProject(process.cwd(), {
    baseUrl: str(args, "--base-url"),
    project: str(args, "--project"),
  });
  console.log(`created ${result.configPath}`);
  for (const pattern of result.ignoreAdded) console.log(`added "${pattern}" to .gitignore`);
  for (const warning of result.warnings) console.error(`warning: ${warning}`);
  if (result.placeholders) {
    console.log("next: edit gitlab.base_url and gitlab.project in the config");
  }
  console.log("then: export TRACKER_GITLAB_TOKEN (or add it to .env) and run: tracker doctor");
}

// ---------- dispatch ----------

const VALUE_FLAGS: Record<string, Record<string, FlagKind>> = {
  ready: { "--parent": "value", "--json": "bool" },
  show: { "--json": "bool" },
  children: { "--json": "bool" },
  "epic-status": { "--json": "bool" },
  create: {
    "--title": "value",
    "--description": "value",
    "--parent": "value",
    "--epic": "value",
    "--label": "value",
    "--blocked-by": "value",
    "--milestone": "value",
    "--json": "bool",
  },
  close: { "--reason": "value" },
  dep: { "--blocked-by": "value", "--blocks": "value" },
  search: {
    "--assignee": "value",
    "--author": "value",
    "--label": "value",
    "--state": "value",
    "--parent": "value",
    "--remote": "bool",
    "--json": "bool",
  },
  users: { "--json": "bool" },
  whoami: { "--json": "bool" },
  doctor: { "--json": "bool" },
  init: { "--base-url": "value", "--project": "value" },
  memories: { "--json": "bool" },
  comment: {},
  comments: { "--json": "bool" },
  attach: { "--message": "value", "--json": "bool" },
  pr: {
    "--title": "value",
    "--description": "value",
    "--source": "value",
    "--target": "value",
    "--issue": "value",
    "--draft": "bool",
    "--close-issues": "bool",
    "--message": "value",
    "--json": "bool",
  },
  spend: {},
  estimate: {},
  sync: {},
  claim: {},
  release: {},
  parent: {},
  remember: {},
  forget: {},
};

const ALIASES: Record<string, Record<string, string>> = {
  create: {
    "-t": "--title",
    "-d": "--description",
    "-l": "--label",
    "--labels": "--label",
    "-m": "--milestone",
  },
  close: { "-r": "--reason" },
  attach: { "-m": "--message" },
  pr: { "-t": "--title", "-d": "--description", "-m": "--message", "-i": "--issue" },
};

export async function run(argv: string[]): Promise<number> {
  const [rawCmd, ...rest] = argv;
  // "mr" is the GitLab spelling of "pr" — same command either way.
  const cmd = rawCmd === "mr" ? "pr" : rawCmd;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return cmd ? 0 : 1;
  }
  const spec = VALUE_FLAGS[cmd];
  if (!spec) {
    console.error(`unknown command: ${cmd}\n\n${HELP}`);
    return 1;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(commandHelp(cmd));
    return 0;
  }
  const args = parseArgs(rest, spec, ALIASES[cmd] ?? {});

  // init and doctor must work without an existing config, so no buildCtx here
  if (cmd === "init") {
    cmdInit(args);
    return 0;
  }
  if (cmd === "doctor") return cmdDoctor(args);

  const ctx = buildCtx();
  const handlers: Record<string, (c: Ctx, a: ParsedArgs) => Promise<void>> = {
    sync: cmdSync,
    ready: cmdReady,
    show: cmdShow,
    children: cmdChildren,
    "epic-status": cmdEpicStatus,
    claim: cmdClaim,
    release: cmdRelease,
    create: cmdCreate,
    close: cmdClose,
    dep: cmdDep,
    parent: cmdParent,
    remember: cmdRemember,
    forget: cmdForget,
    memories: cmdMemories,
    comment: cmdComment,
    comments: cmdComments,
    attach: cmdAttach,
    pr: cmdPr,
    spend: cmdSpend,
    estimate: cmdEstimate,
    search: cmdSearch,
    users: cmdUsers,
    whoami: cmdWhoami,
  };
  await handlers[cmd]!(ctx, args);
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(await run(process.argv.slice(2)));
  } catch (e) {
    const message = redact(e instanceof Error ? e.message : String(e));
    console.error(message);
    process.exit(e instanceof DomainError ? 2 : 1);
  }
}
