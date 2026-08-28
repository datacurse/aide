---
id: "0001"
status: proposed
created: 2026-08-27
---

# Conversations as the unit of work

The chat is the task. A todo list feeds it, a spec records what came out, and a
board shows what is moving. `.aide/tasks/` and the tasks tab go away.

**Nothing reads this file.** `.aide/specs/` has no parser — `specsDir` in
`protocol/src/paths.ts` is still marked "slice 3" — so this is prose for humans
until the intake pass exists.

## Why

`.aide/tasks/` is empty. `.aide/journal/` is empty. There are no `aide/*`
branches. Exactly one commit in this repository carries an `Aide-Task` trailer —
`2d8d52a`, the commit that *built* the two gates. Everything since was written in
a chat and committed by hand.

The task path was not wrong, it was expensive to enter. A task costs a tab, a
name, a file, a queue and a status field before any work happens. A chat costs a
sentence. The machinery underneath — isolation, and a diff reviewed as a unit —
is what makes an agent editing your repository survivable, and none of it needed
a task file. Binding them together was the mistake.

## Decided

**The chat is the unit of work.** Not a file describing work to be done: the
conversation where it happens, carrying a status. One-shot or fifty follow-ups —
it ends when the human says it ended.

**Two entry points, neither privileged.**

- Click a todo → opens a **new chat with the composer prefilled** with that todo.
  It does *not* send. The human still presses send, and can attach screenshots or
  add context first. The prefill is a starting point, not a submission.
- Open a chat cold and say what is wrong. No todo first — writing one would be
  slower than saying it. Most work will start this way and that is fine.

**A board, not a Kanban.** A list. Columns are grouping dressed up as a method
and they do not fit how this work actually moves. Closed items sink to the
bottom; everything above is ordered by urgency.

**Todos and spec side by side.** One view showing what is wanted next to what is
built, so the gap is visible without switching. Todo rows carry the state of any
chat working them, so two chats never get pointed at the same thing and no work
is silently overwritten.

**Parallel chats run in worktrees.** Several chats working different things at
once, each in its own checkout on its own branch. Chats editing one working tree
in parallel is the merge chaos `worktree.ts` was written to prevent, and it looks
like the model being bad.

**Both files are agent-written.** No human-only constitution — the point is not
to hand-manage files. The human says what they want; the agent writes it down,
updates it, and remembers the decision.

**The human holds the verdict.** This is what replaces the file permission I
originally proposed, and it is better: the agent may write every file, but only
the human marks a chat done. An agent can never certify its own work, and there
is nothing to hand-manage. Same protection, no bookkeeping.

### Which chats reach the board

A chat started from a todo and a chat started cold ("the git pane scrolls wrong")
are both real work, and the board has to show both — otherwise you write a todo
for something a chat is already fixing, which is the blindness the side-by-side
view exists to prevent. But a throwaway question must not write a line into a
git-tracked list.

The line is already drawn by a decision made above: **isolation is chosen when a
conversation starts.**

- **Isolated** — you meant work. Gets a board row and a durable todo line,
  whether or not a todo started it.
- **Not isolated** — a question. Chat list only. Writes nothing, no status
  beyond running or idle.

So a todo is a board row with no chat attached yet, and a cold chat is a row that
never had a todo. Same list.

### Names

Session ids are UUIDs. Keying a worktree on one gives
`.aide/worktrees/9f3c1a7e-4b2d-…`, which is merely ugly; keying a *branch* on one
is permanent damage, because `aide/9f3c1a7e-4b2d` is what lands in `git branch`,
in `git log --graph`, and in the merge commit subject forever.

Reuse the convention `.aide/tasks/` already had: a board row takes a sequential
id and the branch is `aide/0007-fix-git-pane-scrolling`. Number for uniqueness,
slug for meaning; `slugify()` and `nextTaskId()` already exist in protocol. The
slug comes from the todo text when there is one and from the first message when
cold. The same id is the join key between the git-tracked todo and the local
status.

### Reclaiming worktrees

`ensureWorktree` deliberately never resets, stashes or cleans, because whatever
the last run left uncommitted is the point. So: never remove a checkout with
uncommitted work unless the human said so.

