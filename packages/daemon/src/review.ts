import type { ModelSpend, Project, RunDelta, RunEventBody } from "@aide/protocol"
import { commitRun, recentSubjects, treeChanges, withSessionTrailer } from "./changes.js"
import { readCheckpoint } from "./checkpoint.js"
import { CONFIG } from "./config.js"
import { draftCommitMessage } from "./helper.js"
import { runChecks } from "./verify.js"

/**
 * The gate on the code: reading what is uncommitted, and committing it.
 *
 * The gate itself is unchanged in the part that matters: the agent leaves
 * everything uncommitted, and committing is a person pressing a button.
 *
 * What changed is what the button is attached to. It used to commit a
 * CONVERSATION's work, measured against that conversation's checkpoint, and so
 * it could not be pressed without one open — while the thing it exists to clear,
 * the block on starting a new chat, was measured against the whole repository.
 * A tree dirtied by anything that was not a conversation therefore blocked every
 * new chat in the project and had no button in aide that would take it: you went
 * to a terminal, which is the one thing this product exists to stop you doing.
 *
 * So a commit takes the working tree. A conversation is now only attribution —
 * the trailer, the drafter's sense of what was asked for, and the transcript the
 * run appears in — and all three are optional. What is committed is what the
 * rail shows, which is the same list the block reads, which is what makes the
 * block one you can always get out of.
 *
 * The conversation-scoped reading is still in `changes.ts` and still right for
 * what it answers: what did THIS chat change. That is a diff you go and read,
 * not a set of paths anything stages.
 *
 * What is NOT here, deliberately: a `land`. There is no branch to merge, because
 * there is no branch. The second gate moved to the verdict — see `closeChat`.
 *
 * Nor is there a draft-then-approve step any more. Reviewing a proposed commit
 * message in a panel was a gate in name only — it sat under the transcript,
 * where the thing being reviewed was already invisible — so what is left is one
 * press, watched: `commitWorkingTree` runs as a run of its own and puts every
 * step, the message it wrote, and what it staged into the transcript.
 *
 * There is no spec update here either, and its absence is deliberate. A model
 * rewriting `.aide/spec.md` whole on every commit cost more wall-clock than the
 * rest of the commit put together, went unread because agents are pointed at
 * that file rather than given it, and on one commit wrote its own reasoning
 * about not changing the file INTO the file. An agent that earns a capability
 * can write the line itself, inside the diff you already review.
 */

/**
 * The baseline a conversation's work is measured against.
 *
 * Null means no checkpoint, which is not a missing feature but a conversation
 * that has never taken a turn: the snapshot is taken before the first message
 * reaches an agent, so anything that has run has one.
 *
 * Read by the diff view only. A commit does not need one — see the header for
 * why making it need one wedged the project.
 */
export async function conversationBaseline(
  project: Project,
  sessionId: string,
): Promise<{ checkpoint: string } | null> {
  const found = await readCheckpoint(project.root, sessionId)
  if (!found) return null
  return { checkpoint: found.sha }
}

export interface CommitWorkingTreeOptions {
  project: Project
  /**
   * The conversation this commit is attributed to, or null for none.
   *
   * Attribution only: it names the trailer and picks the transcript the run
   * streams into. It does not narrow what is committed, and it is null whenever
   * the press happened with no chat open — over work an editor made, say.
   */
  sessionId: string | null
  /** What the work was asked for, so the drafter can tell intent from incident. */
  request: string
  /** The project's own checks, from `.aide/project.md`. Empty means no gate. */
  verify: readonly string[]
  /**
   * Commit even though the checks failed.
   *
   * A second, deliberate press rather than a setting, because the honest reason
   * for it is one aide cannot see: a failure that was already there before this
   * conversation started, or one the human has decided to land anyway. What it
   * must never be is the default — the whole point of the gate is that getting
   * past it is a decision somebody made.
   */
  force: boolean
  /** Progress, straight onto the conversation's event stream. */
  emit: (body: RunEventBody) => void
  /** The message as the model types it. Live only — `commit.drafted` is the record. */
  delta: (d: RunDelta) => void
  /** Whether the human has pressed stop. Read once, at the last moment it helps. */
  stopped: () => boolean
}

/**
 * Thrown when the project's own checks say no.
 *
 * Its own class because the browser has to tell this refusal from every other
 * way a commit can fail: this is the one the human can answer by pressing again,
 * and offering "commit anyway" after a git error would be offering to do
 * something that will fail the same way twice.
 */
export class VerifyFailed extends Error {
  readonly command: string
  constructor(command: string) {
    super(`\`${command}\` failed — nothing was committed`)
    this.name = "VerifyFailed"
    this.command = command
  }
}

