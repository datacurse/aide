---
# What has to pass before aide will write a commit here, in order. `CI=true` and
# NO_COLOR are supplied, so these are written without the prefix CLAUDE.md shows.
#
# `unless:` names what a check has nothing to say about — it is skipped only when
# EVERY changed path is under one of those paths. Stated as irrelevance rather
# than coverage on purpose: a file nobody thought to list then makes a check run
# when it need not have, which costs seconds, instead of silently not running,
# which costs the gate. Kept coarse for the same reason — the finer this gets the
# more of the gate rests on somebody's memory.
verify:
  - pnpm typecheck
  - run: pnpm smoke
    unless: [packages/web, .aide, CLAUDE.md, README.md]
  - run: pnpm smoke:queue
    unless: [packages/web, .aide, CLAUDE.md, README.md]
  - run: pnpm build
    unless: [packages/daemon, .aide, CLAUDE.md, README.md]
---

# aide

A bird's-eye view across projects, with Claude working tasks in each one.

The product is the **project state machine**: inbox → spec → roadmap → task →
agent → verified diff. The file tree, the editor and the git graph are not the
product — those are solved, buyable components that happen to be needed in order
to review the work without leaving.

## Constraints

- **State lives in files, not a database.** `~/.aide/` for daemon-global state,
  `<project>/.aide/` for per-project state, both plain and human-readable. If
  aide disappears, `.aide/` is still a description of the project.
- **No login flow.** aide drives the Claude Agent SDK and inherits whatever
  credentials the machine already has. Anthropic does not permit third-party
  products to offer claude.ai login, so bring your own — there is no other
  supported setup, and adding one is not an option.
- **One agent has the repo.** Runs work the project's own checkout, one at a
  time, over a snapshot taken before they start. Worktrees isolated *committed*
  state while the real state of a project lives uncommitted, so a branched run
  worked against a repo that had not been true for hours — and its changes could
  never appear in the dev server, which made anything visual unreviewable.
  Parallelism is several projects, not several agents in one.
- **The machine gates the code; the human gates the work, and the push.**
  Committing is automatic: when a turn ends, aide runs the project's own checks
  over the working tree and commits everything if they pass — one commit per
  turn, made by the daemon, never by the model, with the turn's own summary
  line as the subject. The review moved rather than vanished: the checks are
  the gate on the code, the checkpoint is the recovery, and the transcript
  beside the rail is where a commit explains itself. What stays human is the
  verdict that the work is done, and the push — the one irreversible step —
  which is the only git button left. There is deliberately no commit button at
  all: a control for something that happens correctly by itself is a control
  that teaches you to distrust it.
- **A gate that loses its button loses its blocks.** The dirty-tree refusal on
  starting a new chat went with the commit button, and had to: a refusal whose
  release was removed is the wedge this brief has been bitten by twice, built
  on purpose. An uncommitted tree is a moment in the cycle now — the next
  turn's end sweeps it, editor edits included — not a state somebody must
  clear.
- **One automatic attempt, then a person.** A commit whose checks fail hands the
  failure to the conversation, lets it try once, and runs the checks again over
  what that left. A second failure stops and asks. The attempt is worth taking
  because it is the step you would otherwise take by hand, from the transcript
  right there — but a gate that keeps retrying is a gate spending your money in
  a loop against a failure it has already shown it cannot fix, so the number is
  one and it is not a setting.
- **Two modes: Plan and Auto.** Both act; Plan asks once, for the plan. There is
  no mode that stops for permission mid-turn, because aide sends turns nobody
  typed — the fix above is one — and a prompt raised by one of those blocks the
  run that is waiting on it, holding the checkout, with nobody to answer.
- **Cost figures are estimates.** They come from a price table bundled into the
  SDK at build time. Fine for a dashboard, never for billing, and anything that
  displays one should say so.
- **Fail closed.** A headless run has nobody to answer a permission prompt, so
  anything not explicitly permitted is denied — and the denial should say what to
  do instead.
- **The daemon must survive the browser.** Runs continue with the tab closed.

## Non-goals

- Being an IDE. No go-to-definition, no blame, no extension host. Reading and
  reviewing code in aide is in scope; replacing the editor is not.
- A repository browser. The rail draws the last thirty commits, because a
  screen that could not say which commit was the last one left you unable to
  tell a clean tree on top of your own work from a clean tree on top of
  somebody else's. Nothing in that list opens: no commit view, no file tree, no
  diff of an old change. A diff is read in the conversation that produced it,
  where there is a description and a checkpoint to measure it against. This
  used to say "a git graph, and the least useful thing on the list" — the graph
  turned out to be the cheap half and the browser the expensive one.
- Supporting a database until run-history queries actually hurt.
- Multi-user, remote access, or anything that assumes this is not running on
  your own machine behind loopback.

## Current milestone

Developing aide in aide. Phases 1–3 (landing works, runs survive restarts, the
agent gets project context and installed dependencies) are done by hand; the
iteration loop and the code-reading surface are meant to be built through aide
itself.
