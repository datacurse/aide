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
| Every project at once, one chat each | `packages/web/src/wall/Wall.tsx`, `wall/Column.tsx` |
| Why a project cannot take a chat, a commit or a push | `packages/protocol/src/gates.ts` |
| Where you are, as a URL | `packages/protocol/src/location.ts` |
| The chat list, the capture box, the done tick | `packages/web/src/panes/Conversations.tsx` |
| The open conversation, and the turn streaming into it | `packages/web/src/panes/Conversation.tsx` |
| Unstarted chats, drafts, pasted images (IndexedDB) | `packages/web/src/drafts.ts` |
| What a parked chat is called before it has run | `packages/web/src/naming.ts` |
| The one turn aide knows how to ask for — `survey` | `packages/web/src/survey.ts` |
| The mode, the effort, the thinking toggle and the model picker | `packages/web/src/Composer.tsx` |
| Which models a turn can be sent to | `packages/protocol/src/session.ts` |
| An event log rendered as a conversation | `packages/web/src/panes/Transcript.tsx` |
| The block a turn writes about itself, and how it is read | `packages/protocol/src/summary.ts` |
| What a turn is doing right now, in one line | `packages/protocol/src/activity-line.ts` |
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

- **`survey` is a canned prompt, not a second gate.** `commit` is a gate: a
  precondition, a defined output, a refusal. This is a turn nobody typed — the
  same category as the commit gate's one repair attempt — so the brief already
  decides what it must be: Plan, which acts and asks once, rather than a mode
  that stops mid-turn for a permission nobody is there to give. It therefore adds
  no machinery: pressing it creates the same unstarted chat the ▶ sends, with
  `SURVEY_PROMPT` in it, and everything after the press is an ordinary
  conversation that holds the checkout, appears in the list and can be stopped.
  It SENDS on the press rather than parking the words for you to confirm, because
  a button you have already pressed asking you to press again is the "new" button
  that ignored you. Two things are deliberate and would be missed: the draft
  carries a `mode` because sending "don't write code yet" at a mode that acts is
  an instruction and its own contradiction, and it carries its own `title`
  because `naming.ts` would otherwise spend a model call asking what aide's own
  paragraph is about. `mergedMode` lives in `protocol/chatlist.ts` rather than in
  `drafts.ts` so `pnpm smoke:queue` can reach it — `drafts.ts` touches
  `window.indexedDB` and cannot be imported from Node.
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
  assertion count does not fall: `pnpm smoke` prints 777 `ok` lines as of
  2026-09-10, and a refactor that quietly drops some is the failure this number
  exists to catch.
  It fell once on purpose — the card view was removed and took ~30 of its own
  assertions with it, leaving the ten that cover `currentActivity`, which
  outlived it.
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
- **An attachment is any file, and only images ride the API.** The composer and
  the capture box take arbitrary files — clip button, drop, paste — and
  `isImageAttachment` in protocol is the one split, shared so the web's chips,
  the log event and the worker's routing cannot each draw the line differently.
  An image goes to the model as a vision block, exactly as before; everything
  else is written by the WORKER into a temp folder on the machine that runs the
  agent — for a remote project that is the far machine, the only place a path
  in the message can be true — and the message text names the paths
  (`attachment-files.ts`, whose note says the files are outside the repository
  so an agent does not spend a turn asking why the commit gate ignores them).
  The folder is deliberately not cleaned at turn end: a follow-up saying "now
  fix that file" still needs the path to answer to, and it is the OS's own tmp.
  The `user.message` event carries non-images under `files` WITH their bytes,
  because a failed turn's "put it back" rebuilds the composer's attachments
  from that event — restored without data, it would silently resend a message
  that promised two files with neither. `pnpm smoke` pins the two halves that
  fail quietly: a filename that collides or escapes the folder, and a note that
  lists the wrong paths. The transcript partitions `user.message.images` by
  `isImageAttachment` instead of trusting the field: a daemon from before the
  split filed every attachment under `images`, those logs are permanent, and an
  `<img>` over an HTML file's bytes draws a broken icon captioned by its own
  alt text — which is what "pasted screenshot" on a dropped file was.
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
- **The dashboard has a GOAL, and the denominator is the whole design.** The
  question is "how much of my working time is aide running", the target is to
  drive the idle half down, and everything hard about it is choosing what to
  divide by — three candidates were built and two were wrong on this machine's
  own data. The WINDOW is useless: 21 of the last 30 days ran nothing, so it
  reports 4.6% and mostly measures sleep. `Sitting` (consecutive turns, gaps
  under `IDLE_BREAK_MS`) is the opposite failure — it EXCLUDES every gap over
  half an hour, which is precisely the time the goal is about, so it says 66%
  and cannot improve no matter what changes. What is left is `ActiveDay`: the
  waking hours of days that had work, first turn to last. 30.6h of aide across
  86.5h gives 35%, a number with real headroom that sleeping cannot flatter.
  The 30-minute break survives as the clustering unit: measured, in-sitting gaps
  have a median of 57s and a p90 of 8m against a next-thing-up of hours, so the
  distribution is bimodal with a wide empty middle. Not a setting — a knob would
  let the figure be tuned until it flattered, which for a number whose job is to
  be uncomfortable is the one thing it must not do.
