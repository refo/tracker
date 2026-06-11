export const HELP = `tracker — multi-backend issue tracking for humans and AI agents

usage: tracker <command> [args]

setup:
  init [--base-url <url>] [--project <group/project>]
                             scaffold tracker.config.json + .gitignore entries
  doctor                     verify config, token, connectivity, capabilities

read commands (local cache, auto-sync when stale; all accept --json):
  sync                       refresh the local cache from the provider
  ready [--parent <id>]      open + unblocked + unassigned + not in-progress
  show <id>                  full detail for one item
  children <id>              direct children of an item
  epic-status <id>           closed/total progress over an item's children
  search [text] [filters]    full-text + filters; --remote for server-side search
  comments <id>              list an item's comments (oldest first)
  users <query>              resolve usernames/names to user ids
  whoami                     the authenticated user
  memories [filter]          list project memories

write commands:
  create -t <title> [-d <desc>] [--parent <id>] [--epic <id>] [-l a,b]
         [--blocked-by 1,2] [-m <milestone>] [--json]
  claim <id>                 race-safe claim (assigns you + in-progress label)
  release <id>               clear assignee/label, tombstone live claim tokens
  close <id> [--reason <text>]
  comment <id> <text>        post a comment on an item
  attach <id> <file...> [-m <message>]
                             upload files and attach them via a comment
  spend <id> <duration>      add time spent (1h30m, 45m, 2d; -30m subtracts)
  estimate <id> <duration>   set the time estimate (0 clears it)
  dep <id> --blocked-by <other> | --blocks <other>
  parent <child-id> <parent-id>
  remember <key> <text>      store a project memory (key has no whitespace)
  forget <key>               hide a memory key

pull/merge requests ("pr" and "mr" are the same command):
  pr create -t <title> --target <branch> [--source <branch>] [-d <desc>]
            [-i <issue-ids>] [--draft] [--json]
  pr status <id> [--json]    state + provider-neutral ci signal (none|pending|green|red)
  pr merge <id> [--close-issues]
  pr comment <id> <text>
  pr comments <id> [--json]
  pr close <id> [-m <reason>] | pr reopen <id>

search filters:
  --assignee <user> --author <user> --label <l> --state open|closed|all
  --parent <id> --remote     (text query optional when any filter is given)

examples:
  tracker ready --parent 12 --json
  tracker search --assignee mehmet           # works with no text query
  tracker search "login bug" --state open
  tracker create -t "Fix login" --parent 12 --blocked-by 7
  tracker claim 42 && echo mine || echo taken
  tracker close 42 --reason "fixed in MR !17"

exit codes: 0 ok · 2 domain failure (lost race, refused claim, not found) · 1 usage/config error`;

