import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { Project } from "@aide/protocol"
import { specPath } from "@aide/protocol/node"
import { rowForSession } from "./board.js"
import { commitRun, recentSubjects, runChanges, withRowTrailers } from "./changes.js"
import { readCheckpoint } from "./checkpoint.js"
import { CONFIG } from "./config.js"
import { draftCommitMessage, draftSpecUpdate } from "./helper.js"
import { readSpec } from "./todos.js"

/**
 * Reviewing a conversation's work and committing it.
 *
 * The gate itself is unchanged: the agent leaves everything uncommitted, a human
 * reads the diff, and committing is a person pressing a button. What changed
 * underneath is what "the diff" means.
 *
 * A worktree used to answer that for free — the checkout started clean, so
 * whatever was in it was the agent's work. In the project's own tree it is not
 * free: `git diff HEAD` is the agent's changes mixed with whatever the human
 * already had uncommitted when the run started. So every read here is measured
 * against the conversation's checkpoint, and the commit stages exactly the paths
 * that diff named. The invariant that matters is the one `changes.ts` states:
 * the diff the human reads and the paths the commit stages must come out of the
 * same computation, or the human approves one change and commits another.
 *
 * What is NOT here, deliberately: a `land`. There is no branch to merge, because
 * there is no branch. The second gate moved to the verdict — see `closeChat`.
 */

/**
 * The baseline a conversation's work is measured against.
 *
 * Null means no checkpoint, which is not a missing feature but a conversation
 * that has never taken a turn: the snapshot is taken before the first message
 * reaches an agent, so anything that has run has one.
 */
export async function conversationBaseline(
  project: Project,
  sessionId: string,
): Promise<{ rowId: string | null; checkpoint: string } | null> {
  const found = await readCheckpoint(project.root, sessionId)
  if (!found) return null
  return { rowId: await rowForSession(project.id, sessionId), checkpoint: found.sha }
}

export interface ReviewDraft {
  message: string
  /**
   * The whole of `.aide/spec.md` as it should read after this change.
   *
   * Empty means the model judged that the diff earns no change to the capability
   * list, which is a normal outcome — most commits do not add or remove one.
   * Empty also means "leave the spec alone" on the way back in, so clearing the
   * box is how a human declines the suggestion.
   */
  spec: string
  /** Unchanged when the drafter saw nothing worth changing. Lets a UI say so. */
  specChanged: boolean
  model: string
  /**
   * Files the run touched that the human had ALREADY modified before it started.
   *
   * Surfaced rather than resolved, because git cannot separate two people's
   * edits inside one file and neither can aide. Committing one of these commits
   * both sets of changes, and the only honest thing to do is say so by name
   * before the button is pressed. Empty in the ordinary case, which is a run
   * that started against a clean tree.
   */
  mixed: string[]
}

/**
 * Draft the commit message and the spec update together.
 *
 * Together because they are one review: the sentence "the app can now do X" and
 * the diff that earns it should be approved in one place, or the claim outlives
 * the check. Both are drafted rather than written — the editing IS the review,
 * which is the same reason the commit message has always been a textarea.
 *
 * The two calls run in parallel: they read the same diff and neither depends on
 * the other's output, so making them sequential would double the wait.
 */
export async function draftReview(
  project: Project,
  checkpoint: string,
  request: string,
): Promise<ReviewDraft> {
  // One pass for the patch, the stat and the overlap — `runChanges` stages into
  // a scratch index to answer all three, and that staging is the expensive part.
  const changes = await runChanges(project.root, checkpoint)
  if (!changes.diff.trim()) throw new Error("nothing to commit — the run changed nothing")

  const spec = await readSpec(project)
  const [message, proposed] = await Promise.all([
    draftCommitMessage({
      model: CONFIG.helperModel,
      title: request,
      prompt: "",
      diffStat: changes.stat,
      diff: changes.diff,
      recentSubjects: await recentSubjects(project.root),
    }),
    draftSpecUpdate({ model: CONFIG.helperModel, spec, request, diffStat: changes.stat, diff: changes.diff }),
  ])

  const changed = proposed.trim() !== "" && proposed.trim() !== spec.trim()
  return {
    message,
    // Handed back empty when nothing changed, so the UI does not invite a human
    // to review a document identical to the one already on disk.
    spec: changed ? proposed : "",
    specChanged: changed,
    model: CONFIG.helperModel,
    mixed: changes.overlap,
  }
}

export interface CommitReviewOptions {
  project: Project
  sessionId: string
  rowId: string | null
  checkpoint: string
  message: string
  /** Blank or absent leaves `.aide/spec.md` exactly as it is. */
  spec?: string
}

/**
 * Write the approved spec, then commit everything the run changed as one change.
 *
 * The spec is written BEFORE the paths are computed, not after, and that
 * ordering is the whole reason the claim and the code land together: writing it
 * afterwards would leave `spec.md` dirty in the tree and absent from the commit
 * that earned it, which is the capability list describing work that is not in
 * the history.
 */
export async function commitReview(opts: CommitReviewOptions): Promise<{ sha: string }> {
  const { project, sessionId, rowId, checkpoint } = opts

  if (opts.spec?.trim()) {
    const path = specPath(project.root)
    await mkdir(dirname(path), { recursive: true })
    // Trailing newline normalised here rather than trusted from a textarea: a
    // file that gains and loses one on alternate commits makes every spec diff
    // start with a spurious hunk.
    await writeFile(path, `${opts.spec.trimEnd()}\n`, "utf8")
  }

  // Recomputed rather than carried from the draft. The draft was made when the
  // human pressed "read the diff", and the spec write above has changed the tree
  // since — committing the older path list would leave `spec.md` out of its own
  // commit.
  const changes = await runChanges(project.root, checkpoint)
  const sha = await commitRun(
    project.root,
    changes.paths,
    withRowTrailers(opts.message, rowId, sessionId),
  )
  return { sha }
}
