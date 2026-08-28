---
id: "0002"
status: proposed
created: 2026-08-27
---

# Single run, on the main checkout

Drop worktrees and per-run branches. One agent works the project's own checkout
at a time, behind a lock, over a checkpoint of whatever was dirty when it
started.

**Nothing reads this file.** Prose for humans, like `0001`.

## Why

A worktree isolates *committed* state. The real state of a project lives
uncommitted in the main checkout, so a run branched from HEAD is working against
a version of the repo that has not been true for hours — one full run here was
built against code that had already been deleted. And because the dev server
serves main, a worktree's changes can never appear in it, so the review gate
cannot pass on anything visual.

Parallelism moves up a level: several projects, one agent each.

## Decided

### 1. Runs execute in the project root

`cwd` is always `project.root`. There is no worktree, no `aide/NNNN-slug`
branch, no `git worktree add`, no `.git/info/exclude` line, and no isolated /
not-isolated distinction. Every conversation edits the tree you are looking at.

### 2. One run per project, refused rather than queued

The lock is **in memory, per project, derived from whether a turn is in
flight** — the same rule the daemon already lives by ("a conversation's state is
derived on every read from whether a turn is actually in flight, so a crash
leaves nothing to correct"). A lock *file* would be the one piece of state in
this product that needs boot reconciliation, and a daemon killed mid-run would
leave a repo that looks permanently held.

It **refuses**; it does not queue. A queued turn would start against a tree the
previous run has just rewritten and that nobody has reviewed yet — which is the
exact staleness this whole change exists to remove, reintroduced one level up.
The refusal names the holder and what to do: *"`<title>` has the repo (started
4m ago). Stop it, or wait for it to finish."*

The holder is published, not just counted: the project row, the composer and
`/api/health` all say which conversation is working.

### 3. The checkpoint is a snapshot commit on a private ref

Before the first turn that could write — that is, before any turn in a mode
other than `plan` — the daemon snapshots the working tree:

```
GIT_INDEX_FILE=<tmp>  git read-tree HEAD
GIT_INDEX_FILE=<tmp>  git add -A
GIT_INDEX_FILE=<tmp>  git write-tree                            -> <tree>
git commit-tree <tree> -p HEAD -m "aide checkpoint ..."         -> <sha>
git update-ref refs/aide/checkpoints/<sessionId> <sha>
```

A temporary index, so the human's own index and working tree are never touched.
The ref lives under `refs/aide/`, not `refs/heads/`, so it stays out of
`git branch` and out of the graph (`repo.ts` logs `HEAD --branches`).

Deliberately **not** `git stash`: the porcelain reverts the working tree, which
would yank the dirty state out from under the dev server the human is watching.
And `git stash create`, which does leave the tree alone, silently omits
untracked files — verified: on a tree with one modified and one untracked file,
`stash create` captured one path, the temp-index snapshot captured both.

Caveat to state in the UI: `add -A` honours `.gitignore`, so ignored files are
not in the checkpoint. That is correct for `node_modules` and wrong for a
`.env` someone is mid-edit on.

Undo is one command, and the UI shows it:
`git restore --source=refs/aide/checkpoints/<id> --worktree -- .`

### 4. The checkpoint is also the diff baseline

This is the part that is *not* just "review stays as it is".

Today the review diff is only ever the agent's work by construction: the
worktree started clean. In the main checkout it is not — `diff HEAD` mixes the
agent's changes with whatever the human had uncommitted before the run. The
existing invariant in `worktree.ts` is explicit that this matters: *"if the diff
the human reviews and the `add` the commit runs disagree, the human approves one
change and lands another."*

So:

- **The review diff is `git diff <checkpoint-tree>`** — exactly what the agent
  did, which is the question the panel exists to answer.
- **The commit stages exactly the paths in that diff** (`git add -- <paths>`),
  not `git add -A`. This is what stops the agent's commit from carrying the
  human's unrelated untracked junk.
- **Files that were already dirty at checkpoint time and were also touched by
  the run are listed by name above the commit button.** Git cannot separate two
  people's edits inside one file, and pretending otherwise is how someone
  commits work they did not review. Naming them is enough; the human decides.

In the common case — clean tree when the run starts — all three collapse to
what happens today.

### 5. Two gates, re-sited

`project.md` states the two gates as `needs-review -> committed -> done`, and
justifies the second as *"merging is what the rest of the repo has to live
with"*. Without a branch there is no merge, so `land` disappears and the brief's
wording no longer describes the product.

Proposed re-siting, for the brief to be updated to match:

- **Gate one — commit.** You read the diff and commit it to the branch you are
  on. Recoverable: the checkpoint is still there, and so is `git reset`.
- **Gate two — the verdict.** The row closes as `done` only when you say so,
  after the change has been running in front of you. Recoverability now comes
  from the checkpoint ref rather than from an unmerged branch.

This is a real weakening and should be recorded as one: two gates on the *code*
becomes one gate on the code plus one on the *bookkeeping*. The compensation is
that the review now happens against the tree the dev server is serving, which is
what makes a visual change reviewable at all.

## What gets deleted

`packages/daemon/src/worktree.ts` — split, not renamed. Gone entirely:
`ensureWorktreeAt`, `removeWorktreeAt`, `ensureIgnored`, `branchExists`,
`mergeBranch`, `workingTreeDirt` (its only caller was `mergeBranch`),
`currentBranch` as used by review. What survives moves:

- `changes.ts` — `AGENT_SCOPE`, the diff/status/stat readers, `commitWorktree`
  (renamed), `recentSubjects`, `withRowTrailers`, `appendTrailers`.
- `checkpoint.ts` — new, per above.
- `isGitRepo` / `repoRoot` move to `repo.ts`, which is where the rest of the
  read-only git lives and where `registry.ts` already reaches for them.