const PER_COMMAND: Record<string, string> = {
  sync: "usage: tracker sync\n\nFull refresh of the local cache (issues + hierarchy + dependency links).",
  ready: `usage: tracker ready [--parent <id>] [--json]

Items that are open, not blocked by any open item, unassigned, not in-progress,
and not the memory issue.

examples:
  tracker ready
  tracker ready --parent 12 --json`,
  show: "usage: tracker show <id> [--json]\n\nexample: tracker show 42",
  children: "usage: tracker children <id> [--json]\n\nexample: tracker children 12",
  "epic-status": "usage: tracker epic-status <id> [--json]\n\nexample: tracker epic-status 12",
  claim: `usage: tracker claim <id>

Race-safe claim: posts a claim note, waits a settle window, re-reads all notes,
oldest live claim wins. Loser exits 2. Winner gets assigned + in-progress label.

example: tracker claim 42 && start-work || pick-another`,
  release:
    "usage: tracker release <id>\n\nClears assignee + in-progress label and tombstones all live claim tokens.",
  create: `usage: tracker create -t <title> [-d <desc>] [--parent <id>] [--epic <id>]
                      [-l label1,label2] [--blocked-by <id1,id2>] [-m <milestone>] [--json]

examples:
  tracker create -t "Ship login" -d "OAuth via Keycloak" -l backend,auth
  tracker create -t "Subtask" --parent 12 --blocked-by 7,9`,
  close:
    'usage: tracker close <id> [--reason <text>]\n\nexample: tracker close 42 --reason "fixed in MR !17"',
  comment: `usage: tracker comment <id> <text>

Posts a comment on the item. Everything after the id is joined into one
comment body, so quoting multi-word text is optional.

example: tracker comment 42 "blocked on the design review, see thread"`,
  attach: `usage: tracker attach <id> <file...> [-m <message>] [--json]

Uploads each file to the provider and posts ONE comment on the item containing
the optional message plus a markdown reference per file, so the attachments are
discoverable from the item itself. Prints each file's markdown snippet (reusable
in descriptions); --json emits [{filename, url, markdown}].

examples:
  tracker attach 42 before.png after.png -m "reference screenshots"
  tracker attach 42 design.png --json`,
  pr: `usage: tracker pr <action> …    (alias: tracker mr)

actions:
  create -t <title> --target <branch> [--source <branch>] [-d <desc>]
         [-i <id1,id2>] [--draft] [--json]
                      open a PR/MR; --source defaults to the current git branch.
                      -i records "Closes #N" trailers so merge --close-issues
                      can close those issues explicitly (no provider magic).
  status <id> [--json]
                      state (open|merged|closed) + ci signal (none|pending|green|red);
                      poll this to watch a pipeline.
  merge <id> [--close-issues]
                      merge; --close-issues then closes every trailer-referenced
                      issue via the issue tracker and comments why.
  comment <id> <text> post a comment
  comments <id> [--json]
                      list comments oldest-first
  close <id> [-m <reason>]
                      close without merging ("reject"); reason posts as a comment
  reopen <id>

examples:
  tracker pr create -t "Fix login" --target dev -i 42 --json
  tracker pr status 5 --json
  tracker pr merge 5 --close-issues
  tracker pr close 5 -m "superseded by !6"`,
  comments: `usage: tracker comments <id> [--json]

Lists the item's comments oldest-first (system notes are filtered out). Claim
notes (🔒/🔓) and memory entries (📌) appear here too — useful for debugging.

example: tracker comments 42 --json`,
  spend: `usage: tracker spend <id> <duration>

Adds to the item's time spent. Durations use GitLab conventions:
units w/d/h/m/s with 1d = 8h and 1w = 5d. A leading "-" subtracts.

examples:
  tracker spend 42 1h30m
  tracker spend 42 -30m     # logged too much, take 30m back`,
  estimate: `usage: tracker estimate <id> <duration>

Sets the item's time estimate (same duration format as spend). 0 clears it.

examples:
  tracker estimate 42 2d
  tracker estimate 42 0`,
  dep: `usage: tracker dep <id> --blocked-by <other> | --blocks <other>

examples:
  tracker dep 42 --blocked-by 7    # 7 blocks 42
  tracker dep 42 --blocks 50       # 42 blocks 50`,
  parent: "usage: tracker parent <child-id> <parent-id>\n\nexample: tracker parent 42 12",
  remember:
    'usage: tracker remember <key> <text>\n\nexample: tracker remember deploy-cmd "bun run deploy:prod"',
  forget: "usage: tracker forget <key>\n\nexample: tracker forget deploy-cmd",
  memories: "usage: tracker memories [filter] [--json]\n\nexample: tracker memories deploy",
  search: `usage: tracker search [text] [--assignee <user>] [--author <user>] [--label <l>]
                      [--state open|closed|all] [--parent <id>] [--remote] [--json]

Local-first: full-text (FTS5) over cached title+description plus structured
filters. Text is optional when at least one filter is given. --remote runs the
provider's server-side search instead (fresher, slower, no --parent).

examples:
  tracker search --assignee mehmet
  tracker search --state closed                # state alone is a valid filter
  tracker search "payment timeout" --label backend --state open
  tracker search checkout --remote --json`,
  users: "usage: tracker users <query> [--json]\n\nexample: tracker users mehmet",
  whoami: "usage: tracker whoami [--json]",
  doctor:
    "usage: tracker doctor [--json]\n\nVerifies config, token, REST/GraphQL connectivity, capabilities, cache.",
  init: `usage: tracker init [--base-url <url>] [--project <group/project>]

Scaffolds tracker.config.json in the current directory (placeholders when the
flags are omitted) and, inside a git repository, git-ignores the local-only
files (tracker.config.json, .tracker/, .env) so instance and project
identifiers can never be committed. Refuses to overwrite an existing config.

examples:
  tracker init --base-url https://gitlab.example.com --project group/project
  tracker init    # then edit the placeholders in tracker.config.json`,
};

export function commandHelp(cmd: string): string {
  return PER_COMMAND[cmd] ?? HELP;
}
