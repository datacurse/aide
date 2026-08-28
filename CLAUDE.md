# Working in aide

A pnpm/TypeScript monorepo. You are working in the repository's **own checkout**,
not a scratch copy of it — see the last section, which is the important one.

- **`packages/protocol`** — types shared by both ends. No schema library on
  purpose: both ends compile from the same definitions, so the compiler guards
  the wire. The only runtime validation is on hand-edited files (`project.md`),
  where a typo must fail loudly.
- **`packages/daemon`** — Fastify HTTP + WebSocket, project registry, the chat
  lane and its single-run lock, checkpoints, an append-only NDJSON event log per
  run. Long-lived.
- **`packages/web`** — React + Vite + Tailwind 4, styled as VS Code Dark Modern.

## What the app does, and where it is

Four panes, left to right: projects, chats, the open conversation, and what is
left to commit. There is no other surface — no board, no tabs, no history view,
no editor.

A chat is the unit of everything. One you have written and not sent is the
backlog; one with a turn in flight is the work; one you have ticked off is the
record. They are all rows in the same list, in that order of urgency.

| What | Where |
| --- | --- |
| The four panes and the polling loop | `packages/web/src/App.tsx` |
| The chat list, the capture box, the done tick | `packages/web/src/panes/Conversations.tsx` |
| Unstarted chats, drafts, pasted images (IndexedDB) | `packages/web/src/drafts.ts` |
| An event log rendered as a conversation | `packages/web/src/panes/Transcript.tsx` |
| One agent per project, the lock, warm sessions | `packages/daemon/src/chat.ts` |
| The SDK call, the system prompt, permissions | `packages/daemon/src/agent.ts` |
| Snapshots and turn boundaries under `refs/aide/` | `packages/daemon/src/checkpoint.ts` |
| What a conversation changed, and what a commit stages | `packages/daemon/src/changes.ts` |
| The commit run: read the diff, write a message, commit | `packages/daemon/src/review.ts` |
| Which chats are ticked off (`~/.aide/board.json`) | `packages/daemon/src/board.ts` |
| What is left of the plan, and when it resets | `packages/daemon/src/usage.ts` |
| What a run's shell may and may not do | `packages/daemon/src/policy.ts` |

Decisions already taken, which are not gaps to fill:

- **No worktrees and no branches.** Every run works the project's own checkout,
  one at a time. See the brief for why.
- **No merge, no `land`.** Recoverability is the checkpoint, not an unmerged
  branch.
- **No repository browser** — no history list, no commit view, no graph. A diff
  is read in the conversation that produced it.
- **No capability file.** There was a model-maintained `.aide/spec.md`; it cost
  more wall-clock than the rest of a commit, nothing read it, and it corrupted
  itself. What the project does is discoverable by reading the code, and what it
  refuses to do is in `.aide/project.md`.
- **No backlog file.** `.aide/todos.md` is gone too — an unsent chat IS the row,
  held in the browser, because nothing about it has happened yet.

## Commands

```
CI=true pnpm typecheck     # all three packages
CI=true pnpm smoke         # git plumbing + shell policy, against a throwaway repo
CI=true pnpm smoke:queue   # chat lane, lock and checkpoints, with a stub worker
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
// `diff --cached <checkpoint>` against a scratch index, not the obvious
// `git diff <checkpoint>`. The obvious form is wrong in both directions and
// quietly so: it reports a pre-existing untracked file as DELETED, and omits
// the file the run created.
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

## Things to know about where you are running

**You are in the project's own checkout.** There is no worktree and no branch of
your own. The files around you include whatever the human had uncommitted when
your run started, and the dev server they are watching is serving this very tree.
So: change what you came to change, and leave everything else exactly as you
found it. A stray edit is not isolated from anyone.

aide snapshots the tree before each run (`refs/aide/checkpoints/<session>`), so a
bad run is recoverable — but recovery is a human typing a restore command over
their own work, which is not free. It is a safety net, not a licence.

**Do not commit.** Your changes are reviewed as a diff and committed by a human
from the UI. `git commit` is not in the shell allowlist, and reaching for it is a
sign something has been misunderstood.

Everything under `.aide/` is fair game, `project.md` included — a change to what
the project refuses to be should land in the same commit as the code. There is no
carve-out any more: a run commits exactly what it changed, and there is no file a
human can watch change in the rail and never be allowed to commit.

Do not create `.claude/settings.json`. Its `permissions.allow` entries widen a
run's allowlist before aide's own policy sees the call, so aide's repo
deliberately has none — which makes that file appearing in a diff a red flag
rather than a detail.