`maxBoardBranchId` is the exception. It is not worktree machinery even though it
lives there — it stops a deleted row's id being handed out twice. With no
branches it must read the durable record instead: `Aide-Row` trailers in
`git log`, which `repo.ts` already parses. Delete it and old commits get
mislabelled the moment `0003` is reused.

Also deleted:

- `board.ts`: `reclaim()`. The `warning` field it feeds is **repurposed**, not
  removed — it becomes where the checkpoint ref is reported on close.
- `chat.ts`: `Isolation`, `#cwdFor`, `#prepare`, `TurnRecord.install`, the
  `worker: null` window and `cancelled_during_bootstrap`, the `cwd` field on
  `SessionWorker` and its check in `#reusable`.
- `bootstrap.ts`: **all of it**, and this is the one worth arguing about. Its
  stated reason for existing is that `git worktree add` checks out tracked files
  only, so a fresh worktree has no `node_modules`. The main checkout has its
  dependencies already. With it go `runBootstrapQueued`, the concurrency queue,
  `bootstrapsWaiting`, `CONFIG.bootstrapConcurrency`, the `bootstrap.started` /
  `bootstrap.finished` events and their rendering in `Transcript.tsx`, and the
  `bootstrap` / `bootstrapTimeoutMs` frontmatter. The parser must stay tolerant
  of both keys for a release so existing `project.md` files do not start failing
  loudly — the validation there is deliberately fatal.
- `paths.ts`: `worktreesDir`, `rowWorktreePath`.
- `todo.ts`: `boardBranch`.
- `server.ts`: the `land` route; `isolated` and the isolation-resolution block
  in `POST /chat`; `removeWorktreeAt` on close.
- `review.ts`: `conversationBranch`, and `conversationWorktree` collapses to a
  row lookup.
- `Composer.tsx`: `IsolationToggle` whole. `api.ts`: `isolated`, `landChat`.
  `Review.tsx`: the land button.
- `CONFIG.maxConcurrentRuns` and `Health.busy.runs` are already vestigial —
  `busy.runs` is hardcoded `0` and nothing enforces the cap. Either delete them
  or re-point `busy.runs` at the lock. Re-point: "1 run in flight" is the field
  the restart interlock wants.

## What breaks, and is not obvious

**`kind` stops being derivable.** `sessions.ts:classify()` reads `task` out of
`.aide/worktrees/task-NNNN` in the cwd. Every new session is now `chat`. Keep
`classify` — sessions that really did run in worktrees are still on disk and
should still read correctly — but `ConversationKind`, `taskId`, and
`kindLabel` / `kindColor` in `Conversations.tsx` become history-only, and
`session.ts`'s doc comment ("a task run is a session whose cwd is a worktree")
is now false.

**The agent's system prompt lies.** `agent.ts` opens with *"You are running as
an autonomous task in a git worktree."* An agent told that may reason it can be
careless. It must say it is working the project's own checkout, over a
checkpoint, with a human reviewing the diff.

**`CLAUDE.md` in this repo lies too.** The whole "Things to know about this
worktree" section — `.aide/tasks/` as a stale snapshot from the branch point,
the excluded paths — stops being true.

**`add -A -N` now runs across the human's tree.** `repo.ts` is documented as
strictly read-only for exactly this reason: *"a task worktree belongs to aide
and the project's checkout belongs to the human."* That distinction is gone.
Intent-to-add adds no content, but it does change what `git status` shows in the
human's own terminal mid-review. `repo.ts` already has the alternative —
`diff --no-index` against `/dev/null` for untracked files, which touches
nothing. Use it, and drop `add -A -N` from the review path.

**`.aide/todos.md` stays excluded from `AGENT_SCOPE`, for a sharper reason.**
The current justification (a branch's stale copy overwriting the live one on
land) evaporates. What replaces it is worse: the daemon rewrites `todos.md` in
the *same tree* the agent is editing and the review is about to commit, so
committing the agent's mid-run copy is now a live race rather than a stale
merge. Same for `.aide/journal/`.

**Existing worktrees must not be auto-removed.** `.aide/worktrees/0001` exists
right now. Nothing in this change should delete it — a button press must not
delete work nobody saved, which is the codebase's own rule. Leave them; leave
the `.git/info/exclude` line alone too.

**aide-in-aide makes the restart interlock load-bearing.** The daemon serves the
checkout the agent is now editing, so every run rewrites the running daemon's
own source. `sourceId` / `stale` / the quiet-period rule in `restartDecision`
goes from a safety net to part of the normal loop, and the lock must be counted
in `busy` or a restart will land mid-run.

**Both smoke suites need real work.** `smoke.ts` is built on
`ensureWorktreeAt` / `commitWorktree` / `mergeBranch` / `removeWorktreeAt` and
asserts on `.git/info/exclude`; the assertions re-aim at checkpoint + scoped
diff + scoped commit. The `buildGraph` fixtures can stay — they synthesise
history and never exercise worktrees. `smoke-queue.ts` loses its isolation
section and gains two: the lock refuses a second run and names the holder, and
the checkpoint round-trips (dirty tree, run writes, restore from ref, tree is
back).

## Kept, deliberately

- The board, rows, `board.json`, verdicts, `Aide-Row` / `Aide-Session` trailers.
- Starting a chat from a row still sends `todoId` with the first message — not
  to pick a working directory any more, but because `linkSession` fires when the
  SDK names the session and the daemon must already know the row.
- Writing the approved spec into the tree as part of the same commit. The
  reasoning ("the claim and the code that earns it are one commit and one
  revert") is unchanged; only the path moves from the worktree to the root.
- `registry.ts`. It is the *project* registry, not a worktree registry.
