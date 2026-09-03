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
| The open conversation, and the turn streaming into it | `packages/web/src/panes/Conversation.tsx` |
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
| Activity across every project, reduced from the run logs | `packages/daemon/src/activity.ts` |
| That reduction drawn as a page | `packages/web/src/Dashboard.tsx` |
| What a run's shell may and may not do | `packages/daemon/src/policy.ts` |
| The checks that need no repository, and the shared tally | `packages/daemon/src/smoke-policy.ts`, `smoke-check.ts` |

Decisions already taken, which are not gaps to fill:

- **`pnpm smoke` is three files, and it is not split further on purpose.** What
  came out is the group that needs no repository — the shell policy, the plan
  rules, the browser-safety check, the restart decision — into `smoke-policy.ts`,
  with `smoke-check.ts` holding the one `check` and the one failure count so
  there is still a single tally and a single exit code. What did NOT come out is
  most of the file, and the reason is the thing to know before trying again: it
  drives ONE throwaway repository through a deliberate sequence — a checkpoint,
  a commit measured against it, a branch and a merge for the history view to
  draw — where each section is set up by the ones above it and several assert a
  NON-effect, that an operation left `git status` and the index byte-identical.
  Splitting those means a repository per file, which is slower and quietly tests
  something weaker: that the operations work alone, rather than that they
  compose. `smoke-policy.ts` is imported for its side effects, DYNAMICALLY and
  at the point in the file where its sections used to be written out, because a
  static import is hoisted and its output would print above `repo: <path>` — the
  run would still be correct and would read as though the sections had been
  shuffled. When changing any of this, the check that matters is that the
  assertion count does not move: it was 334, and every one of the 325 that
  predate this session still prints the same line.
- **`taskId` is gone from the wire and kept in the session reader, and that is
  not an inconsistency.** They were two different fields wearing one name. The
  wire one — `run.started.taskId`, `RunAgentOptions.taskId` — was a required
  string every producer set to `""` and no reader ever looked at, which is worse
  than absent: it reads as something a new call site ought to supply, and there
  is no right value. The other is derived from a session's cwd by `classify`, and
  it still means something, because `~/.claude/projects/` holds transcripts from
  when a task WAS a worktree and relabelling those as chats would be a lie about
  what happened. Nothing new can produce one. The 672 logs on this machine that
  still carry the old field read fine, because every reader takes the fields it
  wants off a parsed line rather than matching the shape whole — `pnpm smoke`
  pins that against a log in the old format, since a reader that refused them
  would not crash, it would report a machine with hundreds of runs as empty.
- **The chat list and the open chat are two files, and the near-identical money
  formatters across the web package are deliberate.** `Conversations.tsx` is the
  LIST, `Conversation.tsx` is the one you have open; they were one file of two
  thousand lines that shared nothing but an import block, twenty-two entries of
  which belonged to only one of them. They hold separate state, are addressed by
  different halves of the URL, and speak only through props `App.tsx` passes
  down. The formatters stayed with the list because that is who prints them.
  What looks like the obvious next tidy-up — one `money` for the package — is
  the one to leave alone: there are THREE and each is a different decision.
  `ui.tsx` gives a lone figure four places below a dollar, because on a single
  chat row $0.004 and $0.04 are different facts. `Dashboard.tsx`'s `columnMoney`
  forces two, because in a column `$0.4367` beside `$47.60` puts the decimal
  points in different places and the eye can no longer compare magnitudes.
  `Conversations.tsx` floors to `<$0.01`, because rounding a real spend to
  `$0.00` says the work was free, which the brief forbids of any cost figure.
  Merging them would silently undo whichever two lost.
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
- **The dashboard is a page, not a fifth pane, and it counts rather than opens.**
  `#/activity`, reached from `stats` on the projects header. Every pane is scoped
  to ONE project; "where did the week go across everything" is the one question
  none of them can answer, and it is asked when you are between pieces of work
  rather than inside one — so it takes the whole window for thirty seconds and
  hands it back, instead of costing every pane a fifth of its width forever. It
  REPLACES the panes rather than covering them, because they poll and a remote
  `gitPending` is an ssh connection; nothing is lost by unmounting them, since a
  run belongs to the daemon and the URL keeps the project and the open chat, so
  `close` returns you exactly where you were. It is not the browser ruled out
  above wearing a new hat: every row is a COUNT, and the only thing clickable is
  a project, which navigates to its panes. Nothing opens a commit, a file or a
  diff. It is derived on read by `activity.ts` from the run logs and stored
  nowhere, so no figure on it can drift from its source; the arithmetic is pure
  in `reduceActivity` and `pnpm smoke` asserts the property that would otherwise
  fail silently — every breakdown summing to the headline above it. Two numbers
  on it are deliberately not the obvious computation: the day bucket is LOCAL
  (`toISOString` files a 1am turn under the day before, and only for turns taken
  late at night), and `unattributed` counts only logs in the current event
  vocabulary — logs-on-disk minus logs-indexed reports 294 of 667 on this
  machine, of which 266 are `run.queued` residue from the task queue that no
  longer exists.
