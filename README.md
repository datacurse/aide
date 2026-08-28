# aide

A bird's-eye view across your projects, with Claude working in each one.

The file tree, the editor, and the git graph are not the product — those are solved,
buyable components. The product is the **project state machine**: backlog → conversation →
agent → verified diff. This repo is the runner, and it is now developed in itself.

**What works today.** Add a git repo, say what you want, watch Opus work it, read the
diff. Interrupt it mid-run. Then accept it: Sonnet drafts a commit message and the spec
update the change earns, you edit both, and aide commits exactly the files you reviewed.

**Runs work the project's own checkout, one at a time.** Worktrees used to isolate them,
and that turned out to isolate the wrong thing: a worktree isolates *committed* state,
while the real state of a project lives uncommitted in the tree you are looking at. A run
branched from HEAD works against a repo that has not been true for hours, and its changes
can never appear in the dev server you are watching — so nothing visual was ever
reviewable. Parallelism moved up a level: several projects, one agent each.

What makes that safe is a **checkpoint**. Before each conversation's first turn aide
snapshots the working tree — untracked files included — onto a private ref, so a bad run is
one `git restore` away. The same snapshot is the diff baseline, which is what keeps "what
the agent did" separate from "what I already had uncommitted". (The restore puts back what
a run changed or deleted; files it *created* stay, because removing them would mean
`git clean` and that takes everything else untracked with it.)

## Requirements

- Node 22+, pnpm
- An authenticated Claude Code install (`claude` on your PATH, logged in)

aide has no login flow of its own. It drives the Claude Agent SDK, which inherits whatever
credentials your machine already has: your Claude subscription login by default, or
`ANTHROPIC_API_KEY` if you export one. Anthropic does not permit third-party products to
offer claude.ai login, so bring your own — that is the only supported setup.

## Run it

```bash
pnpm install
pnpm probe     # verifies auth + model access for a few cents before anything else
pnpm smoke     # git plumbing + shell policy, against a throwaway repo. No model calls.
pnpm smoke:queue  # chat lane, lock and checkpoints, against a stub worker. No model calls.
pnpm dev       # web on :5173, which starts the daemon on :4317
```

Open http://localhost:5173, add a repo by absolute path, and say what you want done.

The daemon is started, stopped and restarted from the header — a dev-only control
plane the Vite server exposes at `/__daemon`. It has to live there rather than in the
daemon: the browser reaches the daemon over HTTP, so a dead daemon is precisely the case
with nobody left to receive "please start". Vite is already running, so Vite owns the
process.

`pnpm dev` takes port 5173 back if a stale dev server is sitting on it, and refuses to
start rather than drifting to the next free port. That is not tidiness: the daemon
allowlists the dev server's origin by exact authority, so a page served from :5174 gets a
403 on every POST while GETs keep working — "it loads but nothing saves", with nothing
pointing at the port. Only Node processes are reclaimed; anything else holding the port is
named and left alone.

That control plane exists only under `pnpm dev`. `pnpm daemon` still runs one standalone
for anything real, and the dev server adopts a daemon started that way instead of
fighting it for the port — it just cannot stop what it did not start.

## How it is put together

```
browser (Vite/React)  ──HTTP──▶  daemon (Fastify)  ──child process──▶  worker  ──▶ Agent SDK
        ▲             ──WS────▶     registry          one per conversation    query()
        └──── run events ────────   chat lane                                     │
                                    one run per project ──▶ the project's ◀───────┘
                                    checkpoints             own checkout
```

- **`packages/protocol`** — plain TypeScript types shared by both ends. No schema library:
  both ends compile from the same definitions, so the compiler already guards the wire.
  The one runtime check is on hand-edited `project.md`, where a setting aide no longer
  reads must be reported rather than silently ignored.
