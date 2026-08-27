# aide

A bird's-eye view across your projects, with Claude working tasks in each one.

The file tree, the editor, and the git graph are not the product — those are solved,
buyable components. The product is the **project state machine**: inbox → spec → roadmap →
task → agent → verified diff. This repo is the runner, and it is now developed in itself.

**What works today.** Add a git repo, write a task, watch Opus work it in an isolated
worktree, read the diff. Interrupt it mid-run. Two run concurrently, the rest queue.
Then accept it: Sonnet drafts a commit message from the diff, you edit it, aide commits
to the task branch and writes a journal entry — and landing it into your branch is a
second, separate button.

Each task runs in a fresh git worktree, so the project's `bootstrap` command (from
`.aide/project.md`) installs its dependencies once before the agent starts — a worktree
is a complete source tree with nothing installed, and an agent that cannot typecheck
will tell you confidently that it did.

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
pnpm smoke:queue  # supervisor semantics against a stub worker. No model calls.
pnpm dev       # web on :5173, which starts the daemon on :4317
```

Open http://localhost:5173, add a repo by absolute path, write a task, run it.

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
        ▲             ──WS────▶     registry             one per run      query()
        └──── run events ────────   queue (cap 2)                            │
                                    supervisor            git worktree ◀─────┘
```

- **`packages/protocol`** — plain TypeScript types shared by both ends. No schema library:
  both ends compile from the same definitions, so the compiler already guards the wire.
  The one runtime check is on hand-edited task frontmatter, where a typo must fail loudly.
- **`packages/daemon`** — project registry, task queue, worker supervision, event log.
  Long-lived, so runs continue with the browser closed. Two files import the Agent SDK and
  nothing else does: `src/agent.ts` for runs, `src/helper.ts` for one-shot calls with no
  tools, such as drafting a commit message.
- **`packages/web`** — three panes: projects, tasks, live run — plus `vite-daemon.ts`, the
  dev-only plugin that owns the daemon process.

State lives in files, not a database:

| Where | What |
| --- | --- |
| `~/.aide/registry.json` | the projects you have added |
| `~/.aide/runs/<id>.ndjson` | append-only event log, one JSON object per line |
| `<project>/.aide/` | tasks, specs, journal — git-tracked, human-readable, portable |
| `<project>/.aide/project.md` | frontmatter the daemon reads (`bootstrap`), prose the agent reads |

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
- **Diffs run `git add -A -N` first.** Intent-to-add is what makes files the agent *created*
  appear in `git diff`. Without it the first run looks like it did nothing.
- **Permissions fail closed.** `permissionMode: "dontAsk"` plus an explicit allowlist. Print
  mode starts in Manual on every plan, so an allowlist alone is not a baseline.
- **Cost numbers are estimates.** `total_cost_usd` comes from a price table bundled into the
  SDK at build time. Good for a dashboard, never for billing. Read totals from
  `modelUsage`, which includes subagent spend; `usage` excludes it.
- **Worktrees are ignored via `.git/info/exclude`, not `.gitignore`.** `.gitignore` is a
  tracked file: appending to it leaves the project with an uncommitted change aide made
  and nobody asked for — which then blocks the first land, because merging refuses to run
  over a dirty tree. aide would have broken its own workflow on the first task.
- **A failed merge is aborted, not left sitting.** Landing refuses up front if the target
  is dirty, and runs `git merge --abort` on conflict. Without the abort, a failed land
  strands the project half-merged in a state aide has no UI for.
- **The daemon's health is polled, not checked once.** The daemon takes a second or two to
  boot, so a single check at page load races it — and losing that race pinned the header to
  "daemon offline" for the life of the page while every other request worked fine.
- **The daemon is never hot-reloaded.** `pnpm dev` runs plain `tsx`, not `tsx watch`.
  tsx watch follows the import graph, and `packages/protocol/src/*` is in the daemon's
  graph through a pnpm junction — so landing a task rewrote daemon source, chokidar
  fired, and the daemon was SIGTERMed mid-request. The merge committed; the worktree
  cleanup, the status update and the HTTP response did not. Restart is a button.
- **Landing daemon code does not take effect until you restart.** Worse than
  no-effect, actually: `fork()` reads `worker/main.ts` from disk at run time, so an
  old daemon can fork a *new* worker and pass it a job shape it does not understand.
- **Boot reconciliation assumes nothing is running.** It can, because the daemon is
  the only thing that starts runs — so at boot every task filed `running` is wreckage.
  It runs before `listen`, because the health endpoint answering has to mean the task
  list is honest.
- **Loopback is not a security boundary.** Any page you visit can call
  `http://127.0.0.1:4317`, and DNS rebinding defeats the absence of CORS headers. The
  daemon checks `Host` against an allowlist of literal loopback authorities — rebinding
  can forge the name but not that header.
- **Bash permissions are decided by aide, not the SDK.** `policy.ts` is a pure function
  so `pnpm smoke` can assert it, and so a denial can say what to do instead. Expressing
  it as `Bash(pnpm *)` meant depending on undocumented matching rules that strip env
  prefixes, split compound commands, and change between releases.
- **Journal entries are assembled, not written by a model.** Every line comes from the run's
  own event log — what the agent said, which tools it called, what it cost, what it was
  denied. A narrated journal is indistinguishable from an invented one by the time anyone
  needs it. The commit message is the one model-written part, and it is quoted as such.

## The task lifecycle

```
queued → running → needs-review → committed → done
                \→ failed | cancelled
```

Two human gates, not one. `needs-review` means the agent stopped and nobody has read the
diff. `committed` means you read it and the work is on `aide/task-NNNN`, which is a safe
resting state — nothing outside that branch has changed. `done` means it landed.

The split is the point. Committing is recoverable; merging is what the rest of the repo
has to live with. Every commit carries `Aide-Task` and `Aide-Run` trailers, so months
later `git show` still says which task asked for the change and which run log explains it.

## Next

1. Intake pipeline: `inbox.md` → classify → **patch proposal** against specs → you accept or
   reject hunks → specs and roadmap regenerate. The human gate is the point: an agent that
   can silently edit a spec to match what it built makes the specs worthless.
2. Spec drift detection on task completion
3. Cross-project dashboard
4. Resume runs across a daemon restart — today a restart orphans anything in flight
5. SQLite, when run-history queries start to hurt
6. CodeMirror 6 read-only viewer
7. Git graph — last, most fun, least useful
