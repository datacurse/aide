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
| What a parked chat is called before it has run | `packages/web/src/naming.ts` |
| An event log rendered as a conversation | `packages/web/src/panes/Transcript.tsx` |
| What is left to commit, and the two readings under it | `packages/web/src/panes/Pending.tsx` |
| The project's files, one directory at a time | `packages/web/src/panes/Files.tsx` |
| What kind of file a name is, and its colour | `packages/web/src/filetypes.ts` |
| Where the graph's lines go, and the SVG that draws them | `packages/web/src/graph.ts`, `packages/web/src/GitGraph.tsx` |
| Branch, history and lanes, read off the repo | `packages/daemon/src/repo.ts` |
| Which machine a git call lands on, and batching them | `packages/daemon/src/git.ts` |
| The folder dialog behind `add`, and why it is the daemon's | `packages/daemon/src/picker.ts` |
| The machines in `~/.aide/ssh_config`, and walking one | `packages/protocol/src/ssh.ts`, `packages/daemon/src/ssh.ts` |
| One agent per project, the lock, warm sessions, a turn run inside a commit | `packages/daemon/src/chat.ts` |
| Where a run's agent executes: a fork here, or `aide-agent` over ssh | `packages/daemon/src/runner.ts` |
| The agent loop itself, with no opinion about its transport | `packages/daemon/src/worker/loop.ts` |
| That loop bound to IPC, and to a pipe | `packages/daemon/src/worker/main.ts`, `worker/stdio.ts` |
| Putting `aide-agent` on a machine — `pnpm deploy-agent <host>` | `packages/daemon/src/deploy.ts` |
| The SDK call, the system prompt, permissions | `packages/daemon/src/agent.ts` |
| Snapshots and turn boundaries under `refs/aide/` | `packages/daemon/src/checkpoint.ts` |
| What is uncommitted, what a conversation changed | `packages/daemon/src/changes.ts` |
| The commit run: check, fix once, write a message, commit | `packages/daemon/src/review.ts` |
| Which chats are ticked off (`~/.aide/board.json`) | `packages/daemon/src/board.ts` |
| What is left of the plan, and when it resets | `packages/daemon/src/usage.ts` |
| What a run's shell may and may not do | `packages/daemon/src/policy.ts` |

Decisions already taken, which are not gaps to fill:

- **No worktrees and no branches.** Every run works the project's own checkout,
  one at a time. See the brief for why.
- **No merge, no `land`.** Recoverability is the checkpoint, not an unmerged
  branch.
- **A history list, but no repository browser.** The uncommitted rail's lower
  half draws the last thirty commits, the graph beside them and where HEAD is
  standing, because nothing on screen said which commit was the last one. No row
  in it opens anything: no commit view, no file tree of an old commit, no diff of
  a change that already landed. A diff is read in the conversation that produced
  it.
- **The rail's lower half has two readings, and you pick one.** `history` and
  `files`, tabbed, sharing the space rather than stacking — they answer the same
  kind of question, orientation, and a rail split three ways gives each too few
  rows to read. What is UNCOMMITTED stays fixed above both, because it decides
  whether you may start another chat and must not be a click away. The tree is
  not the browser ruled out above: it draws the working tree as it is NOW, the
  one every run edits and the button above it commits, rather than the tree of
  some past commit next to a diff read outside the conversation that made it.
  Nothing in it opens a file — that would be an editor, and the brief takes
  reading code in scope while putting replacing the editor out of it.
- **The tree is read through git, one directory per request.** `git ls-tree HEAD
  <dir>/` plus a `status`, batched into one round trip by `gitBatch`, so
  `.gitignore` is honoured without aide parsing it (no `node_modules`, ever) and
  a project on another machine works with no code of its own. The trailing slash
  is load-bearing: `ls-tree HEAD src` answers with the directory `src` itself, so
  without it every folder opens to show only itself. One level at a time is the
  design rather than a limit — fetching the whole tree reads every path in the
  repository to draw the twenty rows on screen, down a connection that costs
  1.4s. Nothing polls it; re-opening a folder is the refresh. `buildTree` is pure
  and `pnpm smoke` covers what fails quietly there: a prefix compared without its
  slash putting `src2/`'s files under `src`, a deleted file left as a row that
  opens nothing, a rename showing under both names, and a collapsed folder that
  fails to mark a change three levels below it.