- **The dashboard reads the log BODIES, and that is what makes it worth having.**
  The first version reduced 388 timestamped runs to nine daily bars, four totals
  and two lists, and it was correct and nearly useless — every figure on it was
  a sum, so nothing on it could surprise you. The logs already held far more:
  `verify.result` carries each commit check's command, outcome and duration
  (`pnpm exec tsc -b`, 0 passed and 2 failed, is the broken gate from the
  `verify:` story still visible in the log; `engine-check.mts` takes 334s against
  typecheck's 1.5s), `run.finished.status` distinguishes cancelled from failed
  (206 of 656 lifetime turns were CANCELLED, which one "388 turns" tile cannot
  say), and `openedAt` was always a full timestamp — reducing it to a day threw
  away the punchcard, where this machine's five busiest hours are all weekend
  and four of them between 1am and 5am. The lesson generalises past this page:
  the shape of the reduction decides the ceiling of the UI, so ask what the
  source can support before picking what to display. `bodyOfRun` gathers all of
  it in ONE pass per log — a second traversal of 27MB to count commits after
  counting tools would double the only expensive thing here — behind the same
  size+mtime cache `spend.ts` uses, so 667 logs are read once and then free
  (737ms cold, 27ms warm).
- **The punchcard's ramp is by quantile, and its steps are lifted off the empty
  tint.** Both are the difference between a heatmap and a decoration. Linear on
  the peak is the obvious version: with one hour at 27 turns and most occupied
  cells at 1–2, it puts ~90% of them on step 1 and the map becomes two colours.
  And the first ramp began at #173a5e, 1.5× the empty cell's luminance, which
  drew most of the data as very nearly background — a sequential ramp has to
  spend its range where the values ARE, which for a punchcard is the bottom.
  Weekday is shifted to Monday-first in `reduceActivity` rather than in the
  renderer, because an off-by-one there mislabels every row and reads as a data
  bug.
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
- **A remote project's conversations are read by asking the far side.** The SDK's
  `listSessions`/`getSessionMessages` take a directory and read it LOCALLY, so
  they cannot be pointed at another machine: for a remote project the daemon
  looked in this machine's `~/.claude/projects/` for a Linux root, found no
  directory at all, and answered with an empty list — the UI drew a project with
  no conversations while a 1.2MB transcript sat intact on the far side. Nothing
  lost, nothing findable, and no error anywhere. `aide-agent --sessions <root>`
  and `--session <root> <id>` run those same SDK calls where the files are and
  print one JSON document. Deliberately one-shot subcommands rather than
  `ToWorker` messages: that protocol describes a live conversation holding the
  project's lock, and this is a stateless read that is polled and must work when
  no agent is running. Shaped like `gitBatch` and `readRepoFile` instead. In
  query mode `stdio.ts` skips the `ready` line and the stdin wiring — stdout is
  one document there, so a framing line in front of it makes the answer
  unparseable, and an attached stdin would leave a polled ssh call that never
  returns. Costs a connection: ~6.5s to list, ~9.8s to open a 1.2MB transcript.
- **That read is cached, and the invalidation is the load-bearing half.** Only
  the REMOTE one — the local SDK call is a directory read in single-digit
  milliseconds, so a cache in front of it would buy nothing and add a staleness
  bug. Measured against `tg`: a list goes 5470ms → 0ms, a 336-event transcript
  5156ms → 3ms. The 60s TTL is not what makes it correct; `forgetConversations`
  is. Everything that CHANGES a conversation goes through this daemon, so
  `ChatLane`'s `release()` — the one place a turn lets go of a project — drops
  the entry, and the next read is fresh. That matters because the browser
  refetches the chat list precisely BECAUSE a turn finished (it watches the
  holder go null), so a plain TTL would serve a stale row at the one moment
  somebody is looking for a new one. The TTL only covers the writer aide cannot
  see: somebody running `claude` in a terminal on the far machine. The PROMISE is
  cached rather than the result, so two requests three seconds apart share one
  ssh connection instead of opening a second — verified, two concurrent cold
  reads cost one connection — and a rejection is evicted rather than replayed for
  a minute. Status and spend are attached OUTSIDE the cached read, from the board
  and the event logs, so ticking a chat off is correct even on a cache hit.
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
- **The retry re-reads the GATE as well as the tree.** `verify:` lives in
  `.aide/project.md`, which is a file in the tree the commit is about to take, so
  the one repair attempt can rewrite the checks as well as the code — and when
  the checks are what is broken, that is the only fix there is. `verify` is
  therefore a reader on `CommitWorkingTreeOptions`, called on every pass, not an
  array read once when the run started. Held as an array it produced a gate no
  attempt could clear: on a project whose `verify:` called `pnpm` on a host with
  no pnpm, the agent correctly rewrote the block to call `node_modules/.bin`
  directly and the retry ran `pnpm exec tsc -b` a second time anyway, refusing
  the commit twice over a fix that was already on disk. Same shape as the wedge
  in the brief — two readings of one tree that have to move together. `pnpm
  smoke` counts how many times the reader is CALLED, which is the only way to
  tell a re-read from a frozen copy.
- **Two modes: Plan and Auto.** Manual and Edit-automatically are gone. Nothing
  aide runs may need a human mid-turn, because the fix above is a turn nobody
  typed. Re-adding a mode that asks means re-opening that.
- **`AskUserQuestion` is refused, in both modes.** It is the one tool that turns
  a turn into a mid-run permission prompt, which is the thing the rule above
  exists to prevent — and the enforcement was missing, so it was reachable the
  whole time. `canUseTool` routes every unresolved call in a CHAT run to the
  browser, and this tool is never on the allowlist, so it always became a
  blocking question. Watched doing it: a turn on Auto sat on one for 937s asking
  which chess variant to migrate, holding a remote project, `blocked: true` in
  the daemon's own state, with two buttons whose only honest answer was to kill
  the run. `ExitPlanMode` is the exception because it ENDS the turn rather than
  parking it — nothing is held waiting on the click. Two layers, deliberately:
  `disallowedTools` takes it out of the schema so it is never called, and
  `canUseTool` denies it anyway as the backstop, with a refusal that names the
  alternative — put the options in the reply and end the turn, and the human
  answers in the next message.
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

**Do not commit. Pushing is fine.** Your changes are reviewed as a diff and
committed by a human from the UI, so `git commit` is in `HUMAN_ONLY_COMMANDS` and
reaching for it is a sign something has been misunderstood — there is no
invocation that gets through, so a denial is the answer rather than a puzzle.
That refusal says so in its own words, separately from the `deniedBash` one,
because for a while they shared a sentence: a denied agent was told the command
"never exits, or spends money", read that as a runaway-command guard rather than
a rule about the review, and tried four different forms — a heredoc, a message
file, a plain invocation — before giving up.

**Commit and push are two buttons, and a checkbox chains them.** `commit` is the
gate. `push` is its own press on the clean tree — because the common case for it
is a commit that already happened: the box was not ticked, the push failed, or
the work was committed before there was a remote. A button that could only push
as part of committing could clear none of those. The checkbox ("and push") is
read at the moment of the press and stored nowhere, so it is a habit rather than
a setting — one that silently pushed months later would be a setting wearing a
checkbox's clothes. A chained push runs INSIDE the commit's run, after
`commit.landed`, and its failure does not undo the commit: a push can fail for
reasons that have nothing to do with the work, and reporting a commit that landed
as one that failed is worse than saying "committed, but the push failed". The
button reads `ahead` off `GitPending`, which rides in that call's existing batch
so it costs no extra round trip; `ahead: null` means no upstream and shows
`publish branch`, which is why null is not collapsed to 0 — that would disable the
button on the one branch that has never been pushed. Never `--force`: a push that
needs it is a history rewrite, and the checkpoint refs are local so they cannot
recover somebody else's clone.

`git push` is deliberately NOT human-only, and the distinction is the point.
Push is DOWNSTREAM of the gate: nothing is pushable until it has been committed,
and committing is the human pressing the button, so a run that can push is only
ever moving commits somebody has already read and approved. Blocking it
protected no review that had not already happened — it stranded approved work on
the machine that made it, which is exactly what it did to a remote project on
`tg`, where a reviewed commit could not reach origin and the deploy ran from a
local checkout that no longer matched it. A gate placed after the decision it
guards is not a gate, it is a dead end. `pnpm smoke` asserts push is allowed on
both paths, that commit is not, that the two refusal reasons differ, and that the
commit refusal names push as the thing that IS allowed.

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