- **Two exclusions keep the goal winnable, and both were got wrong first.** A
  score you lose by sleeping is one nobody looks at twice, so nights and days off
  come out — but the near-miss versions are what to know. (1) "A gap within one
  calendar day is recoverable" puts a 1:23am → 1:16pm stretch at the top of the
  worklist as 11.9h of winnable idle; this machine's five busiest hours are
  between 1am and 5am, so working past midnight is normal and the calendar
  boundary lands mid-night. (2) "A gap containing 4am is entirely sleep" removes
  the whole of a 6:37am → 00:16am gap — 17.7h, nearly all daytime — which
  produced a **373% score with negative idle**. The fix is `nightOverlapMs`:
  measure the OVERLAP with 01:00–08:00, never classify a whole stretch. (3)
  Subtracting that overlap from a day's outer bounds is also wrong — a day worked
  6:37am to midnight contains no sleep, but its bounds still span its own night,
  and the subtraction ate a span holding 3.5h of real work, reporting `span 0.0h`
  against `aide 3.5h`. Night comes out of the GAPS BETWEEN sittings, because only
  an interval with nothing running can be sleep. Separately, a stretch crossing a
  day with no work is a day off, not idle: the 43.8h absence in this machine's
  history was the largest item on the worklist until `crossesIdleDay` existed.
  `pnpm smoke` pins every one of these, including the arithmetic of
  `nightOverlapMs` directly — an off-by-one there moves the score and nothing on
  the page would look wrong.
- **A day is built by ADDING UP intervals, never by measuring its own bounds.**
  `ActiveDay.spanMs` is `activeMs + idleMs`, and the version that computed
  `end - start` of the day's sittings had a hole big enough to invalidate the
  headline: an idle stretch running from one day into the next belongs to
  NEITHER day's bounds. On this machine the four largest gaps all cross midnight,
  so 71.5 of 111.6 recoverable hours were missing from the score **while being
  listed directly underneath it** as the top of the worklist — the page visibly
  disagreed with itself and the wrong half was the number in 34px type. Gaps are
  attributed to the day they START on, the same rule `localDay` gives a turn.
- **There is ONE exclusion test on a gap, and adding a second is the trap.**
  `withinDay` asks only whether the stretch crossed a day nobody worked. Sleep is
  removed by OVERLAP at the point of consumption, so a whole-stretch "mostly
  night, discard it" verdict on top of that double-counts: it threw away a
  00:40 → 09:30 gap along with the 110 waking minutes inside it. Every version of
  this bug — the 373% score, and this one — is the same shape, classifying a
  whole interval where only part of it qualifies.
- **"Idle" is two things, and merging them hides the answer.** The gaps inside a
  sitting are you reading a diff and typing the next thing; the brief calls that
  the second gate, so it is the product working rather than failing, and driving
  it to zero would be a worse aide. The gaps between sittings are aide finished
  with nothing queued. On this machine that is 15.6h against 96.8h — same bucket,
  nothing in common — so `WorkSplit` reports running / reviewing / dead and the
  bar draws three segments. The split is at `IDLE_BREAK_MS`, the same threshold
  the clustering already uses, so there is one number to understand and not two.
  The reading it produces is the one worth having: the gap is NOT the review.
- **That share's numerator is a UNION, and the tile above it is a SUM, and they
  are both right.** aide runs one agent per project but several projects at
  once, so two turns overlap on the clock: this machine's 30 days hold 33.0h of
  summed turn duration over 30.2h of wall-clock, and FOUR of its 37 sittings had
  summed "agent time" exceeding their own span outright. Summing is correct for
  `Activity.activeMs`, which asks how much work was done; a share of wall-clock
  needs a numerator that cannot exceed its denominator, so `Sitting.activeMs`
  merges the intervals instead. The obvious tidy-up — one activeMs for the page
  — reintroduces a bar that can be more than 100% full. The `agent time` tile
  says it sums, in its own tooltip, because the page would otherwise appear to
  disagree with itself. `pnpm smoke` asserts the halves partition their span
  EXACTLY rather than approximately, over a timeline with nested and concurrent
  turns. It also pins the failure that is invisible otherwise — `runIndex` is a
  directory listing, so an unsorted cluster gives one sitting per run, and a
  machine of one-turn sittings reads as 100% busy.
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
- **The wall is a page that ACTS, which is what separates it from the dashboard.**
  `#/wall`, reached from `wall` on the projects header, one column per project
  showing that project's current chat. It takes the whole window on exactly the
  dashboard's terms — a prefix in the URL so the project and chat underneath
  survive, replacing the panes rather than covering them so nothing behind it
  polls — but the dashboard COUNTS and opens nothing, and this one is the only
  surface in aide where a turn is sent to a project without first selecting it.
  That is the whole reason it exists: every project has its own lock, so several
  can run at once, and what stops that happening is purely navigational — starting
  work in one project means leaving the turn you were watching in another. It is
  aimed at the `dead` half of `WorkSplit`, which is the number the dashboard says
  is worth recovering, so whether it worked is a question the dashboard can
  already answer. Two things were deliberately refused. There is no **commit
  all**: reviewing four diffs is four acts, and one press taking them is the
  brief's two-gates-into-one-button, which removes the review rather than
  simplifying it. And there is no **broadcast box** — one prompt sent to five
  projects is five turns written with one project in mind, and reviewing what
  comes back costs more than the typing saved. One send per chat, one commit per
  column.