- **File icons are drawn, not installed, and there are eight of them.** A pack
  (Seti, Material, vscode-icons) is a few thousand SVGs plus a font or sprite
  sheet, which is the trade `icons.tsx` already refused for Phosphor — so these
  are Phosphor paths copied verbatim into that same file, and the cost is the
  eight shapes actually used. Eight rather than one per language because of what
  survives 12px in a 16rem column: a pack spends thousands of glyphs separating
  TypeScript from JavaScript from CoffeeScript, and at that size they are three
  blue-ish smudges told apart by position. What the eye resolves is the CLASS —
  code, config, prose, picture, package, stylesheet, database, shell — so there
  is one distinguishable icon per answer and colour carries the language. The
  colours are the syntax palette already in `index.css`, so nothing is a new
  language to learn: TypeScript takes the blue VS Code gives types, JavaScript
  the yellow it gives functions. The icon box is 30px because a folder row
  spends caret(12) + gap(6) + icon(12) before its name; change either and file
  and folder names stop landing on the same x. A malformed path renders as
  nothing in the right colour and the right box — indistinguishable from a blank
  column — so `d` attributes are worth checking rather than eyeballing.
- **A remote tree prefetches one level down; a local one does not.** Measured
  against `tg`: a bare `ssh echo hi` is 1.44s, one directory is 1.52s, and all
  EIGHT of that repo's top-level directories in the same connection is 1.55s for
  3.9KB. The cost is the handshake, not the reading — Windows OpenSSH cannot
  multiplex — so `tree()` spends ~110ms buying every first expand instead of
  1.4s each, and `GitTree.children` carries them. It stops at one level because
  two is most of the repository fetched to draw rows nobody asked for, which is
  the whole-tree read this design exists to avoid. Locally it is skipped
  entirely: a read is ~30ms, so the same prefetch would be an `ls-tree` per
  visible directory bought on the chance somebody expands one. `pnpm smoke` pins
  the local half at zero, because an asymmetry nothing asserts is one that
  quietly becomes symmetric.
- **A commit's number counts the branch, not the page.** `GitLog.numbers` is how
  far along the first-parent line each commit is — the first is 1, HEAD's is how
  many there are — so it means the same thing tomorrow. Numbering rows 1..30 from
  the top of the page is the obvious cheap version and is wrong: it renumbers
  every commit in the project every time you make one.
- **The lane talks to a `Runner`, not to a child process.** `chat.ts` never
  called the SDK — it forks `worker/main.ts` and exchanges `ToWorker` /
  `FromWorker` messages with it, and those are plain objects through one
  `process.send`, with no handles. So the protocol was already serializable and
  the only thing missing was permission to put something else behind it.
  `runner.ts` names that seam: `send`, `onMessage`, `onError`, `onExit`, `kill`.
  `LocalRunner` is the same fork doing the same thing, and a remote project
  would speak the same messages over `ssh <host> aide-agent --stdio`. The
  interface is the small surface `chat.ts` actually uses rather than a
  `ChildProcess` with the unused parts left in, because every member has to be
  one a remote implementation can honestly provide — `kill()` and not a pid,
  since `killTree` is `taskkill` against a LOCAL process id. `pnpm smoke`
  asserts a non-process object still satisfies it, which is the check that
  fails the moment the seam closes again. See `.aide/specs/0003`.
- **One agent loop, two transports.** `worker/loop.ts` holds it and knows
  nothing about how it is spoken to; `worker/main.ts` binds it to `process.send`
  and `worker/stdio.ts` binds it to newline-framed JSON on a pipe. Two
  implementations would drift, and the drift would surface as a remote
  conversation rendering differently from a local one. `stdio.ts` reassigns
  `console.log` to stderr, because stdout IS the protocol and one stray log
  corrupts the stream — silently, as prose in the middle of a JSON line.
- **`pnpm deploy-agent <host>` ships it, and `npm install` finishes the job.**
  Not a bundle: the SDK resolves a native binary through optional dependencies,
  so the far side installs regardless, and bundling would mean adding a bundler
  to a package with four dependencies. The protocol package is placed under
  `node_modules/` AFTER that install, because npm prunes what it does not know
  about. A remote agent reports `protocol` on `ready` and `SshRunner` refuses a
  mismatch before the first turn — verified end to end against a real host,
  including a model turn that cost $0.08.
- **A project can live on another machine.** `~/.aide/ssh_config` is aide's own
  file in OpenSSH's format — not `~/.ssh/config`, which aide never writes and
  only partly understands (no `Match`, no `ProxyJump`, no `Include`, no
  `%`-tokens; a picker that silently disagreed with `ssh` would be worse than a
  smaller one that says so). The `ssh` button lists those machines, walks them,
  marks which directories are repositories, and adds one: `Project.host` names
  the machine and `root` is a path on IT, not here.
