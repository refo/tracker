# DECISIONS

## Phase 0 interview answers (2026-06-10)

| Question | Answer |
| --- | --- |
| Location | current directory (standalone package with its own `package.json`) |
| Runtime | Bun (1.3.x), `bun:sqlite`, `bun test` |
| GitLab base URL | the team's self-managed instance — recorded only in the local, untracked `tracker.config.json` |
| GitLab project | recorded only in the local, untracked `tracker.config.json` |
| Token | env var; user has `GITLAB_PERSONAL_ACCESS_TOKEN` exported in zsh. Resolution order: `TRACKER_GITLAB_TOKEN` → `GITLAB_PERSONAL_ACCESS_TOKEN` → gitignored `.env` next to the config. No other storage needed. |
| GitLab tier | Assume Premium (native blocking links); capability flag + fallback implemented regardless |
| Labels | in-progress = `status::in-progress`; epics via work-item hierarchy, no epic label |
| Memory feature | Yes, ported as-is |
| Live tests | Yes — the same project (currently an empty board) doubles as the sandbox; live smoke test allowed with cleanup |

## Judgment calls

- **Claim/release note markers** are `🔒 tracker-claim` / `🔓 tracker-release` (spine used
  `spine-claim`/`spine-release`). Same grammar (`agent=… token=… at=…`), different tool name.
  Spine claims and tracker claims therefore do not contend with each other — acceptable since
  spine is being replaced.
- **Blocking-link fallback (non-Premium)**: encoded as a machine-readable trailer line in the
  *blocked* issue's description: `Tracker-Blocked-By: #12, #34`. Descriptions already arrive in
  the normal sync payload, so the fallback costs zero extra API calls and is shared state visible
  to every agent. Trailers are parsed on every sync (merged + deduped with native links), so a
  project migrating between tiers keeps working.
- **Tier detection is not probe-based**: there is no non-destructive API to verify that blocking
  links are licensed. `gitlab.native_blocking` in config (default `true` per interview) is the
  source of truth; `tracker doctor` reports it as "configured, not verifiable without mutating".
