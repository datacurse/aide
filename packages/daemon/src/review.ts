import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { ModelSpend, Project, RunDelta, RunEventBody } from "@aide/protocol"
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
 * The gate itself is unchanged in the part that matters: the agent leaves
 * everything uncommitted, and committing is a person pressing a button. What
 * changed underneath is what "the diff" means.
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
 *
 * Nor is there a draft-then-approve step any more. Reviewing a proposed commit
 * message in a panel was a gate in name only — it sat under the transcript,
 * where the thing being reviewed was already invisible — so what is left is one
 * press, watched: `commitConversation` runs as a run of its own and puts every
 * step, the message it wrote, and what it staged into the conversation. You read
 * it in the same place you read everything else about this work.
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

export interface CommitConversationOptions {
  project: Project
  sessionId: string
  rowId: string | null
  checkpoint: string
  /** What the row asked for, so the drafter can tell intent from incident. */
  request: string
  /** Progress, straight onto the conversation's event stream. */
  emit: (body: RunEventBody) => void
  /** The message as the model types it. Live only — `commit.drafted` is the record. */
  delta: (d: RunDelta) => void
  /** Whether the human has pressed stop. Read once, at the last moment it helps. */
  stopped: () => boolean
}

/**
 * Commit everything this conversation changed, narrating as it goes.
 *
 * One press does all of it: read the diff, draft the message and the spec update
 * from it, write both. The narration is not decoration — the two model calls in
 * the middle take about as long as a short turn, and a button that goes quiet
 * for fifteen seconds gets pressed again.
 *
 * The trade is worth naming, because the review gate is the product's whole
 * point: nobody reads the diff before this runs. What replaced that reading is
 * the log it leaves behind — the message a model wrote and the exact list of
 * paths it staged, in the conversation that produced them. The second gate is
 * untouched: the row closes when a human says the work is done, not when it is
 * committed.
 *
 * Returns what the drafting spent, because the caller is a run, and a run log
 * ends in an event saying what the run cost.
 */
export async function commitConversation(
  opts: CommitConversationOptions,
): Promise<{ costUsd: number; modelUsage: Record<string, ModelSpend> }> {
  const { project, emit } = opts

  emit({ type: "commit.step", label: "reading what this conversation changed" })
  // One pass for the patch, the stat and the overlap — `runChanges` stages into
  // a scratch index to answer all three, and that staging is the expensive part.
  const changes = await runChanges(project.root, opts.checkpoint)
  if (!changes.diff.trim()) throw new Error("this conversation has not changed anything")

  // Named rather than resolved, and named in the log rather than in a dialog
  // beforehand: git cannot separate two people's edits inside one file, so
  // committing one of these commits both. Nothing can be done about that. What
  // can be done is writing down which files it happened to, somewhere it stays
  // readable after the fact.
  if (changes.overlap.length > 0) {
    emit({
      type: "commit.step",
      label: `taking your own earlier edits to ${changes.overlap.join(", ")} with it`,
    })
  }

  emit({
    type: "commit.step",
    label: `drafting the message and the spec update · ${CONFIG.helperModel}`,
  })
  const spec = await readSpec(project)
  /**
   * The half that finishes first says so, and only it.
   *
   * These two calls take about as long as each other but never exactly, and
   * whichever lands first leaves the screen still for the remainder — which is
   * the whole complaint this narration exists to answer. The one that lands
   * second says nothing: by then the drafted message is on its way and there is
   * nothing left to be waiting for.
   */
  let outstanding = 2
  const landed = (label: string) => {
    outstanding -= 1
    if (outstanding > 0) emit({ type: "commit.step", label })
  }
  // In parallel: they read the same diff and neither depends on the other's
  // output, so making them sequential would double the wait.
  const [message, proposed] = await Promise.all([
    draftCommitMessage({
      model: CONFIG.helperModel,
      title: opts.request,
      prompt: "",
      diffStat: changes.stat,
      diff: changes.diff,
      recentSubjects: await recentSubjects(project.root),
      // Only this one streams. The spec call returns a whole file, mostly
      // unchanged, and the two arriving down one channel at once would
      // interleave into nonsense — so what you watch being written is the
      // message, which is the half worth reading.
      onText: (text) => opts.delta({ kind: "text", text }),
    }).then((r) => {
      landed("message written · still on the spec update")
      return r
    }),
    draftSpecUpdate({
      model: CONFIG.helperModel,
      spec,
      request: opts.request,
      diffStat: changes.stat,
      diff: changes.diff,
    }).then((r) => {
      landed("spec update drafted · still writing the message")
      return r
    }),
  ])
  const spend = {
    costUsd: message.costUsd + proposed.costUsd,
    modelUsage: mergeSpend(message.modelUsage, proposed.modelUsage),
  }

  // An unchanged spec is a normal outcome — most commits add no capability — and
  // it means "leave the file alone" rather than "write this back".
  const specChanged = proposed.text.trim() !== "" && proposed.text.trim() !== spec.trim()
  emit({
    type: "commit.drafted",
    message: message.text,
    model: CONFIG.helperModel,
    specChanged,
  })

  // Stop lands here or nowhere. Up to this line an interrupt costs the drafting
  // and nothing else; past it there is a commit, and stopping would mean undoing
  // history rather than declining to make it.
  if (opts.stopped()) return spend

  emit({ type: "commit.step", label: "committing" })
  const { sha, paths } = await commitReview({
    project,
    sessionId: opts.sessionId,
    rowId: opts.rowId,
    checkpoint: opts.checkpoint,
    message: message.text,
    ...(specChanged ? { spec: proposed.text } : {}),
  })
  emit({ type: "commit.landed", sha, paths })
  return spend
}