- **`packages/daemon`** — project registry, the chat lane and its single-run lock,
  checkpoints, event log. Long-lived, so runs continue with the browser closed. Three files
  import the Agent SDK and nothing else does: `src/agent.ts` for runs, `src/helper.ts` for
  one-shot calls with no tools such as drafting a commit message, and `src/sessions.ts` for
  reading transcripts the SDK already wrote.
- **`packages/web`** — panes for the board, conversations and git, plus `vite-daemon.ts`,
  the dev-only plugin that owns the daemon process.

State lives in files, not a database:

| Where | What |
| --- | --- |
| `~/.aide/registry.json` | the projects you have added |
| `~/.aide/runs/<id>.ndjson` | append-only event log, one JSON object per line |
| `~/.aide/board.json` | which conversation is working which backlog row |
| `<project>/.aide/` | backlog, spec, design notes — git-tracked, human-readable, portable |
| `<project>/.aide/project.md` | the brief, put in every agent's system prompt |
| `refs/aide/checkpoints/<session>` | the tree as it was before a conversation started |

Adding a project is `mkdir .aide`, not an import wizard. If aide disappears, the project is
not hostage: `.aide/` is still a readable description of the work.

## Things that are load-bearing

Each of these is a bug that has already been paid for once.

- **Interrupt is not a signal.** Stopping a run sends the SDK's `interrupt()` control
  message, not `SIGINT`. On Windows, Node maps `child.kill("SIGINT")` to `TerminateProcess`,
  which ends the turn unfinished and records no result. `interrupt()` ends it cleanly with a
  cost figure attached, on every platform. This is also why runs use streaming input mode:
  control requests do not exist when the prompt is a plain string.
- **`--bare` is never passed.** It is the documented recommendation for scripted calls, and
  it disables subscription auth — bare mode never reads OAuth credentials or the keychain.
  The measured cost of not using it is about 700 tokens per run.
- **Diffs are computed through a scratch index.** A run's work is
  `diff --cached <checkpoint>` against a throwaway `GIT_INDEX_FILE`, never `git add` in the
  real one — the project's index belongs to you, and aide must not stage your half-finished
  work to answer its own question. The obvious `git diff <checkpoint>` is wrong in both
  directions: it reports a pre-existing untracked file as *deleted* and omits the file the
  run created.
- **A commit names its paths.** Staging is limited to the paths in the diff you reviewed,
  and so is the commit, which is what stops it taking a stray file or whatever you had
  staged by hand.
- **The checkpoint is not `git stash`.** The porcelain reverts your working tree, which is
  the opposite of a backup when a dev server is serving it. `git stash create` leaves the
  tree alone but silently drops untracked files — measured: one path captured, where the
  scratch-index snapshot captured both.
- **Permissions fail closed.** `permissionMode: "dontAsk"` plus an explicit allowlist. Print
  mode starts in Manual on every plan, so an allowlist alone is not a baseline.
- **No budget cap by default.** A conversation has a human and a stop button, and a cap
  that severs an answer mid-sentence bills you for the whole turn anyway, buying nothing.
  `AIDE_CHAT_MAX_BUDGET_USD` sets one if you want it.
- **Cost numbers are estimates.** `total_cost_usd` comes from a price table bundled into the
  SDK at build time. Good for a dashboard, never for billing. Read totals from
  `modelUsage`, which includes subagent spend; `usage` excludes it.
- **A conversation's worker outlives its turn.** A follow-up is a
  message into a session that is still open, which skips a fork, a CLI boot and a replay
  of the transcript from disk — measured at ~540ms, ~850ms and "however long your history
  is" respectively. The cold path is untouched and still runs whenever there is no live
  session: first message, idle eviction, crash, daemon restart. `resume` carries the
  conversation in those cases, so warmth is only ever a saving.
- **In an open session, the SDK's cost totals are cumulative.** `total_cost_usd` and
  `modelUsage` carry the running total for the whole session on *every* result, not that
  turn's spend — fork-per-turn hid this, because each turn was a fresh `query()` starting
  from zero. `agent.ts` subtracts what it has already reported. Without that, turn five
  bills you for turns one through five and a chat appears to get more expensive the longer
  you talk to it.