- **A column draws the TRANSCRIPT, tailed — there is no reduced reading of a
  turn any more.** There was one: a card per turn, a strip of facts off exit
  codes and git with four model-written fields under it, drawn in the column and
  offered as a toggle in the conversation pane. It is gone, removed on the
  judgement that it compressed badly — you ended up seeing LESS, from a summary
  that could be wrong, with the thing you actually wanted a click away. The cost
  it was buying down was width, and the answer to width turned out to be `tail`
  rather than compression: a column draws the panes' own `Transcript` at 60 lines
  against the pane's 250, so what a column gives up is HISTORY, not detail.
  Reading further back is the panes, and the project name in the header goes
  there. The live reply is handed in as `LiveText` so a turn arriving lands in
  the same element it will finish in, and it is RAW here — the typewriter is a
  reading preference the panes carry, and a column is a glance. A column
  deliberately has no file tree, no history and no graph — those answer "where am
  I", which is a question you ask inside one project. What survived the card is
  `currentActivity`, in `protocol/activity-line.ts`, which was always the working
  bar's line rather than part of that view.
- **The picker writes the store the PANES read, and that is the point of it.**
  `rememberProjectChat` and `readOpenChat` are the same per-project memory
  `useAppLocation` already kept for the four panes, so picking a chat on the wall
  and clicking into the panes lands you in it. A store of the wall's own would let
  the two views disagree about what a project is currently about — the
  two-readings-of-one-thing failure this file records more than once. It needed
  one thing the panes never did: a subscription. They write that store as a side
  effect of NAVIGATING, and navigating re-renders everything; the wall writes it
  without navigating, so `watchOpenChats` is what stops a column drawing the chat
  it no longer points at. The chat holding the checkout is MARKED in the picker
  rather than switched to, because a column that re-targeted itself mid-read
  would move for a reason nothing on screen explains. Two identity traps live on
  this path and both are render loops rather than slow renders — the page paints
  correctly and goes grey half a second later, once the first poll has landed and
  the columns have mounted. `readOpenChat` parses the store on every call and so
  hands back an equal-but-distinct object each read, which `sameChat` compares by
  VALUE and the render-phase reset keys on as an id STRING. And
  `useUnstartedChats` held ONE memo slot — see `PerProjectMemo`, which is the one
  that actually greyed the page.
- **A memo keyed for ONE project is a render loop the moment there are two.**
  `useUnstartedChats` derives an array, and `useSyncExternalStore` compares
  snapshots by IDENTITY, so it has to be memoized or every read reports a change.
  It was — against a single slot, `{ source, projectId, rows }` — and that was
  correct for exactly as long as one project was on screen, which the four panes
  guarantee. The wall draws a column per project, React calls each column's
  snapshot in turn, and with one slot they EVICT each other: A's read replaces
  B's entry, B's replaces A's, every read misses, every read returns a fresh
  array. That is an infinite render, not a slow one — the page paints once and
  goes grey when React gives up, about half a second in, which reads as the wall
  failing to open rather than as a cache bug three files away. `PerProjectMemo`
  in protocol is the fix and holds the explanation; `pnpm smoke` drives it with
  two projects interleaved, which is the case that broke and the case a single
  slot passes. Three things about this are worth carrying: the failure is
  invisible to `tsc` and to `pnpm build` (returning a fresh array is perfectly
  well typed), it was unreachable from Node because `drafts.ts` touches
  `window.indexedDB` at module load, and the comment above the old slot already
  warned that a new identity per read is "an infinite render loop rather than
  merely slow" — it just assumed one project. A guard that names its own failure
  mode can still be scoped to an assumption that later stops holding.
- **Only a visible column polls, and that is a budget rather than a nicety.** The
  four panes poll one project because one is open; a wall column polls its own, so
  the rate becomes a function of how many projects you happen to have added — a
  number nobody chose. `useOnScreen` makes it a function of window width instead,
  which is bounded and visible, so horizontal scroll is the mechanism and not just
  the layout. It matters most for a remote project, where a `gitPending` is an ssh
  connection and the ceiling is a refusal rather than a slowdown: sshd stops
  accepting past `MaxStartups`, and when that happens the failure does not land on
  the wall, it lands on whatever commit needed a connection at the same moment.
  `usePoll` guards the same budget from the other direction. The `rootMargin` is a
  screen's worth so a column is usually already answered when it arrives, and the
  hook starts TRUE because an observer reports after paint — starting false costs
  every column a visible blank on arrival to save a request it would have made
  anyway.
