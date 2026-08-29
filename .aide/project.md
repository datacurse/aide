---
# What has to pass before aide will write a commit here, in order. `CI=true` and
# NO_COLOR are supplied, so these are written without the prefix CLAUDE.md shows.
verify:
  - pnpm typecheck
  - pnpm smoke
  - pnpm smoke:queue
  - pnpm build
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
- **A gate on the code, and a gate on the work.** You read the diff and commit
  it; separately, you decide the work is done and the row closes. There is no
  merge to be the second gate any more — recoverability comes from the
  checkpoint instead. Collapsing the two into one button is not a
  simplification, it is removing the review.
- **The gate on the code is on the working tree, not on a chat.** What blocks the
  next conversation and what the commit button takes must be one list. They were
  once two — the block read the repository, the button read a conversation's
  checkpoint — and a project dirtied by anything that was not a chat was then
  refused every new conversation with no button in aide that would clear it. A
  gate whose precondition and whose release read different objects can wedge, and
  the only way out of that one was a terminal.
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
- A git graph. Fun, and the least useful thing on the list.
- Supporting a database until run-history queries actually hurt.
- Multi-user, remote access, or anything that assumes this is not running on
  your own machine behind loopback.

## Current milestone

Developing aide in aide. Phases 1–3 (landing works, runs survive restarts, the
agent gets project context and installed dependencies) are done by hand; the
iteration loop and the code-reading surface are meant to be built through aide
itself.