- **The lock is derived, not stored.** "Who has this project" is exactly "is a turn in
  flight", which the daemon can already answer. A lock *file* would be the one piece of
  state that needs reconciling on boot, and a daemon killed mid-run would leave a repo that
  looks permanently held by a process that no longer exists.
- **A second run is refused, not queued.** A queued turn would start against a tree the
  previous run had just rewritten and nobody had reviewed — the staleness this whole design
  exists to remove, reintroduced one level up.
- **Row ids are floored by git history.** Closing a row deletes its line while the commits
  it produced keep its number in an `Aide-Row` trailer, so the next id is drawn above every
  trailer in the log. Number from the backlog file alone and a reused `0003` relabels
  someone else's commit in the history view.
- **The daemon's health is polled, not checked once.** The daemon takes a second or two to
  boot, so a single check at page load races it — and losing that race pinned the header to
  "daemon offline" for the life of the page while every other request worked fine.
- **The daemon is never hot-reloaded.** `pnpm dev` runs plain `tsx`, not `tsx watch`.
  tsx watch follows the import graph, and `packages/protocol/src/*` is in the daemon's
  graph through a pnpm junction — so a run rewriting daemon source made chokidar fire and
  the daemon was SIGTERMed mid-request, part way through the git work. Restart is a button,
  and it waits until nothing is in flight. This matters far more now that runs edit the
  daemon's own checkout as a matter of course rather than by accident.
- **Committing daemon code does not take effect until you restart.** Worse than
  no-effect, actually: `fork()` reads `worker/main.ts` from disk at run time, so an
  old daemon can fork a *new* worker and pass it a job shape it does not understand.
- **There is no boot reconciliation, and nothing to reconcile.** A conversation's state is
  derived on every read from whether a turn is actually in flight — including the lock — so
  a crash leaves nothing filed wrongly and nothing to correct.
- **Loopback is not a security boundary.** Any page you visit can call
  `http://127.0.0.1:4317`, and DNS rebinding defeats the absence of CORS headers. The
  daemon checks `Host` against an allowlist of literal loopback authorities — rebinding
  can forge the name but not that header.
- **Bash permissions are decided by aide, not the SDK.** `policy.ts` is a pure function
  so `pnpm smoke` can assert it, and so a denial can say what to do instead. Expressing
  it as `Bash(pnpm *)` meant depending on undocumented matching rules that strip env
  prefixes, split compound commands, and change between releases.
## The lifecycle

```
working → needs you → committed → done
                   \→ dropped | failed
```

A conversation is the unit of work. **Two human decisions, not one**, and they are
different questions: reading the diff and committing it is a judgement about the *code*;
closing the row as done is a judgement about the *work*, made after watching it run in the
dev server that serves this very tree.

Recoverability sits under both. A commit is `git reset` away, and the whole conversation is
one `git restore --source=refs/aide/checkpoints/<session>` away — including the untracked
files it clobbered. The checkpoint is kept when the row closes, because closing must not be
the one irreversible step in the flow.

Every commit carries `Aide-Row` and `Aide-Session` trailers, so months later `git show`
still says which backlog line asked for the change and which transcript explains it — and
those trailers are also what stop a closed row's number ever being handed out twice.

## Next

1. Intake pipeline: `inbox.md` → classify → **patch proposal** against specs → you accept or
   reject hunks → specs and roadmap regenerate. The human gate is the point: an agent that
   can silently edit a spec to match what it built makes the specs worthless.
2. Spec drift detection when a conversation closes
3. Cross-project dashboard
4. Resume runs across a daemon restart — today a restart orphans anything in flight
5. SQLite, when run-history queries start to hurt
6. CodeMirror 6 read-only viewer
7. Git graph — last, most fun, least useful