What makes this easy is an asymmetry — **remove the checkout, keep the branch.**
The checkout is hundreds of megabytes of source and dependencies; the branch is
a few kilobytes of refs. Wrong call? `git worktree add` restores it instantly.

- **closed / done** — landed. Remove, as the task path already does.
- **closed / failed or dropped** — remove the checkout, keep the branch, so a
  retry can see what the last attempt did.
- **open for weeks** — do not decide for them. Surface it on the board ("4
  worktrees, 1.4 GB, oldest untouched 24 days") with a reclaim action.

Near-zero bookkeeping, because closing is the common path and it is automatic.
The more aggressive variant — auto-commit stale work to its own branch, then
reclaim — loses nothing and needs no button, but it writes without asking, so it
is offered rather than defaulted to.

### No cap on conversations

The task queue caps at 2 because enqueueing is cheap and reviewing is expensive;
that asymmetry is what piles work up, and the cap absorbs it. It does not
transfer. Starting an isolated chat costs the same scarce thing that reviewing
costs — you have to type into it — so nobody accidentally opens twelve, and a
system refusing the ninth is guessing at your attention worse than you can.

The resources do not argue for a cap either. `node_modules` is 484 MB by `du`,
but pnpm hardlinks from a content-addressed store on the same volume, so the
marginal disk per worktree is close to nothing. Spend is bounded by turns in
flight, which is bounded by typing speed, and `maxBudgetUsd` already covers the
per-conversation runaway. Review bandwidth is real, but the board's sort already
converts it into pressure: unreviewed work pins to the top, so the pile *is* the
list.

**What genuinely contends is `pnpm install`.** Four simultaneous bootstraps
thrash the disk and finish later than four serial ones would. So the limit
belongs on the *bootstrap step*, not on conversations: new worktrees queue for a
setup slot, and a conversation is never blocked once it is running. That is the
supervisor's existing FIFO applied to the operation that is actually contended
rather than to the human's intent. You may open as many isolated chats as you
like; the fifth may wait twenty seconds for dependencies.

### Two files, and why

`project.md` and `spec.md` stay separate — not on a permission argument, since
agents write both, but a mechanical one:

| | `project.md` | `spec.md` |
| --- | --- | --- |
| changes | rarely | every commit |
| size | small, stable | grows without bound |
| needed | every prompt | on demand |
| conflicts | never | on every parallel branch |

Merged, the combined file inherits the worst of each: large enough to hit the
truncation below, important enough that truncating breaks things — and the
constraints now live in a document every parallel chat rewrites, so they conflict
at land time. The only question two files ever pose is which one an agent writes,
and that is one line: *changing what the app does* → spec; *changing what the app
is for* → project.

### The context budget

`agent.ts` inlines the project doc through `truncate(doc, MAX_PROJECT_DOC_CHARS)`
where `truncate` is `s.slice(0, n) + "..."` and the cap is 8,000 characters. Over
that, the document is cut mid-sentence and the agent is told nothing.

Not yet hit — `project.md` is 2,329 characters. But *this file* is already over
8,000, and under this design the spec goes into every turn of every conversation.

Three fixes, in order of importance:

1. **Silent truncation is the bug.** A spec whose "can't do" list was cut off is
   worse than no spec: the agent reads a confident, complete-looking document
   missing exactly the half that would have stopped it. Say so instead — to the
   agent ("truncated at N chars; the full document is at `.aide/spec.md`", which
   it can `Read`) and to the human, on the board. A truncation that is known
   about is recoverable.
2. **Raise the cap.** 8,000 characters is ~2,000 tokens, set when the doc was a
   short brief.
3. **Stop inlining the whole spec.** What must be in every prompt is the part
   that prevents the wrong thing — constraints and the "can't do" list. What the
   app *can* do is discoverable by reading the code, which agents are good at.
   Inline the constraints, point at the rest. That keeps the always-present part
   small permanently instead of buying headroom that gets eaten again.

### Where state lives

Split the question first — "state" is several things with different homes, and
lumping them together is what made this look hard.

**Todo text, row id and spec → the repo.** The row id has to be there: it is half
the branch name, and `nextTaskId()` has to know what is taken.

**Whether work started, whether it is still open, what was done → git already
knows.** The branch `aide/0007-fix-git-pane-scrolling` exists if and only if work
started. The worktree exists if and only if it is still open. The commits on that
branch are what was done. Three pieces of state, no storage.

**Verdicts → also the repo, as edits rather than a field.** *Done* means the todo
line is gone and the spec describes the capability. *Failed* means the line is
still there with no chat attached. *Dropped* means the line is gone and the spec
did not change. There is no `status:` to write anywhere; the verdict IS the shape
of the todo file.

**Which leaves exactly one fact with nowhere natural to live:** row `0007` ↔
session `9f3c1a7e-…`. It churns, and it names a session id that only exists in
`~/.claude/projects/` on this machine. So: one small map in `~/.aide/`, per
project, row id → session id. Nothing else.

Two things make that right. The failure mode is graceful — lose the file and you
lose the ability to click a todo and jump to the conversation that worked it,
while keeping the todo, the spec, the branch, the commits and the code. And
`project.md` rules out multi-user and remote access, so the main argument for
putting the link in the repo — another machine seeing the board — has no other
machine to serve.

**Derived, never stored:** working, needs-you, blocked, stale.

### Statuses

Three states and two flags, rather than six states. The question a status answers
is "does this need me?", and six answers to that question is five too many.

States, mutually exclusive:

- **working** — derived. A turn is in flight. Needs nothing.
- **needs you** — derived. Nothing running and no verdict yet. Whether the agent
  finished or stopped to ask, the next move is yours. This is the resting state.
- **closed** — set by the human, with a reason: **done**, **failed**, or
  **dropped**. The reason matters for the todo, not the chat: *done* and
  *dropped* remove the todo, *failed* returns it to the pool for another attempt.

Flags, orthogonal and derived:

- **blocked** — a permission request is outstanding. An agent is literally
  waiting on a click. Sharpens "needs you" into "needs you now".
- **stale** — no activity in N days, still not closed. A flag rather than a
  state, because a chat that has been waiting three weeks is still waiting *for
  you*, and making staleness a status throws that away.

Default sort, by what it costs to ignore: blocked → needs you → working → closed.
Working sorts below needs-you deliberately: it is the one state that wants
nothing from you.

### When the spec and the todo list get written

**The agent cannot write the spec "as part of the work", because it never knows
when the work is over** — that is the human's verdict, not its. A chat runs
twenty turns and there is no turn on which it should write "the app can now do
X". Writing it early is claiming success mid-flight, which is the exact thing the
verdict exists to prevent.

So it needs a trigger, and one already exists: **the commit gate.**

- **spec → drafted at commit time, from the diff, into the same textarea as the
  commit message.** There is a diff to describe, the human is already reviewing,
  and the machinery exists: the commit message is already drafted by Sonnet from
  the diff plus the repo's recent subjects, handed to a textarea, and the editing
  IS the review. The spec delta rides the same surface, commits with the code,
  and lands with it — so reverting the change reverts the claim.
- **todo list → written by the daemon in the main checkout at the close
  transition,** and excluded from what an agent can stage, the way `.aide/tasks/`
  already is in `AGENT_SCOPE`. The list carries the daemon's own bookkeeping and
  the daemon lives in the main checkout.

The asymmetry is deliberate: a spec entry is a claim about the code and belongs
next to it; the todo list is bookkeeping about work in flight and belongs where
the bookkeeper is.

Conflicts on `spec.md` between parallel branches are possible but occasional —
git merges line edits in different regions fine, so a conflict means two chats
touched the same capability line, which is worth knowing. `mergeTaskBranch`
already aborts cleanly rather than leaving a half-merged tree.

## Non-goals

- **Rebuilding the tasks tab under a new name.** If the result has a place where
  you fill in a form before work can start, nothing changed.
- **Kanban columns.**
- **Removing the second gate.** Committing is recoverable; merging is what the
  rest of the repository lives with. The agent committing unattended is safe
  *because* landing is separate — that gate is what buys the automation, not what
  blocks it.
- **Isolation by default.** Most chats are questions. Paying for a worktree and a
  bootstrap install to ask where a function is defined teaches people to leave it
  off.