- **git goes where the files are, decided by `RepoRef`.** Every git call already
  took the root as its first argument, so making THAT carry the host routes
  `repo.ts`, `changes.ts`, `checkpoint.ts` and the verify commands to the right
  machine without any of them knowing there is more than one. A bare string
  still compiles and still means "here", which is what kept the local path — and
  `pnpm smoke` — untouched. `repoOf(project)` is what callers pass; passing
  `project.root` for a remote project is the mistake that produced "cannot
  change to '/root/code/…'" in the rail.
- **A remote git call has a timeout; a local one does not.** Local git either
  answers or fails. A network can do neither, and `execFile` then waits forever
  — which wedged `games42_mono` for an hour: a commit hung on its first git call
  (Windows git against a Linux path, before `RepoRef` existed), held the
  project's lock, and could not be cleared from the UI because `interrupt` sets
  a flag the stuck `await` never reaches. 90s, and the message names the host
  and the subcommand rather than surfacing as an empty string. The lesson is the
  brief's: a gate whose precondition can hang has no release.
- **A remote read is batched, because a connection costs 1.4s.** Windows OpenSSH
  cannot multiplex (no Unix sockets), so the cost is per CONNECTION and the only
  fix is fewer of them. `gitBatch` runs several independent reads down one ssh
  call: `overview` went 9.8s → 1.75s against `tg`, and `pending` — which the
  always-visible rail polls — halved. The delimiter uses `printf %s` and not
  `echo`, because `git status -z` ends in a NUL with no newline: a separator
  that contributes a byte of its own splits that output one byte early, and the
  rail's file list comes back mangled. `pnpm smoke` pins it.
- **Connections are also a budget, not just a latency.** The 1.4s above is the
  half of this that was measured first; the other half is that there is a
  CEILING. sshd refuses new connections past `MaxStartups` (10 on `tg`, the
  default), and this machine's spawn table gives out around the same point —
  measured, 12 concurrent `ssh` calls already lose one to
  `kex_exchange_identification: read: Software caused connection abort`, and 30
  lose two thirds to that plus `spawn ENOMEM`. So a remote read is batched to be
  fast AND to stay under a limit that fails as a refusal rather than a slowdown.
  Two things came of hitting it: `treeChanges` spent EIGHT serial connections
  (`rev-parse`, `--git-dir`, `cp`, `add -A`, three reads, `rm`) before the commit
  gate had read anything — now three, with `prepareRemoteIndex` as one script and
  the reads batched through `gitBatch`'s `env` against the scratch index — and
  `App.tsx`'s 1500ms poll fired on the clock whether or not the last beat
  answered, which against a ~1.75s remote `pending` meant unbounded overlap. It
  now skips a beat rather than stacking one. The symptom was a commit dying on
  `tg did not answer \`git diff\` within 90s` while the rail beside it, polling
  the same repo, drew it as perfectly reachable: the commit's connections were
  the ones being dropped. A failure with nothing on either stream is that case,
  so `git()` names it `could not reach <host>` rather than surfacing execFile's
  message, which is the whole ssh command line.
- **A path handed to git must exist on the machine that RUNS git.** The trap
  `withTempIndex` documents for `GIT_INDEX_FILE` is not special to the index:
  `commitRun` wrote the message with `writeFile(join(tmpdir(), …))` and passed it
  to `git commit -F`, which for a remote project writes the file HERE and reads
  it THERE — `could not read log file 'C:\Users\…\Temp\aide-commitmsg-…'`, after
  the diff had been read, the checks had run and the message had been paid for.
  `withMessageFile` puts it in `/tmp` on the far side. The content goes over
  STDIN (`cat > path`, via `spawn` — `execFile` cannot supply one) rather than
  interpolated into the command, because the message is written by a MODEL: on a
  command line a subject containing `$(…)` or a backtick stops being prose and
  becomes something the remote shell evaluates. `pnpm smoke` commits a message
  full of `$(…)`, backticks, quotes and backslashes and asserts they survive as
  bytes; the remote half shares the same helper, so it cannot diverge without
  that failing.
