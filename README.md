# aide

A bird's-eye view across your projects, with Claude working tasks in each one.

The file tree, the editor, and the git graph are not the product — those are solved,
buyable components. The product is the **project state machine**: inbox → spec → roadmap →
task → agent → verified diff. This repo is slice 1 of that: the runner.

**What works today.** Add a git repo, write a task, watch Opus work it in an isolated
worktree, read the diff. Interrupt it mid-run. Two run concurrently, the rest queue.

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
pnpm dev       # daemon on :4317, web on :5173
```

Open http://localhost:5173, add a repo by absolute path, write a task, run it.

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
  Long-lived, so runs continue with the browser closed. `src/agent.ts` is the only file
  that imports the Agent SDK.
- **`packages/web`** — three panes: projects, tasks, live run.

State lives in files, not a database:

| Where | What |
| --- | --- |
| `~/.aide/registry.json` | the projects you have added |
| `~/.aide/runs/<id>.ndjson` | append-only event log, one JSON object per line |
| `<project>/.aide/` | tasks, specs, journal — git-tracked, human-readable, portable |

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
  mode starts in Manual on every plan, so an allowlist alone is not a baseline. Compound
  commands are checked whole: `git branch -a; git push origin main` is denied.
- **Cost numbers are estimates.** `total_cost_usd` comes from a price table bundled into the
  SDK at build time. Good for a dashboard, never for billing. Read totals from
  `modelUsage`, which includes subagent spend; `usage` excludes it.

## Next

1. Journal + Sonnet-written commit messages
2. Intake pipeline: `inbox.md` → classify → **patch proposal** against specs → you accept or
   reject hunks → specs and roadmap regenerate. The human gate is the point: an agent that
   can silently edit a spec to match what it built makes the specs worthless.
3. Spec drift detection on task completion
4. Cross-project dashboard
5. SQLite, when run-history queries start to hurt
6. CodeMirror 6 read-only viewer
7. Git graph — last, most fun, least useful
