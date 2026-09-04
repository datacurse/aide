import type { ModelSpend, Project, RunDelta, RunEventBody, VerifyCheck } from "@aide/protocol"
import { planChecks } from "@aide/protocol"
import {
  commitRun,
  pushBranch,
  recentSubjects,
  treeChanges,
  withSessionTrailer,
} from "./changes.js"
import { readCheckpoint } from "./checkpoint.js"
import type { HeldTurnOutcome } from "./chat.js"
import { CONFIG } from "./config.js"
import { repoOf } from "./git.js"
import { draftCommitMessage, type Drafted } from "./helper.js"
import { runChecks, type CheckOutcome } from "./verify.js"

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
  const found = await readCheckpoint(repoOf(project), sessionId)
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
  /**
   * The project's own checks, from `.aide/project.md`. Empty means no gate.
   *
   * A FUNCTION rather than an array, because `.aide/project.md` lives in the
   * tree this commit is about to take, so the repair attempt below can rewrite
   * the gate as well as the code — and when the gate is what is broken, that is
   * the only fix there is. Held as an array, the retry re-ran the commands the
   * run started with and the fix was invisible to it: watched doing exactly
   * that, on a project whose `verify:` called `pnpm` on a host that has no
   * pnpm. The agent correctly rewrote the block to call `node_modules/.bin`
   * directly, and the gate answered by running `pnpm exec tsc -b` a second time
   * and refusing the commit again. One automatic attempt that cannot reach the
   * thing it needs to change is not an attempt.
   */
  verify: () => Promise<readonly VerifyCheck[]>
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
  /**
   * Send the branch upstream once the commit has landed.
   *
   * Chained onto this press rather than a mode, because "and send it" is a
   * decision about this change — not a property the project has. It runs after
   * the commit and only if there was one, so a refused gate cannot push.
   */
  push: boolean
  /** From `GitPending.ahead`: false means the branch has no upstream yet. */
  hasUpstream: boolean
  /**
   * One automatic attempt at whatever the checks refused, or null for none.
   *
   * Null is a real case rather than a degraded one: there is nothing to make the
   * attempt IN when the commit was pressed with no conversation open, and the
   * refusal then reads exactly as it always did.
   *
   * Exactly one attempt, and that number is the whole design. A gate that keeps
   * trying is a gate that spends your money in a loop over a failure it has
   * already shown it cannot fix; a gate that never tries hands you back a
   * typecheck error you were about to paste into the chat yourself. So: one go,
   * then the tree, the failure and the decision are yours.
   *
   * Wired by `server.ts` to `ChatLane.turnUnderHold`, which runs it as a turn in
   * the attributed conversation without giving up the project's lock.
   */
  repair: ((request: string) => Promise<HeldTurnOutcome>) | null
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
  constructor(command: string, repaired: boolean) {
    super(
      repaired
        ? `\`${command}\` still failed after one attempt at fixing it — nothing was committed`
        : `\`${command}\` failed — nothing was committed`,
    )
    this.name = "VerifyFailed"
    this.command = command
  }
}

/**
 * What the conversation is asked to do about a failing check.
 *
 * Written here rather than by the caller because the words are part of the gate:
 * they say what is about to happen either way — the checks run again the moment
 * the turn stops, and a second failure goes to the human — so the turn is not
 * left guessing how much rope it has. The instruction to change as little as
 * possible is the load-bearing one: what gets committed is the whole working
 * tree, so anything this turn touches lands with it.
 */
function repairRequest(failed: CheckOutcome): string {
  const ended =
    failed.exitCode === null ? "was killed before it finished" : `exited ${failed.exitCode}`
  return [
    `The commit was refused: \`${failed.command}\` ${ended}.`,
    "",
    "Fix it. aide runs the checks again the moment you stop and commits if they pass;",
    "if they still fail it stops and asks the human, so this is the one attempt.",
    "Change as little as you can — the commit takes the whole working tree, so",
    "anything else you touch lands with it.",
    "",
    "What it printed:",
    "",
    failed.output || "(nothing)",
  ].join("\n")
}

/**
 * A commit message for a commit whose message could not be written.
 *
 * Deliberately plain, and deliberately honest about being a fallback: this lands
 * in the project's permanent history, where a subject pretending to describe work
 * it never read would be worse than one admitting it did not. The request the
 * button was pressed from is the best evidence available without a model, so it
 * becomes the subject, and the body carries the file list the commit is actually
 * staging — which is the part a reader can check against the diff.
 *
 * The subject is cut to git's conventional 72 columns rather than left to run,
 * since `opts.request` is a chat title and nothing has ever bounded it.
 *
 * Exported for `pnpm smoke`. The path that CALLS it needs a model call to fail,
 * which the smoke repo has no way to provoke — so the function is pinned
 * directly rather than left as the one branch nothing covers.
 */