- **Columns are in REGISTRY ORDER and never sort themselves.** The same order the
  projects rail draws, which is the order they were added, so there is one layout
  to learn rather than two. The first version ranked by the lock — needs-you,
  then running, then quiet — on the reasoning that a derived order is one nobody
  has to maintain. That defended the wrong property. The wall is navigated by
  POSITION: you learn that a project is the third column and reach for it. A rank
  reading the lock changes on the 1.5s poll, so columns swap places with nobody
  touching anything, purely because a turn somewhere else finished — and the
  failure mode is not a confusing page, it is a turn sent to the wrong project,
  which is the one mistake this page makes easy and expensive. Uncommitted counts
  are doubly disqualified: they are polled per VISIBLE column, so ranking on them
  would reorder the page as you scrolled it. What is lost is that the urgent
  project is no longer leftmost, and that is answered without moving anything —
  the column carries the holder dot and its transcript says what is happening,
  and the
  dashboard is where the across-everything question belongs. A page you steer
  from cannot rearrange itself under the pointer.
- **A column can FORGET its project, and the word is the design.** The ✕ on a
  column header drops the registry entry and nothing else — the repository, its
  `.aide/` and every conversation stay exactly where they are, which is what
  `removeProject` has always done and what the UI had no way to reach. It says
  `forget`, never `delete`, because `delete` is a promise aide does not keep in
  either direction: nothing is destroyed, and somebody reading it would
  reasonably not press it when they only meant to tidy the list. Two presses,
  with the second one NAMING the project rather than asking "are you sure" — a
  question whose only answer is the button you already pressed. The arming is
  local to the column and expires, so two cannot be armed at once and one left
  armed cannot catch a later click. The daemon refuses it while a run holds the
  checkout, which is the same guard `push` has and a sharper reason: the lane
  belongs to the daemon, not the registry, so dropping the entry under a live
  turn does not stop that turn, it ORPHANS it — the run keeps writing to a
  checkout nothing on screen can name, and the column that could have
  interrupted it is the thing that just went away. The wall drops the column on
  the answer rather than waiting for the next poll, because for that beat it is
  still on screen and still typeable, and a send in it lands on a project the
  daemon has already forgotten.
- **The wall's picker discards an UNSENT chat and only an unsent one.** A ✕ on a
  `not sent` row, hover-only, calling the same `discardDraft` the pane's list has
  always called — the wall could create parked chats with `new` and had no way to
  remove one, so pressing it three times left three anonymous rows permanently at
  the top of the picker, pushing the real conversations below a 320px fold. That
  is what it looked like from the outside: a project whose recent chats had
  stopped being saved. The asymmetry with a started conversation is the design
  rather than a gap. A draft is held in THIS browser, has never run, cost nothing
  and is recorded nowhere else, so throwing it away is a local delete. A started
  chat's transcript is the SDK's own file under `~/.claude/projects/`, shared with
  the Claude CLI and the VS Code extension — a ✕ there would delete a record aide
  does not own out of two other tools as well, which is a promise this UI must not
  make. Closing a real chat is the tick, and the brief's second gate is a verdict
  rather than a deletion. Two details bite if reimplemented: the row became a
  `div` with the label as its own button, because a button inside a button is
  markup browsers fix by dropping the INNER one, so the discard would be silently
  unclickable rather than visibly wrong; and the selection is moved off the row
  BEFORE the record is dropped, or the column is left pointing at a `draftId`
  nothing answers to — the header reads "New chat", the composer writes into a key
  with no record, and a send starts a chat from a row the list no longer draws.
  It clears rather than selecting a neighbour, because which chat to show next is
  a choice the human just made by deleting one.