- **Sync strategy** (fixes spine's O(N) link fetching): one paginated REST pass
  (`/issues?state=all&per_page=100`) for core fields + one paginated GraphQL pass over
  `project.workItems` that batches hierarchy (`WorkItemWidgetHierarchy`) *and* dependency links
  (`WorkItemWidgetLinkedItems`) 100 items at a time. ~N/100 + N/100 requests total, no per-issue
  calls.
- **`kind` mapping**: `workItemType.name === "Epic"` → `epic`, everything else → `task`.
  Project-level GitLab "epics" are usually plain issues with children; `children`/`epic-status`
  operate on the hierarchy regardless of `kind`, so this is informational only.
- **Staleness tracking** moved from cache-file mtime (spine) to a `last_sync_at` row in the
  `meta` table — file mtime is touched by reads/WAL and lies.
- **`resolveUsers`** queries project members (`/projects/:id/users?search=`) rather than the
  instance-wide `/users` — members are who you can assign, and instance-wide search may be
  restricted on self-managed installs.
- **Auth header**: `Authorization: Bearer <token>` (works for PATs on self-managed GitLab, same
  as the maestro reference lib). Token is redacted from every error message and never appears in
  argv or logs.
- **ItemId** is the GitLab `iid` as a string (canonical model requires string ids for future
  Jira-style `PROJ-123` ids).
- **`searchRemote` results** carry no hierarchy/link data (REST search endpoint doesn't return
  them); documented in the JSON shape as `parent: null, blockedBy: []` for `--remote` results.
- **`--epic <id>` on `create`** (spine passthrough to GitLab group epics, Premium `epic_id`
  field) is kept as a provider-specific draft field; the Fake adapter ignores it.
- **Local search filtering**: FTS5 narrows by text; assignee/author/label/state/parent filters
  applied on the canonical rows in code. At the target scale (≤ a few thousand issues) this is
  simpler and exactly as correct as pushing JSON-array predicates into SQL.
- **`search` defaults to `--state all`** (unlike `ready`, which is open-only by definition):
  "find that issue" usually includes closed ones; narrow with `--state open` when needed.
- **Write commands invalidate the cache** (reset `last_sync_at`) so the next read auto-syncs
  instead of serving a snapshot that contradicts what the agent just did. Spine let reads lie
  for up to 15 minutes after a write; the cost of the fix is one extra sync after mutations.
- **System notes are filtered out** of `listComments` (`system: true` GitLab notes like
  "changed the description") so claim elections and memory resolution only see human/agent notes.
- **`claim` additionally refuses the memory issue** (by `meta::memory` label) — spine only
  excluded it from `ready`; claiming it was possible but never meaningful.
- **`remember`/`forget`/`memories` find the memory issue** via: cached id in `meta` →
  local snapshot title match → remote search → create. Two cold agents racing the very first
  `remember` could still create a duplicate (spine had the same window; accepted as-is).
- **Claim refusals exit 2 with no note posted** — pre-checks happen before the claim note, so
  refused claims leave no garbage on the issue (verified by contract test).
- **GraphQL queries use variables** (never string interpolation) — kills the injection
  footgun spine had with title strings, and lets the fake server match queries structurally.
- **CLI exit-code mapping**: `DomainError` → 2, everything else (usage, config, HTTP) → 1,
  per the brief. `epic-status`/`children` on an item with no children print a stderr note and
  exit 0 (spine behavior preserved).

- **No identifying strings in git** (2026-06-10, by request): the real `tracker.config.json`
  (instance URL, project path) is gitignored; a placeholder `tracker.config.example.json` is
  committed instead. Docs use generic examples only, and the repo history was rebuilt once to
  purge identifiers committed earlier the same day.
- **Cache-dir gitignore guard**: on first creation of the cache directory, tracker checks
  whether the path is git-ignored (via `git check-ignore`); if not, it appends the directory to
  the config-root `.gitignore` and says so on stderr. `tracker doctor` reports the same check.
  Outside a git repo (or without git) the guard is a silent no-op.

- **npm packaging (2026-06-10)**: published name `trackerctl` (`tracker` and `tracker-cli`
  are taken on npm; `trackerctl` was free, follows the kubectl/systemctl CLI convention, and
  is visually distinct from the taken names). The installed command stays `tracker` (npm bin
  name ≠ package name, and npx/bunx auto-select a package's single bin). Bun remains the only
  runtime (`bun:sqlite`); `bin/tracker.mjs` is a Node-safe launcher so `npx` without Bun
  prints an install hint instead of a shebang error. `prepublishOnly` runs gate + build; the
  tarball ships launcher + bundled `dist/tracker.js` + example config only (verified clean of
  identifiers). `.tracker/` stays fully ignored — it only ever holds the sqlite cache files,
  so no per-file ignore split is needed.

## Verification record (2026-06-10)

- `bun run gate`: typecheck clean, biome clean, **94 tests / 0 fail** (unit + contract suite
  against FakeAdapter and mocked-HTTP GitLabAdapter + race interleavings + CLI subprocess tests).
- `tracker doctor` against the configured self-managed instance: all checks green (token via
  `GITLAB_PERSONAL_ACCESS_TOKEN`, auth OK, project + GraphQL reachable).
- `bun scripts/smoke.ts` against the sandbox (= main, empty) project: **17/17 checks PASSED**
  live — create/hierarchy/native blocking link/sync/ready/epic-status/FTS/remote search/
  claim+refuse+release/memory remember+forget/users — with full cleanup (#1–#3 closed).
  The `📌 Project Memory` issue (#4) intentionally remains open.

## Intentionally deferred

- Additional adapters (GitHub/Jira/ADO) — the port + contract suite are the extension points.
- Claim-note compatibility/migration with spine's `spine-claim` marks.
- Cross-project dependency links (blockers outside the configured project don't block `ready`).
- Verifying the GitLab tier non-destructively in `doctor` (no such API exists).
- `--json` on write commands other than `create` (claim/release communicate via exit codes).
