# tracker

One CLI for all issue-tracking needs — create, claim, dependencies, hierarchy, search,
project memory — built for both humans and AI agents. Provider-agnostic core with a
**GitLab adapter** (self-managed instances supported); GitHub/Jira/Azure DevOps adapters
can be added behind the same interface without touching the core.

## Install

Requires [Bun](https://bun.sh) ≥ 1.1 (the cache uses `bun:sqlite`). The npm package is
**`trackerctl`**; the command it installs is `tracker`.

```sh
bunx trackerctl help            # one-off, no install
npx trackerctl help             # also works (re-executes via bun; tells you if bun is missing)

bun add -d trackerctl           # per project → `bunx tracker <cmd>` / npm scripts
bun add -g trackerctl           # global → `tracker <cmd>`
```

From a checkout of this repo:

```sh
bun install            # dev deps only (typescript, biome); zero runtime deps
bun run tracker help   # run from source
bun run build          # bundle to dist/tracker.js (what the npm package ships)
```

## Configuration

Copy `tracker.config.example.json` to `tracker.config.json` and fill in your instance:

```sh
cp tracker.config.example.json tracker.config.json
```

`tracker.config.json` is **gitignored** (it carries instance/project identifiers); the
committed example holds the shape. The token is also never committed (env var or gitignored
`.env`). Config discovery walks up from the current directory, so any subdirectory of the
project works.

```json
{
  "provider": "gitlab",
  "gitlab": {
    "base_url": "https://gitlab.example.com",
    "project": "group/project",
    "token_env": ["TRACKER_GITLAB_TOKEN", "GITLAB_PERSONAL_ACCESS_TOKEN"],
    "native_blocking": true
  },
  "labels": { "in_progress": "status::in-progress" },
  "memory": { "enabled": true, "title": "📌 Project Memory", "label": "meta::memory" },
  "cache": { "path": ".tracker/cache.sqlite", "stale_minutes": 15 }
}
```

- `gitlab.project` — path (`group/repo`) or numeric id.
- `gitlab.token_env` — env var names tried in order, first in the environment, then in a
  `.env` next to the config (see `.env.example`). The token needs the `api` scope. It is
  never put in URLs, argv, or error messages.
- `gitlab.native_blocking` — `true` on Premium (native blocking links). With `false`,
  dependencies are stored as a `Tracker-Blocked-By: #1, #2` trailer line in the blocked
  issue's description — same semantics, works on any tier, zero extra API calls.

Verify a setup with `tracker doctor`.

## Commands

Read commands serve from a local sqlite cache that auto-syncs when older than
`stale_minutes`; every read command accepts `--json` (stable shapes, below).

| Command | Description |
| --- | --- |
| `tracker sync` | Full cache refresh (issues + hierarchy + dependency links, batched — no per-issue calls) |
| `tracker ready [--parent <id>]` | Items that are open, unblocked, unassigned, not in-progress |
| `tracker show <id>` | Full detail, including blocked-by/blocks |
| `tracker children <id>` | Direct children (work-item hierarchy) |
| `tracker epic-status <id>` | `closed/total` progress over children |
| `tracker search [text] [filters]` | Local FTS5 + filters; `--remote` for server-side |
| `tracker users <query>` | Resolve usernames/names to user ids (project members) |
| `tracker whoami` | Authenticated user |
| `tracker doctor` | Config/token/connectivity/capability checks with fixes |
| `tracker create -t <title> …` | Create; `--parent` builds hierarchy, `--blocked-by` adds deps |
| `tracker claim <id>` | Race-safe claim (see protocol below) |
| `tracker release <id>` | Clear assignee + label, tombstone claim tokens |
| `tracker close <id> [--reason <text>]` | Close (clears assignee + in-progress label) |
| `tracker dep <id> --blocked-by <o> \| --blocks <o>` | Add a dependency edge |
| `tracker parent <child> <parent>` | Re-parent an item |
| `tracker remember <key> <text>` | Store a project memory |
| `tracker forget <key>` | Hide a memory key |
| `tracker memories [filter]` | List memories (latest per key wins) |

Examples:

```sh
tracker ready --parent 12 --json
tracker search --assignee mehmet              # filters work with no text query
tracker search "payment timeout" --label backend --state open
tracker search checkout --remote --json       # fresher, server-side
tracker create -t "Ship login" -d "OAuth" --parent 12 --blocked-by 7,9 -l auth,backend
tracker claim 42 && do-the-work || echo "someone else got it"
tracker close 42 --reason "fixed in MR !17"
tracker remember deploy-cmd "bun run deploy:prod"
```

Exit codes: **0** success · **2** domain failure (lost claim race, refused claim, not
found) · **1** usage/config/network error.

## The claim protocol

Multiple agents can race for the same issue safely with nothing but issue notes:

1. Refuse up-front if the issue is closed, assigned, already labeled in-progress, or the memory issue.
2. Post a claim note: `🔒 tracker-claim agent=<user> token=<ts-rand> at=<iso>`.
3. Wait a 2-second settle window, then re-read **all** notes.
4. Drop claims whose token has a release note (`🔓 tracker-release token=…`) and claims older than 5 minutes (crashed claimers expire).
5. **Oldest live claim wins** — by timestamp, then note id.
6. Loser posts a release note for its own token and exits `2`. Winner assigns themself and adds the in-progress label.

`tracker release` clears assignee + label and posts release marks for every live token, so
stale claims can never win a later election.

## Agent usage (paste into CLAUDE.md)

```markdown
## Issue tracking (tracker CLI)

Use `bun run tracker <cmd>` from the repo (or `tracker` if linked). Exit code 2 means a
domain refusal (e.g. lost a claim race) — pick different work, don't retry.

- Find work:        `tracker ready --json` (optionally `--parent <epic-id>`)
- Take work:        `tracker claim <id>`   — only proceed if exit code is 0
- Finish work:      `tracker close <id> --reason "<what was done>"`
- Abandon work:     `tracker release <id>`
- Add a task:       `tracker create -t "<title>" -d "<details>" [--parent <epic>] [--blocked-by <ids>] --json`
- Dependencies:     `tracker dep <id> --blocked-by <other>`
- Find an issue:    `tracker search "<text>" --json`, or by person with no text:
                    `tracker search --assignee <user> --json`
- Inspect:          `tracker show <id> --json`, `tracker children <id> --json`,
                    `tracker epic-status <id> --json`
- Project memory:   `tracker remember <key> "<fact>"`, `tracker memories --json`,
                    `tracker forget <key>`

Always pass `--json` on read commands and parse stdout; progress notes go to stderr.
Never edit the `📌 Project Memory` issue or `🔒/🔓` notes by hand.
```

## JSON output shapes

`WorkItem` (returned by `ready`, `show`, `children`, `search`, `create`):

```jsonc
{
  "id": "42",                  // string everywhere (Jira-ready)
  "kind": "task",              // "epic" | "task"
  "title": "Ship login",
  "state": "open",             // "open" | "closed"
  "labels": ["auth"],
  "assignees": [{ "id": "6377", "username": "alice", "name": "…" }],
  "author": { "id": "6377", "username": "alice" },  // or null
  "parent": "12",              // or null
  "blockedBy": ["7", "9"],     // ids of open OR closed blockers; `ready` checks openness
  "url": "https://gitlab…/issues/42",
  "description": "…",
  "updatedAt": "2026-06-10T17:21:33.000Z"
}
```

Notes: `show --json` adds `"blocks": ["50"]` (reverse edges from the cache). `--remote`
search results have `parent: null` and only trailer-derived `blockedBy` (the REST search
endpoint returns neither).

Other shapes:

```jsonc
// epic-status   { "parent": "12", "total": 5, "open": 2, "closed": 3, "pctClosed": 60 }
// memories      [{ "key": "deploy-cmd", "text": "bun run deploy:prod", "ts": "2026-…" }]
// users/whoami  [{ "id": "6377", "username": "alice", "name": "…" }]
// doctor        { "ok": true, "checks": [{ "name": "auth", "status": "ok", "detail": "…", "fix": "…" }] }
```

## Architecture

```
src/
  model/      canonical types (WorkItem, Comment, User…) — no provider words here
  adapters/
    types.ts  TrackerAdapter port + AdapterCapabilities
    gitlab/   the only concrete adapter: fetch client (REST /api/v4 + GraphQL),
              wire↔canonical mapping, batched hierarchy+links sync, trailer fallback
  core/       provider-neutral policies: claim/release, ready, epic-status, memory,
              local search, sync — built ONLY on the port + cache
  cache/      sqlite (bun:sqlite) canonical snapshot + FTS5 index + meta/staleness
  cli/        command parsing, human + --json output, exit codes
```

The core never imports provider code. The contract test suite
(`test/contract/suite.ts`) runs identically against a `FakeAdapter` and the GitLab
adapter over mocked HTTP — that is the proof a new backend only needs to implement
`TrackerAdapter` to get `ready`/`claim`/`search`/memory for free.

## Development

```sh
bun test           # 100 tests: unit, adapter contract ×2, claim races, CLI
bun run gate       # typecheck + lint (biome) + tests
bun run smoke      # LIVE end-to-end against the configured project (creates+closes
                   # clearly marked issues) — sandbox projects only
```

## Publishing

`npm publish` runs the full gate and the build automatically (`prepublishOnly`). The
package ships only `bin/` (Node-safe launcher), `dist/tracker.js` (bundled CLI), the
example config, README, and LICENSE — no sources, tests, or local config.