/** Two calls against the same model come back as two records under one key. */
function mergeSpend(
  a: Record<string, ModelSpend>,
  b: Record<string, ModelSpend>,
): Record<string, ModelSpend> {
  const out: Record<string, ModelSpend> = { ...a }
  for (const [model, u] of Object.entries(b)) {
    const prev = out[model]
    out[model] = prev
      ? {
          inputTokens: prev.inputTokens + u.inputTokens,
          outputTokens: prev.outputTokens + u.outputTokens,
          cacheReadInputTokens: prev.cacheReadInputTokens + u.cacheReadInputTokens,
          cacheCreationInputTokens: prev.cacheCreationInputTokens + u.cacheCreationInputTokens,
          costUSD: prev.costUSD + u.costUSD,
        }
      : u
  }
  return out
}

export interface CommitReviewOptions {
  project: Project
  sessionId: string
  rowId: string | null
  checkpoint: string
  message: string
  /** Absent leaves `.aide/spec.md` exactly as it is, which is the common case. */
  spec?: string
}

/**
 * Write the spec, then commit everything the run changed as one change.
 *
 * The spec is written BEFORE the paths are computed, not after, and that
 * ordering is the whole reason the claim and the code land together: writing it
 * afterwards would leave `spec.md` dirty in the tree and absent from the commit
 * that earned it, which is the capability list describing work that is not in
 * the history.
 *
 * The paths come back out because they are the answer to "what did that button
 * take", and this is the only place that knows.
 *
 * Exported for `pnpm smoke`, which drives it with a message and a spec written
 * by hand: it is the half of the commit that touches git, and the only half that
 * can be checked without spending money on a model.
 */
export async function commitReview(
  opts: CommitReviewOptions,
): Promise<{ sha: string; paths: string[] }> {
  const { project, sessionId, rowId, checkpoint } = opts

  if (opts.spec?.trim()) {
    const path = specPath(project.root)
    await mkdir(dirname(path), { recursive: true })
    // Trailing newline normalised here rather than trusted from the model: a
    // file that gains and loses one on alternate commits makes every spec diff
    // start with a spurious hunk.
    await writeFile(path, `${opts.spec.trimEnd()}\n`, "utf8")
  }

  // Recomputed rather than carried from the read that produced the message: the
  // spec write above has changed the tree since, and committing the older path
  // list would leave `spec.md` out of its own commit.
  const changes = await runChanges(project.root, checkpoint)
  const sha = await commitRun(
    project.root,
    changes.paths,
    withRowTrailers(opts.message, rowId, sessionId),
  )
  return { sha, paths: changes.paths }
}