- **The gates are one function, and they have shrunk to the lock.**
  `projectGates` in protocol answers why a project cannot take a chat, a push or
  a send. Those lived inline in `App.tsx`, computed for the one open project,
  which was fine while there was one; the wall needs them per project, and
  recomputing them in the column would put two implementations of "is this
  project blocked" in the codebase. That is the shape behind both wedges in the
  brief — a block reading one object while the button that releases it reads
  another — so it is one pure function both views call, asserted by `pnpm smoke`,
  which a React component cannot be. The commit gate and the dirty-tree rules
  are gone from it: commits are automatic, so an uncommitted tree is a moment in
  the cycle rather than a state a human clears, and a rule blocking chats on it
  would be a refusal with no release. What breaks silently is the surviving
  detail: the composer compares the holder by RUN ID, not by session, because a
  commit attributed to a conversation is not that conversation's turn. `parseLocation` and `formatLocation` moved to
  protocol for the same reason — they are pure but lived in a file that touches
  `window`, which put the one part of routing that fails silently out of smoke's
  reach. A broken round trip is not an error anywhere; it is a reload landing
  somewhere you did not ask for, which reads as the app forgetting what you had
  open. It is asserted as a FIXED POINT rather than as byte-equality with the
  input, because a page with no project formats as `#/wall/` and comparing against
  the input would be testing the spelling instead of the inverse.
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
- **A commit takes the working tree, and starts itself.** There is no commit
  button: `startCommit` in server.ts runs off `ChatLane.onProjectIdle`, once per
  finished chat turn, and commits only after the project's checks pass. A
  session id on it is attribution only, and the subject comes from the turn's
  own summary headline (`turnCommitMessage`) with the helper model as fallback.
  Narrowing what it stages back to one chat's paths re-opens the wedge in the
  brief. The dirty-tree block on starting a new chat went with the button — a
  refusal whose release was removed would be the wedge built on purpose — and
  what replaced it is the PRE-TURN SWEEP: edits a human made between turns are
  committed as `manual edits` (no trailer, no gate — they are already true)
  when the next turn starts, so a turn's auto-commit contains only that turn's
  work. The one exception is a red gate's leftover, which the sweep skips (see
  `#redGates` in chat.ts, persisted in `board.json` so a restart cannot forget
  it) so the failing tree stays the conversation's to fix. A conversation's
  first send answers "is the tree dirty" from the checkpoint's own tree capture
  instead of a separate `git status` — one tree walk, not two, which on a
  remote project is one ssh connection fewer (`captureWorkingTree`).
  The one route left is the API-only escape hatch — `POST
  /api/projects/:id/commit?force=true`, reachable as `pnpm commit-force
  <project>` — which lands a red tree with a `WIP:` subject; `pnpm smoke` pins
  that no web source can name it.
- **A send queues behind a commit, and only behind a commit.** The lock refuses
  rather than queueing — a turn queued behind another CHAT turn would start on
  a tree an unreviewed run just rewrote — but a HELD run (`ChatTurn.held`, the
  auto-commit) only writes history, so `send` admits the turn immediately and
  starts it when the commit releases (`#released`/`#drop` in chat.ts). The
  queued record IS the lock from the moment it is admitted, which is what
  refuses a second send without a second mechanism; the commit stays the
  visible holder until it lands. The web half is `GateHolder.held` in
  `projectGates`: a commit blocks neither the composer nor a new chat — only
  PUSH, because pushing while a commit lands sends a branch whose tip is about
  to move. There is deliberately no way to be made to wait on a commit and no
  interface that locks for one: committing was automated precisely so nobody
  has to care that it is happening. `send` returns the queued run id without
  awaiting the wait — a commit can outlast an HTTP timeout, and a browser that
  restores its draft over a turn the daemon still runs turns one message into
  two.
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
- **Subagents are allowed in chats, and the spawn is judged rather than
  trusted.** The `Agent` tool is allowed by `canUseTool`'s own branch, never by
  a bare name on a list — a bare name approves a call before its input is
  judged, and this input can ask for the two things aide must refuse.
  `checkAgentSpawn` REFUSES `isolation` (a worktree or remote agent's changes
  could not appear in the dev server or in the commit that follows the turn —
  the brief's oldest lesson) and REWRITES `run_in_background` to false (absent
  means background, the SDK's default, so a refusal would fire on the default
  spelling of every spawn; and a background agent outliving `run.finished` is
  still writing files while the commit gate reads the tree). The rewrite is not
  the Bash-rewrite trap because it changes scheduling, not meaning. Allowing
  the spawn delegates no permission: every call a subagent makes re-enters the
  same `canUseTool` — the SDK's `CanUseTool` options carry `agentID` for
  exactly that case — so the question-tool refusal, Plan's read-only rule and
  the Bash policy hold inside a subagent unchanged; a Plan turn's researchers
  cannot edit. This is where GSD-style fan-out lives: parallelism INSIDE the
  one run that holds the checkout, which is the only parallelism the brief
  permits. The spawn check sits ABOVE the plan-approved branch on purpose —
  that branch allows every non-Bash tool generically, so placed below it an
  approved plan could spawn background worktree agents with nobody judging the
  input (which is what it silently permitted before this existed). And
  `currentActivity` skips an open `Agent` call whenever anything else is open,
  because a spawn is a container — open for minutes by design — and counting it
  pins the working bar to a clock that never resets, the wedge signature, while
  the subagent's real steps churn invisibly. `pnpm smoke` pins the spawn
  judgement, both allowlists not naming the tool, and the container rule.
