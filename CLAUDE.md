# Working in aide

A pnpm/TypeScript monorepo. You are probably reading this inside a git worktree
at `.aide/worktrees/task-NNNN`, checked out from a task branch.

- **`packages/protocol`** — types shared by both ends. No schema library on
  purpose: both ends compile from the same definitions, so the compiler guards
  the wire. The only runtime validation is on hand-edited files (task
  frontmatter, `project.md`), where a typo must fail loudly.
- **`packages/daemon`** — Fastify HTTP + WebSocket, project registry, task queue,
  worker supervision, an append-only NDJSON event log per run. Long-lived.
- **`packages/web`** — React + Vite + Tailwind 4, styled as VS Code Dark Modern.

## Commands

```
CI=true pnpm typecheck     # all three packages
CI=true pnpm smoke         # git plumbing + shell policy, against a throwaway repo
CI=true pnpm smoke:queue   # supervisor semantics, with a stub worker
CI=true pnpm build         # the web bundle
```

`CI=true` is set for you in the run environment; it is written here because pnpm
otherwise stops to ask before purging a modules directory and nobody is there to
answer.

**Never run `pnpm dev`, `pnpm daemon` or `pnpm web`.** They start servers and
never exit, so the run burns its entire budget waiting. **Never run `pnpm probe`**
— it spends real money on a model call. All four are refused by the shell policy
anyway; this is so you do not waste a turn finding out.

One command per Bash call. No pipes, no `&&`, no `$( )`. Use
`pnpm --filter @aide/daemon <script>` rather than `cd packages/daemon && pnpm <script>`.

## Conventions

Comments explain **why**, not what — and the best ones name the bug that would
otherwise happen. Match the density of the file you are editing. For example:

```ts
// The emptiness probe carries the pathspec too, and that is not symmetry for
// its own sake: without it, a run that touched only excluded paths passes the
// "is there anything to commit" check and then `git commit` fails with
// "nothing added to commit".
```

Do not add a dependency without being asked. `packages/protocol` has no schema
library, `packages/daemon` has four dependencies, and that is deliberate.

TypeScript is strict, with `noUncheckedIndexedAccess` and `verbatimModuleSyntax`
— type-only imports need `import type`.

## Windows

Development happens on Windows. Every `spawn`/`execFile` needs `windowsHide: true`.
`child.kill("SIGINT")` maps to `TerminateProcess`, so it is not a graceful stop —
use the SDK's `interrupt()` for runs and `taskkill /T /F` (see `proc.ts`) for
trees. Paths from git come back with forward slashes; filesystem paths do not.

## Things to know about this worktree

`.aide/tasks/` here is a **stale snapshot** from the branch point. Your task
arrives in this conversation, not from that directory — and `.aide/tasks/` and
`.aide/journal/` are excluded from what you can stage, because the daemon is
writing the live copies in the main checkout while you work.

Do not create `.claude/settings.json`. Its `permissions.allow` entries widen a
run's allowlist before aide's own policy sees the call, so aide's repo
deliberately has none — which makes that file appearing in a diff a red flag
rather than a detail.