/**
 * Commit everything uncommitted in the project, narrating as it goes.
 *
 * One press does all of it: read the diff, write a message from it, commit. The
 * narration is not decoration — the model call in the middle takes about as long
 * as a short turn, and a button that goes quiet for ten seconds gets pressed
 * again.
 *
 * The trade is worth naming, because the review gate is the product's whole
 * point: nobody reads the diff before this runs. What replaced that reading is
 * the log it leaves behind — the message a model wrote and the exact list of
 * paths it staged, in the transcript beside the rail it was pressed from. The
 * second gate is untouched: a conversation is finished when a human says so, not
 * when it is committed.
 *
 * Returns what the drafting spent, because the caller is a run, and a run log
 * ends in an event saying what the run cost.
 */
export async function commitWorkingTree(
  opts: CommitWorkingTreeOptions,
): Promise<{ costUsd: number; modelUsage: Record<string, ModelSpend> }> {
  const { project, emit } = opts

  emit({ type: "commit.step", label: "reading what is uncommitted" })
  // One pass for the patch, the stat and the paths — `treeChanges` stages into a
  // scratch index to answer all three, and that staging is the expensive part.
  const changes = await treeChanges(project.root)
  if (!changes.diff.trim()) throw new Error("there is nothing uncommitted in this project")

  // BEFORE the drafting, which is the only part of a commit that costs money.
  // A tree that fails its own checks should cost the checks and nothing else —
  // and a message describing work that is about to be refused is a model call
  // spent on something nobody will read.
  await verifyTree(opts)

  emit({ type: "commit.step", label: `writing the message · ${CONFIG.helperModel}` })
  const message = await draftCommitMessage({
    model: CONFIG.helperModel,
    title: opts.request,
    prompt: "",
    diffStat: changes.stat,
    diff: changes.diff,
    recentSubjects: await recentSubjects(project.root),
    // Streamed, so this step is watched rather than waited out.
    onText: (text) => opts.delta({ kind: "text", text }),
  })
  const spend = { costUsd: message.costUsd, modelUsage: message.modelUsage }

  emit({
    type: "commit.drafted",
    message: message.text,
    model: CONFIG.helperModel,
  })

  // Stop lands here or nowhere. Up to this line an interrupt costs the drafting
  // and nothing else; past it there is a commit, and stopping would mean undoing
  // history rather than declining to make it.
  if (opts.stopped()) return spend

  emit({ type: "commit.step", label: "committing" })
  // The paths read at the top, NOT a second reading of the tree. The checks ran
  // in between, and a check that writes — a build into a directory nobody
  // remembered to ignore — would otherwise put files into the commit that were
  // in neither the diff the message describes nor the rail you pressed from.
  const sha = await commitTree({
    project,
    sessionId: opts.sessionId,
    paths: changes.paths,
    message: message.text,
  })
  emit({ type: "commit.landed", sha, paths: changes.paths })
  return spend
}

/**
 * Run the project's checks, narrate them, and refuse the commit if one fails.
 *
 * Split out so the ordering above reads as one line. Everything interesting is
 * in what it does on failure: it throws, so `commitWorkingTree` cannot go on to
 * write history, and the results are already in the log by then — the human
 * reads what the command printed in the transcript, not in a terminal somewhere
 * else.
 *
 * `force` still runs them. Skipping the checks would make the override mean "and
 * do not tell me", when what it means is "I have read this and I am landing it
 * anyway" — and the log of a forced commit should say exactly what was wrong
 * with it at the time.
 */
async function verifyTree(opts: CommitWorkingTreeOptions): Promise<void> {
  const { emit } = opts
  if (opts.verify.length === 0) return

  const { failed } = await runChecks(opts.verify, opts.project.root, {
    stopped: opts.stopped,
    // Both halves, so the transcript can draw the check while it runs rather
    // than only once it is over. A commit spends most of its wall clock in here.
    onStart: (command) => emit({ type: "verify.started", command }),
    onResult: (r) => emit({ type: "verify.result", ...r }),
  })

  // A stop mid-check reads as a failed check, and must not be reported as a
  // tree that failed its own gate. The run is ending either way; let the
  // interrupt be the reason.
  if (opts.stopped()) return
  if (!failed) return
  if (opts.force) {
    emit({
      type: "commit.step",
      label: `committing anyway — \`${failed.command}\` failed and you asked for it`,
    })
    return
  }
  throw new VerifyFailed(failed.command)
}

export interface CommitTreeOptions {
  project: Project
  /** Attribution only; see `CommitWorkingTreeOptions`. */
  sessionId: string | null
  /**
   * What to stage, from the caller's own reading of the tree.
   *
   * Passed in rather than read here, so that the diff a human was shown and the
   * paths that get staged are one computation with nothing running in between.
   * They are not the same thing when this reads the tree for itself: the
   * project's checks run between the two, and any of them that writes lands in
   * the commit unannounced.
   */
  paths: readonly string[]
  message: string
}

/**
 * Stage exactly those paths and commit them as one change.
 *
 * Exported for `pnpm smoke`, which drives it with a message written by hand: it
 * is the half of the commit that touches git, and the only half that can be
 * checked without spending money on a model.
 */
export async function commitTree(opts: CommitTreeOptions): Promise<string> {
  return await commitRun(
    opts.project.root,
    opts.paths,
    withSessionTrailer(opts.message, opts.sessionId),
  )
}