- **The fold has a grid over it: one row per thing touched, one column per
  MESSAGE.** The flat list of tool rows hid the two facts that matter about a
  turn's work — which files it touched, and how many model round trips it
  took, the number the profile already calls the one that predicts the wall
  clock; ten calls in one message cost one round trip. `ToolTimeline` draws
  both: ring for looked, disc for acted, red for failed, a spinner while a
  call runs, and a tinted column under a red bracket for a message spent
  redoing an earlier failure. It survives the test that removed the card,
  because everything on it is DERIVED: `tool-timeline.ts` in protocol holds
  message grouping (consecutive `tool.start`s are one message, because they
  are read off one completed assistant message and appended as a batch), retry
  marking (same tool and target after a failure in an EARLIER message —
  same-message repeats went out together and are not retries, and a retry
  that succeeds clears the failure), the failure classifier (ONE place over
  the recorded result text; an unrecognised failure is a red dot with no tag,
  degraded and honest), and the reads fold (over eight files the read-only
  ones collapse into `reads · N files`; an edited file always keeps its row,
  because it is the diff about to appear in the rail) — all pinned by `pnpm
  smoke`. Subagent calls are deliberately off the grid: they interleave with
  the main loop in real time, so drawing them on its message axis would split
  one round trip into several — the `Agent` call is the dot, and the
  subagent's work stays nested behind the fold. A call announced by the
  `tool` delta draws as a spinner on the column the streaming message will
  become; a column exists only once the model has actually sent it, and
  nothing queued or predicted is ever drawn. Clicking a dot opens the flat
  list at that call: the transcript stays the conversation's one full
  reading, and the grid indexes it rather than replacing it. Two live details
  came from watching it. A call announced mid-stream now learns its TARGET
  before its event — the `tool.target` delta, emitted the moment the target
  field's closing quote arrives in the streaming JSON (`partialToolTarget`,
  pinned: a complete string field is a filename whatever the JSON around it
  is missing) — because until then the live dot sat on a placeholder row for
  exactly the time the model spent writing a big edit's arguments, then
  jumped. And a running turn with no call open draws a spinner in the NEXT
  header slot: the model is thinking or composing, and without the mark a
  grid whose last column has settled is indistinguishable from a stale one.
  It sits in the header and draws no dot, because it claims no call.
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
- **The model is a per-MESSAGE choice, and it is the one setting a conversation
  does not inherit.** A picker beside the mode, from a closed list in
  `protocol/session.ts` — `CHAT_MODELS`, ids and not aliases, because an alias
  resolves to whatever the CLI points it at and `run.started.model` is what a
  profile bills against. Almost all of the plumbing already existed and was
  reachable from nowhere: `FollowUpTurn.model` and `SessionWorker.model` were
  there, `worker/loop.ts` already called `q.setModel`, and both ends were
  hardcoded to `CONFIG.taskModel` — so the whole change is a list, a picker, and
  letting `SendOptions` carry the choice. Three things about it are decisions
  rather than details. (1) A model change must NOT be added to `#reusable`: it
  has a control request exactly as mode, effort and thinking do, so discarding a
  warm worker over it would make switching model the one control that silently
  costs a fork, a CLI boot and a transcript replay — what is fixed for the life
  of a query is the system prompt, which is what the `projectDoc` fingerprint
  guards. (2) `#followUp` sends only what CHANGED, so the omitted case has to be
  RESOLVED to the default before it is compared, or a turn that names no model
  inherits whichever one the last message picked — a deliberate one-off on Haiku
  would quietly become the setting for the chat, and nothing on screen would say
  so. `pnpm smoke:queue` pins that revert directly, because it is invisible
  otherwise. (3) The composer does not inherit from the session even though it
  could — every assistant message names the model that wrote it. Mode IS
  inherited because it is a property of how a conversation is being driven; the
  model is a property of the message. The commit gate's repair attempt names
  none for the same reason it always thinks: nobody reads that turn before it
  runs, so it takes the daemon's default rather than whatever was cheapest for
  the message before it. An unrecognised id at the endpoint is dropped rather
  than refused — that is the stale-tab case, and the cost of a model retired
  since the page loaded should be a turn on the default, not a red line over
  something somebody typed.
- **The composer's controls are per-CHAT, with defaults in `settings`.** Mode,
  model, effort and thinking were one remembered value each, shared by every
  chat: switching to Haiku for one deliberate turn silently switched every
  other conversation, and nothing on screen said so. A pick in a chat's bar is
  now filed under that chat's draft key (`chatSettings.ts`; `carryDraft`
  carries the picks when a draft becomes a session), and a chat that picked
  nothing follows the defaults edited from `settings` in the rail's foot —
  which keep the old `aide.chat.*` localStorage keys, so nobody's built-up
  preference reset the day this changed. The precedence is
  `resolveChatSettings` in protocol, pinned by `pnpm smoke:queue`, because
  every rung fails quietly: composed beats all (a survey must go out on Plan),
  a chat's own pick beats `inherited` (it is explicit and may not have been
  sent yet), `inherited` beats the default (a chat driven on Auto elsewhere
  must not start asking permission here), and thinking resolves with `??`,
  never `||` — false is a choice, and `||` reads it as absence. The wire is
  unchanged: the daemon still sees a model and mode per message, and the
  `#followUp` revert rule above is untouched.