export function fallbackMessage(request: string, paths: string[]): string {
  const subject = request.trim().split("\n")[0]?.trim() || "uncommitted work"
  const cut = subject.length > 72 ? `${subject.slice(0, 71).trimEnd()}…` : subject
  return [
    cut,
    "",
    "aide could not write a message for this commit, so this one is mechanical:",
    "the subject is the request it was committed from, and the list below is what",
    "was staged. The diff is the record.",
    "",
    ...paths.map((p) => `  ${p}`),
  ].join("\n")
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
 * A failing check gets ONE automatic attempt at being fixed before you are
 * asked, and no more than one. What that replaces is a person watching a commit
 * refuse itself over a typecheck error, reading it, and typing "typecheck
 * failed, fix it" into the chat directly underneath — which is a step aide can
 * take by itself, once, and then has nothing left to add. The tree the retry
 * measures is re-read after the fix, so what is checked, what the message
 * describes and what gets staged are all the repaired tree.
 *
 * Returns what the drafting spent, because the caller is a run, and a run log
 * ends in an event saying what the run cost.
 */
export async function commitWorkingTree(
  opts: CommitWorkingTreeOptions,
): Promise<{ costUsd: number; modelUsage: Record<string, ModelSpend> }> {
  const { project, emit } = opts
  const spent = { costUsd: 0, modelUsage: {} as Record<string, ModelSpend> }

  emit({ type: "commit.step", label: "reading what is uncommitted" })
  // One pass for the patch, the stat and the paths — `treeChanges` stages into a
  // scratch index to answer all three, and that staging is the expensive part.
  let changes = await treeChanges(repoOf(project))
  if (!changes.diff.trim()) throw new Error("there is nothing uncommitted in this project")

  // BEFORE the drafting, which is the only part of a commit that costs money.
  // A tree that fails its own checks should cost the checks and nothing else —
  // and a message describing work that is about to be refused is a model call
  // spent on something nobody will read.
  //
  // Handed the paths already read above, so which checks are worth running is
  // decided from the same list the commit will stage. Reading the tree a second
  // time to answer it would let the two disagree.
  let repaired = false
  for (;;) {
    const failed = await verifyTree(opts, changes.paths)
    if (!failed) break
    if (opts.force) {
      emit({
        type: "commit.step",
        label: `committing anyway — \`${failed.command}\` failed and you asked for it`,
      })
      break
    }
    // The second failure is where this stops, and stopping is the point. What
    // the human gets is a run that says what broke, what was tried, and what is
    // still broken — and a button that will commit it anyway once they have read
    // that. `force` never repairs: a deliberate second press means "land it as
    // it is", not "have another go".
    if (!opts.repair || repaired) throw new VerifyFailed(failed.command, repaired)

    repaired = true
    emit({ type: "commit.step", label: `\`${failed.command}\` failed — asking for a fix` })
    const fix = await opts.repair(repairRequest(failed))
    add(spent, fix)
    // Said out loud, because the turn's own error events are deliberately not
    // written into this log — see `TurnRecord.nested`. Without this a fix that
    // died on an API error leaves the request in the transcript with nothing
    // whatsoever after it, and the checks below reporting the same failure as if
    // nothing had been tried.
    if (fix.status !== "success") {
      const why = fix.errors[0] ? ` — ${fix.errors[0]}` : ""
      emit({
        type: "commit.step",
        label: `the fix ${fix.status === "cancelled" ? "was stopped" : "did not finish"}${why}`,
      })
    }
    // Stopped during the fix. The agent has been interrupted, the tree is
    // whatever it got to, and re-running a ten-minute build over it is the last
    // thing anybody who just pressed stop wants.
    if (opts.stopped()) return spent

    // Re-read, because the fix rewrote the tree this was measured on. Skipping
    // it would check the old paths, draft a message from the old diff, and stage
    // a list that does not include the file the fix created.
    //
    // The GATE is re-read too, at the top of the next `verifyTree` — the fix may
    // have edited `.aide/project.md`, which is a file in this same tree. Both
    // readings have to move together or the loop measures a new tree with an old
    // ruler.
    emit({ type: "commit.step", label: "reading what is uncommitted, after the fix" })
    changes = await treeChanges(repoOf(project))
    if (!changes.diff.trim()) {
      throw new Error("the fix left nothing uncommitted — nothing was committed")
    }
  }

  emit({ type: "commit.drafting", model: CONFIG.helperModel })
  // The message is the one part of a commit that can fail for a reason that has
  // nothing to do with the work — the same argument the push below is written
  // around, and a sharper one, because this runs BEFORE the commit rather than
  // after it. A throw here threw away a tree that had already passed its checks:
  // the diff was read, the gate was run and paid for, and what the human got was
  // `Reached maximum budget ($0.5)` and no commit, from a button whose entire job
  // is to be the thing that clears the rail. A gate that can be wedged by its own
  // cosmetics has no release.
  //
  // So a failed draft degrades to a written message rather than taking the commit
  // with it. It is deliberately NOT silent — the label says the model did not
  // write it and why — because a subject line nobody chose, appearing with no
  // explanation, reads as aide having quietly stopped bothering.
  let message: Drafted
  try {
    message = await draftCommitMessage({
      model: CONFIG.helperModel,
      title: opts.request,
      prompt: "",
      diffStat: changes.stat,
      diff: changes.diff,
      recentSubjects: await recentSubjects(repoOf(project)),
      // Streamed, so this step is watched rather than waited out.
      onText: (text) => opts.delta({ kind: "text", text }),
    })
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    emit({ type: "commit.step", label: `the message could not be written — ${why}` })
    // No spend to add: a call that threw is one whose accounting never arrived.
    message = { text: fallbackMessage(opts.request, changes.paths), costUsd: 0, modelUsage: {} }
  }
  add(spent, message)

  emit({
    type: "commit.drafted",
    message: message.text,
    model: CONFIG.helperModel,
  })

  // Stop lands here or nowhere. Up to this line an interrupt costs the drafting
  // and nothing else; past it there is a commit, and stopping would mean undoing
  // history rather than declining to make it.
  if (opts.stopped()) return spent

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

  // After the commit and only if it happened, which is the whole meaning of the
  // checkbox: "and send it". A gate that refused never reaches this line, so
  // there is no path on which unreviewed work leaves the machine.
  //
  // Its failure does NOT undo the commit, and says so. A push can fail for
  // reasons that have nothing to do with the work — no network, a rejected
  // non-fast-forward, an upstream that moved — and throwing here would report a
  // commit that definitely landed as a commit that failed. The tree is clean,
  // the sha exists, and what is left is one button press.
  if (opts.push) {
    emit({ type: "commit.step", label: "pushing" })
    try {
      const { branch, pushed } = await pushBranch(repoOf(project), opts.hasUpstream)
      emit({ type: "push.landed", branch, pushed })
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      emit({
        type: "commit.step",
        label: `committed ${sha.slice(0, 7)}, but the push failed — ${why}`,
      })
    }
  }
  return spent
}

/** Fold one model call's spend into the run's total. Both are estimates. */
function add(
  into: { costUsd: number; modelUsage: Record<string, ModelSpend> },
  one: { costUsd: number; modelUsage: Record<string, ModelSpend> },
): void {
  into.costUsd += one.costUsd
  for (const [model, use] of Object.entries(one.modelUsage)) {
    const before = into.modelUsage[model]
    into.modelUsage[model] = before
      ? {
          inputTokens: before.inputTokens + use.inputTokens,
          outputTokens: before.outputTokens + use.outputTokens,
          cacheReadInputTokens: before.cacheReadInputTokens + use.cacheReadInputTokens,
          cacheCreationInputTokens:
            before.cacheCreationInputTokens + use.cacheCreationInputTokens,
          costUSD: before.costUSD + use.costUSD,
        }
      : use
  }
}

/**
 * Run the project's checks, narrate them, and say which one said no.
 *
 * Split out so the ordering above reads as one list of steps. It returns the
 * failure rather than throwing it, because the caller does not always refuse on
 * one: a commit gets a single automatic attempt at fixing what broke, and a
 * function that throws could only ever end the run.
 *
 * `force` still runs the checks — that decision lives with the caller, and this
 * is called under it. Skipping them would make the override mean "and do not
 * tell me", when what it means is "I have read this and I am landing it anyway",
 * and the log of a forced commit should say exactly what was wrong with it.
 *
 * `force` does not widen the plan either. A check the diff cannot break is not
 * evidence you are choosing to ignore; it is evidence that was never relevant.
 */
async function verifyTree(
  opts: CommitWorkingTreeOptions,
  changed: readonly string[],
): Promise<CheckOutcome | null> {
  const { emit } = opts
  // Read on every pass, not once per run: the fix may have rewritten the gate,
  // and re-reading the tree while keeping the old commands is the same mistake
  // the tree re-read exists to prevent, one level up. See `verify` on the
  // options.
  const checks = await opts.verify()
  if (checks.length === 0) return null

  const plan = planChecks(checks, changed)
  // Emitted before anything runs, so the list on screen is the whole declared
  // gate from the first moment — four rows, some of them already answered.
  for (const { command, reason } of plan.skipped) {
    emit({ type: "verify.skipped", command, reason })
  }
  if (plan.run.length === 0) return null

  const { failed } = await runChecks(plan.run.map((c) => c.command), repoOf(opts.project), {
    stopped: opts.stopped,
    // Both halves, so the transcript can draw the check while it runs rather
    // than only once it is over. A commit spends most of its wall clock in here.
    onStart: (command) => emit({ type: "verify.started", command }),
    onResult: (r) => emit({ type: "verify.result", ...r }),
  })

  // A stop mid-check reads as a failed check, and must not be reported as a
  // tree that failed its own gate — nor handed to an agent as something to go
  // and fix. The run is ending either way; let the interrupt be the reason.
  if (opts.stopped()) return null
  return failed
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
    repoOf(opts.project),
    opts.paths,
    withSessionTrailer(opts.message, opts.sessionId),
  )
}