- **`.aide/project.md` is read from the machine that HOLDS it.** `readProjectDoc`
  took a path and used `node:fs`, so for a remote project it read THIS machine's
  disk for a path that only exists on the far one — missed every time, and
  returned the empty doc. Both consequences were silent, because a missing brief
  is a legal answer: the agent ran with no project context, and the commit gate
  read no `verify:` commands and skipped every check. It takes a `RepoRef` now
  and reads through `readRepoFile`, which is `cat` over ssh for a remote ref.
  Measured against `tg`: 0 chars before, 407 after. `pnpm smoke` pins the local
  read, that a missing file is absent rather than an error, and that a remote
  path is POSIX — `join` on Windows would answer with backslashes, which a POSIX
  shell reads as escapes.
- **A project's id hashes the host as well as the path.** `/root/code/app`
  exists on more than one machine, and without the host those collide into a
  single registry entry — you would open one and see the other's conversations.
  A LOCAL project hashes exactly as it always did, so every id already in
  `registry.json` keeps its value and its board links: `pnpm smoke` asserts that
  local form byte-for-byte, because changing it would silently rename every
  project on disk. A remote root is not `resolve()`d or lower-cased either —
  `resolve("/root")` on Windows is `C:\root`, and POSIX paths are case-sensitive.
- **Adding a remote project does not require an agent on it.** The add checks
  it is a repository and scaffolds `.aide/`, both over ssh; it does not check
  for `aide-agent`. A machine can be browsed and registered before it has been
  deployed to, and the refusal for a missing or mismatched agent comes from
  `SshRunner` at the first turn, naming `pnpm deploy-agent <host>`. Refusing the
  add instead would invert the order anybody works in.
- **No capability file.** There was a model-maintained `.aide/spec.md`; it cost
  more wall-clock than the rest of a commit, nothing read it, and it corrupted
  itself. What the project does is discoverable by reading the code, and what it
  refuses to do is in `.aide/project.md`.
- **No backlog file.** `.aide/todos.md` is gone too — an unsent chat IS the row,
  held in the browser, because nothing about it has happened yet.
- **A parked chat is named when it is parked, not when it runs.** The SDK names
  a session a second or two into its first turn, so everything aide has spent
  money on has a name and the backlog — the rows you actually have to find again
  — showed the first line of whatever you typed. `naming.ts` asks the daemon
  (`POST /api/chat-name`: one helper-model call, no tools, no lock, so parking an
  idea never waits on a run) for a few words, and the row shows them for exactly
  as long as the text they were written from is still what is in the box. The
  chat you have OPEN is never named: a chat you are typing into is one you are
  about to send, and the SDK will name that one for free. That exemption is the
  whole cost control — without it this is a model call per composing pause.