- **The page does not hot-update while a turn is in flight.** A run in this repo
  rewrites the modules the page is running, and a module Fast Refresh cannot
  swap in reloads the browser out from under the turn you are watching — taking
  the transcript with it, and landing in a document nobody has touched, where
  the browser will not let the finish make a sound. So `hotUpdate` in
  `packages/web/vite-daemon.ts` applies nothing while `busy.chats` is above
  zero, and hands the reload to `packages/web/src/reload.ts`, which takes it
  the moment the tab is hidden — a reload nobody can see, with the done alarm
  carried across it in sessionStorage so a finish is still ringing on the
  fresh page — or, if the page stays visible, once the window has focus, the
  alarm has been answered and nothing has been typed for half a minute. The
  hidden path is the fix for the reload that used to land one second after
  every return to the tab, which read as the app reloading in your face for no
  reason. The typing condition is not politeness: the alarm is silenced by any
  keydown, so without it the first character of your next prompt was the
  signal that released the reload which then ate the sentence.
  Drafts are flushed to IndexedDB and waited on before the page goes, because a
  `pagehide` transaction is not guaranteed to commit. Looking at the code you
  loaded with until the turn is over is the price, and it is the cheap half of
  the trade.
- **A conversation has ONE reading, and that is the transcript. Cards were tried
  and removed.** There was a second reading — `reduceCard` in
  `protocol/card.ts` and `TurnCardRow` in the web package, a row per turn holding
  state, checks, diffstat and the summary's four fields, toggled from the
  conversation's header and the default on the wall. It was correct, it was
  asserted against the real logs, and it was removed anyway, because the thing it
  was for did not survive contact: a fixed handful of lines per turn showed LESS
  than the transcript it replaced, and the compression was lossy in the direction
  that matters — what you wanted was usually the part that had been reduced away,
  one click behind a summary that could be wrong about it. Rebuilding it is not
  a gap to fill. The layering argument it was built on was sound and is worth
  keeping for whatever comes next: nothing model-written may assert pass/fail,
  because a soft `status: ok` beside an exit code is a second answer to a
  question already answered hard, and the two disagree eventually on the line a
  human reads first. Two things outlived it — `currentActivity`, which was always
  the working bar's, and the `aide-summary` block, which is still asked for,
  still logged and still stripped at render.