- **A commit takes the working tree, not a conversation's diff.** `POST
  /api/projects/:id/commit`; a session id on it is attribution only. This is not
  a shortcut around the review — it is what makes the rail's list, which blocks
  the next chat, a list you can always clear. Narrowing it back to one chat's
  paths re-opens the wedge in the brief.
- **A failed check gets one automatic fix, and one only.** The commit hands the
  failure to the conversation it is attributed to, waits for the turn, re-reads
  the tree and checks again; a second failure stops and asks. That turn runs
  INSIDE the commit's own run — `ChatLane.turnUnderHold` — so it appears in the
  run you are watching and the project's lock is never let go between the
  failure and the retry. A commit pressed with no chat open gets no attempt.
- **Two modes: Plan and Auto.** Manual and Edit-automatically are gone. Nothing
  aide runs may need a human mid-turn, because the fix above is a turn nobody
  typed. Re-adding a mode that asks means re-opening that.
- **A tool row is drawn when the call opens, not when its event arrives.**
  `tool.start` is read off the COMPLETED assistant message, so a call the model
  announces two sentences into a reply reaches the log only once it has stopped
  writing that reply — by which time the tool has usually run and returned. What
  that looked like was a wait with nothing moving in it, then a finished call you
  never saw start. So `content_block_start` for a `tool_use` block becomes a
  `tool` delta (`RunDelta`), the browser draws a running row from it, and
  `useRunStream` retires that row when its own `tool.start` lands — matched on
  `toolUseId`, one at a time, because one message can open several calls and
  their events arrive together at the end of it. The delta carries the name and
  the id and NOT the input: arguments stream as `input_json_delta` fragments and
  half-parsed JSON is not a filename, so the row names the tool, counts, and
  fills in what it touched a moment later. Both copies share the key
  `tool:<runId>:<toolUseId>` — the one row here not keyed by seq — and the event
  keeps the delta's stamp, or the counter restarts from zero at the handover
  having already shown twenty seconds. It is also the only delta that is not the
  early copy of something: losing it loses the row until the event, which is the
  behaviour this replaced.
- **Thinking is a toggle, and the log remembers which way it was.** The struck-
  through word beside the mode picker sends the turn with extended thinking off.
  It goes through `setMaxThinkingTokens` — 0 for off, null for back to the
  session default — rather than `query`'s `thinking` option, because the option
  is fixed for the life of the query: a warm session started with it disabled
  could never be talked back out of it, so the toggle would work on a
  conversation's first message and do nothing on every one after. The obvious
  third route is the one that was tried first, and is why this is written down:
  `alwaysThinkingEnabled` in the flag-settings layer is read nowhere that
  matters. The CLI's `apply_flag_settings` handler takes `effortLevel` and
  `ultracode` and drops the rest on the floor, and the spawn-time `settings`
  copy is only consulted as the fallback under `--thinking`, which `agent.ts`
  always sends. Both halves of the toggle were no-ops, and the turn logged
  itself "no thinking" and thought anyway. It is an experiment about speed
  against accuracy,
  which is why `user.message` carries `thinking: false` when it was off and
  nothing when it was on, and the profile marks the turns that did not think.
  Absent has to keep meaning "thought" — every log written before the toggle
  existed is that case. The one turn that never gets it is the commit gate's
  single repair attempt: nobody reads that one before it runs.
- **The page does not hot-update while a turn is in flight.** A run in this repo
  rewrites the modules the page is running, and a module Fast Refresh cannot
  swap in reloads the browser out from under the turn you are watching — taking
  the transcript with it, and landing in a document nobody has touched, where
  the browser will not let the finish make a sound. So `hotUpdate` in
  `packages/web/vite-daemon.ts` applies nothing while `busy.chats` is above
  zero, and hands the reload to `packages/web/src/reload.ts`, which takes it
  once the window has focus, the done alarm has been answered and nothing has
  been typed for half a minute. That last condition is not politeness: the alarm
  is silenced by any keydown, so without it the first character of your next
  prompt was the signal that released the reload which then ate the sentence.
  Drafts are flushed to IndexedDB and waited on before the page goes, because a
  `pagehide` transaction is not guaranteed to commit. Looking at the code you
  loaded with until the turn is over is the price, and it is the cheap half of
  the trade.

## Commands

```
CI=true pnpm typecheck     # all three packages
CI=true pnpm smoke         # git plumbing + shell policy, against a throwaway repo
CI=true pnpm smoke:queue   # chat lane, lock and checkpoints, with a stub worker
CI=true pnpm build         # the web bundle
pnpm deploy-agent <host>   # put aide-agent on a machine in ~/.aide/ssh_config
```

`deploy-agent` talks to another machine and is not part of the checks — it is
run by hand when the agent protocol or anything it ships has changed.

`CI=true` is set for you in the run environment; it is written here because pnpm
otherwise stops to ask before purging a modules directory and nobody is there to
answer.

**Never run `pnpm dev`, `pnpm daemon` or `pnpm web`.** They start servers and
never exit, so the run burns its entire budget waiting. **Never run `pnpm probe`**
— it spends real money on a model call. All four are refused by the shell policy
anyway; this is so you do not waste a turn finding out.

Run only the checks the change can break — `typecheck` for anything, `smoke` for
git plumbing, `smoke:queue` for the chat lane or the profile, `build` for web —
and when you do want all four, **send them as four Bash calls in one message**.
They are independent (each smoke builds its own throwaway repo; only `build`
writes into the tree), so that is one round trip and one wall clock rather than
four of each. Measured: 36s together against 95s plus four round trips apart.

The commit gate routes the same way, from `unless:` in `.aide/project.md`: a
check is skipped when every path in the commit is under something it declares
irrelevant. So a web-only commit runs `typecheck` and `build` and says on the
transcript why it skipped the other two. Skipped checks are shown, not omitted —
a gate that quietly shrinks is indistinguishable from one that broke.

One command per Bash *call* — no pipes into another command, no `&&`, no `$( )`.
That is not one call per message: independent calls belong in the same message.
Use `pnpm --filter @aide/daemon <script>` rather than
`cd packages/daemon && pnpm <script>`.

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

aide writes that same layer itself, in code, for one case: a chat on Auto gets
`Bash(*)` allowed and a short deny list, because the alternative is a model call
in front of every shell command. That lives in `fastBashSettings` in
`daemon/src/agent.ts`, where it is scoped to Auto and reviewable in a diff. The
rule above is unchanged: the *file* is still a red flag, precisely because the
one legitimate use of the layer already has a home.