- **That block is text, not a tool call, and the reason is the lock.** The
  obvious design is a `submit_summary` tool the model must call last, which gets
  a validated object for free. `canUseTool` is awaited BEFORE the SDK runs a
  tool, so a mandatory closing call parks the run — holding the project's
  checkout — at the exact moment the turn is finishing. That is the wedge
  `AskUserQuestion` is refused for and the one `ExitPlanMode` escapes only by
  being approved without asking; adding a second such tool to the end of every
  turn means that allowlist may never be got wrong again. A fenced
  ` ```aide-summary ` block has no permission surface, and it fails better: a
  turn that forgets one degrades to what happened before it existed rather than
  hanging. `parseTurnSummary` reads the LAST block, because a turn answering
  "what did you say last time" quotes an older one. The block is stripped at
  RENDER time only — `~/.aide/runs` keeps the reply exactly as the model wrote
  it, since that is the tier-3 record — and there are two strippers, because
  mid-stream the closing fence has not arrived and the ordinary one matches
  nothing, leaving the reader watching the block's own field names type
  themselves out.
- **The working bar names its STEP, and clocks that step.** A spinner and a total
  elapsed time answers "is it still going" rather than the question actually
  being asked, which is "is it still going SOMEWHERE" — a number that only counts
  up looks identical whether the agent is working through files or wedged on a
  call that will never return. So `currentActivity` returns the current step's
  label and the stamp of the event that OPENED it: a clock that keeps resetting
  is visible progress, one sitting at 4m is worth interrupting. It reports the
  OLDEST open call rather than the newest, because one message opens several at
  once and taking the newest resets the clock on every batch, hiding the stall
  this exists to show. A Bash label drops its leading `cd <root>;` and
  `VAR=value` prefixes: nearly every command in this project's logs opens with 34
  identical characters, so the truncated line read the same for a typecheck, a
  build and a smoke run — the one distinction it exists to draw. It lives in
  `protocol/activity-line.ts` rather than in the component so `pnpm smoke` can
  assert the vocabulary; a React component cannot be. The half a test cannot
  catch is `assertNarrationIsExhaustive` in `Working.tsx` — the derivation ends
  in a fallback, so a new event type would otherwise be narrated as "Thinking"
  forever.
- **A shell that reads a file is refused, and the refusal names the tool.** The
  system prompt had asked for Read/Grep/Glob over `cat`/`sed`/`grep` for a long
  time, with the measurement in it, and eight archived conversations then spent
  782 Bash calls and 69 minutes doing it anyway — against 31 calls to `Grep` in
  the same eight. That is the evidence for the general rule: a sentence the model
  may skip is not a rule, and the fix is `checkBashCommand`, which already
  refuses commands and already names a way forward. Refused rather than silently
  rewritten into the tool call it should have been — rewriting has to guess at
  flags, globs, `-n` ranges and quoting, and a guess that is subtly wrong hands
  back the WRONG FILE CONTENTS to an agent with no way to know. A refusal costs
  one round trip and cannot lie. The half that is easy to get wrong is
  `fastBashSettings`: Auto's `Bash(*)` lives in the SDK's settings layer, which
  resolves BEFORE `canUseTool`, so the same prefixes have to be denied in both
  places or the rule is enforced on Plan and decorative on the mode most turns
  run in. `pnpm smoke` asserts the two lists name the same commands.
- **The agent is told what the commit gate will run.** Two thirds of all shell
  time in those eight conversations — 334 runs, 101.6 minutes — went on
  re-running the very checks the commit runs afterwards, one at a time, after
  every edit. The cause is not that checking is wrong; it is that a run cannot
  SEE the gate, so it re-proves the whole tree continuously because it has no way
  to know what will be re-proved for it. So `verifyCommands` rides on
  `RunAgentOptions` and the system prompt names them, says the gate re-reads the
  tree after the turn ends, and asks for parallel calls in one message when
  several are wanted. Because those commands now reach the system prompt, they
  join the warm-session fingerprint: `promptFingerprint` covers the body AND the
  checks, or a run that rewrites the gate — which the commit's one repair attempt
  is explicitly allowed to do — keeps a warm session naming checks that no longer
  exist. The count goes first in that fingerprint and that is load-bearing: with
  the body first, a brief ending "…\n pnpm smoke" fingerprints identically to the
  same brief with `pnpm smoke` declared as a check. `pnpm smoke` pins the
  collision, which is how it was found.
- **The closing report is a few sentences, not a document.** Those eight
  conversations produced 599,737 characters of assistant text — roughly 150,000
  words — most of it a 2,000–3,000 character markdown summary at the end of every
  turn, restating work the human is about to read as a diff. The prompt asks for
  what the diff does NOT show: a decision that could have gone the other way,
  something tried and backed out, a claim left unverified, anything undone.
  Framed that way rather than as a length limit, because a limit becomes a target
  and because the real point is ownership — aide already shows the diff, the
  checkpoint and the transcript, so the words are worth spending only on what
  none of those carry.

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

Do not re-run a check after every edit to see where you are. The commit gate
runs these itself, over the working tree, *after* your turn ends, and hands you
any failure to fix once — so a check you ran three edits ago proves nothing
about what you are handing over. Run them when a coherent piece of work is
finished. This is the most expensive habit in this project's own run logs: across
the eight most recently archived conversations the checks were **334 separate
runs and 101.6 minutes — 67% of all the time those runs spent in a shell**, and
81–89% of it on four of the eight. 161 of 243 check waves were a single check on
its own, which is the guidance above being ignored; batching every wave as it
stood would have recovered 26 minutes.

Compound commands are judged segment by segment: pipes, `;`, `&&` and `||` are
split and every segment must clear the same lists, so `pnpm test 2>&1 | tail -50`
and `git log | head` are fine while `cd X && cat Y` is refused for the `cat`.
Substitution (`$( )`, backticks), subshells and backgrounding stay refused
outright — they let an allowed prefix carry a payload. Use
`pnpm --filter @aide/daemon <script>` rather than
`cd packages/daemon && pnpm <script>`.

`cat`, `head`, `tail`, `sed`, `grep`, `awk`, `rg` and `find` are **refused** in a
shell here — use Read, Grep and Glob. This was advice in the system prompt, with
the measurement attached, for a long time before it was a rule, and the runs did
it anyway: the same eight conversations spent 592 Bash calls on `grep`/`awk`/
`find` and 190 on `cat`/`sed`/`head`/`tail`, 69 minutes for work the file tools
do in about a millisecond, against 31 total calls to `Grep`. A sentence the model
may skip is not a rule. `ls` is deliberately still allowed: `Glob` answers a
different question, and refusing `ls` would push you to `Glob("*")`.

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

**Never run `git commit`. aide commits for you, automatically.** When your turn
ends, the daemon runs the project's checks over the working tree and — if they
pass — commits everything, using your closing summary's `headline` as the
subject and your prompt's first line as the body (helper model drafts from the
diff if you wrote no summary). One commit per turn, made by the daemon at a
known point after the gate; a run committing mid-turn would put half-finished
work into history, so `git commit` stays in `HUMAN_ONLY_COMMANDS` and there is
no invocation that gets through. If the checks fail, the failure is handed to
the conversation for one fix, then the tree simply stays dirty and the next
turn's end tries again — do not fight this, and do not try to commit around it.

**Push is the one git button, and the only manual git act.** Committing has no
button at all any more; sending work off the machine is the one irreversible
step, so it stays a human press, with two spellings: push as-is, or
squash-and-push, which folds the per-turn auto-commits into one (every subject
survives in its body, every `Aide-Session` trailer rides along) before sending.
Never `--force`: the squash only ever folds commits that have not been pushed,
so the result is a fast-forward, and a push that needs force is a history
rewrite that stays in a terminal.

`git push` is deliberately NOT human-only. Push moves only commits that have
already landed through the gate; blocking it stranded finished work on the
machine that made it, which is what happened to a remote project on `tg`. `pnpm
smoke` asserts push is allowed on both paths, that commit is not, that the two
refusal reasons differ, and that the commit refusal names push as the thing
that IS allowed.

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
