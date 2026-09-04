/**
 * Why a project cannot take another turn, or another commit, right now.
 *
 * ## Why this is here and not in the component that draws it
 *
 * These four answers lived inline in `App.tsx`, computed for the ONE project the
 * four panes are scoped to. That was fine while there was one. The wall draws a
 * column per project and needs the same answers for every one of them, and the
 * obvious way to get there — recompute them in the column — puts two
 * implementations of "is this project blocked" in the codebase.
 *
 * The brief has already been bitten by that shape twice, and both times the
 * symptom was a gate that could not be cleared. A block that reads one object
 * while the button that releases it reads another can wedge, and the only way out
 * of the worst one was a terminal. So the rules live in one pure function that
 * both views call, and `pnpm smoke` asserts them — which a React component cannot
 * be.
 *
 * Everything here is a SENTENCE or null, never a boolean. A dead control has to
 * be able to say what is in the way; `Button`'s `locked` prop takes exactly this,
 * and `heldBy` in `ui.tsx` is where the holder's wording lives.
 */

/**
 * Who has a project's checkout, as far as a gate is concerned.
 *
 * Structurally the daemon's `LockHolder` minus the fields no rule reads. Taken
 * as the narrow shape rather than importing the wide one so this stays testable
 * from a hand-built object, and so a new field on the wire cannot silently
 * become something a gate depends on.
 */
export interface GateHolder {
  runId: string
  title: string
}

export interface ProjectGates {
  /**
   * Why a new chat cannot be started here, or null.
   *
   * Two rules, and the ORDER of them is load-bearing. A held checkout is very
   * nearly always a dirty one too, and "commit that work first" is an instruction
   * you cannot follow while a run has the repo — the commit button is locked by
   * the same holder. Reporting the uncommitted count first sends you to a button
   * that is itself locked, which is a loop.
   *
   * The holder half is also not the uncommitted half arriving early. A run writes
   * files nobody can anticipate and the rail only learns of them a poll after they
   * land, so a chat admitted beside a run in flight takes a tree that is being
   * written under it as its baseline. Waiting for files to appear is waiting for
   * the wrong event.
   */
  start: string | null
  /**
   * Why the commit button cannot be pressed, or null.
   *
   * One reason, and it is a wait rather than a refusal: something else has the
   * checkout. Notably NOT "there is nothing to commit" — that is an empty button,
   * not a locked one, and the difference is the whole point of the padlock.
   *
   * There used to be a second reason, "open the conversation that made these
   * changes", from when a commit was measured against a chat's checkpoint. A
   * commit takes the working tree, so that was a dead button over work your own
   * editor had made, in a project the same work was blocking every new chat in.
   */
  commit: string | null
  /**
   * Why the push button cannot be pressed, or null. The same lock as a commit,
   * for a different reason: pushing while an agent writes sends a branch whose
   * tip is about to move.
   */
  push: string | null
  /**
   * Why the message box cannot send, or null.
   *
   * Both halves are held back from different chats, which is what makes this
   * different from `start` rather than a copy of it.
   *
   * A run somewhere ELSE stops every box, this one included: the daemon takes one
   * turn per project and refuses the rest, so a follow-up to the chat you are
   * reading is refused as flatly as a new one. The turn on THIS screen is not
   * that — it is the one you can interrupt rather than the one you must wait for
   * — so the holder is compared by RUN ID, and deliberately not by session as
   * well. A commit is attributed to a conversation without being that
   * conversation's turn, so "the holder's session is the open one" is true of a
   * commit you walked away from and came back to, and that box has to stay shut.
   *
   * The cost is a padlock for the length of one fetch when you open a chat whose
   * turn is already running — until the transcript comes back with its
   * `activeRunId` and the box becomes the interrupt. It is not a lie while it is
   * up: nothing could be sent in that moment either.
   *
   * Uncommitted work stops only a chat that has NOT started, because the way out
   * of it is to finish the chat that caused it. A chat whose own turn is in
   * flight is exempt for the same reason, and it has to be named separately: for
   * its first few seconds a new chat has no session id yet while its own edits
   * are already piling up in the tree.
   */
  send: string | null
}

/**
 * The four gates for one project.
 *
 * `uncommitted` is a count rather than the list, because that is all any rule
 * reads and a count is what both callers already have to hand.
 *
 * Two run ids, and they are not the same question. `commitRunId` is the commit
 * THIS view started, which must not report itself as the thing in its own way —
 * a commit holds the checkout, so a button that locked on any holder would lock
 * the instant it was pressed. `openRunId` is the turn on screen, which is the one
 * you can interrupt rather than the one you must wait for, so the composer's
 * padlock lifts for it alone.
 *
 * `held` is the wording, injected rather than written here, so the sentence a
 * lock speaks has one home in the web package (`heldBy` in `ui.tsx`) and this
 * file stays free of copy that would then exist twice.
 */
export function projectGates(opts: {
  holder: GateHolder | null
  uncommitted: number
  /** The commit this view started, exempt from its own commit/push locks. */
  commitRunId?: string | null
  /** The run being watched, exempt from the composer's lock. */
  openRunId?: string | null
  /** The open chat has a session, so the tree does not block its box. */
  started?: boolean
  /** The open chat's own turn is in flight — exempt for the same reason. */
  busy?: boolean
  held: (title: string) => string
}): ProjectGates {
  const { holder, uncommitted, held } = opts

  const heldBySomethingElse = (mine: string | null) =>
    holder && holder.runId !== mine ? held(holder.title) : null

  // Any holder at all. What blocks a NEW chat is the lock existing, including a
  // commit this very view started: the daemon refuses a fresh turn under any
  // holder, so exempting our own would offer a button the daemon then turns away.
  const anyHolder = holder ? held(holder.title) : null

  const dirty = (remedy: string) =>
    uncommitted > 0
      ? `${uncommitted} uncommitted file${uncommitted === 1 ? "" : "s"}${remedy}`
      : null

  // Holder FIRST, always. A held checkout is very nearly always a dirty one too,
  // and the remedy for dirt is a commit button that this same holder has locked.
  return {
    start: anyHolder ?? dirty(" — commit that work before starting another chat."),
    commit: heldBySomethingElse(opts.commitRunId ?? null),
    push: heldBySomethingElse(opts.commitRunId ?? null),
    send:
      heldBySomethingElse(opts.openRunId ?? null) ??
      (opts.started === true || opts.busy === true
        ? null
        : dirty(
            " in this project. Press commit in the rail on the right — it takes all of them, whether or not a chat made them.",
          )),
  }
}

/**
 * Which columns the wall draws, given the set a human has hidden.
 *
 * Pure, and here rather than in the hook for the reason this file already
 * exists: the hook imports React and so cannot be reached from Node, and these
 * are the rules whose failures are quiet rather than loud. `mergedMode` was
 * lifted into protocol on exactly this argument.
 *
 * The rule that matters is that the two returned halves PARTITION the projects.
 * The wall draws one and counts the other, so anything that lets them disagree
 * puts a number in the header that does not match the columns missing from the
 * page — and the number is the only thing telling you a project was hidden at
 * all. Two ways that happens, both silent:
 *
 *  - a duplicate id in the stored list, which a naive count of the list itself
 *    reports as two hidden columns for one missing column;
 *  - an id for a project that has since been FORGOTTEN, which counts a column
 *    that cannot come back — "1 hidden" that restores nothing when pressed.
 *
 * Counting what is actually absent from `shown`, rather than the size of the
 * stored set, is what makes both cases impossible instead of merely unlikely.
 */
export function splitHiddenColumns<T extends { id: string }>(
  projects: readonly T[],
  hiddenIds: readonly string[],
): { shown: T[]; hiddenCount: number } {
  const hidden = new Set(hiddenIds)
  const shown = projects.filter((p) => !hidden.has(p.id))
  return { shown, hiddenCount: projects.length - shown.length }
}

/**
 * Add an id to the hidden set, without letting it appear twice.
 *
 * Re-hiding an already-hidden project is reachable — two tabs, or a stored value
 * edited by hand — and an unguarded append is what puts a duplicate in the list
 * that `splitHiddenColumns` then has to be careful about. Guarding both ends is
 * deliberate: this keeps the stored value clean, and the split stays correct
 * even for a value this function never wrote.
 */
export const withHidden = (hiddenIds: readonly string[], projectId: string): string[] =>
  hiddenIds.includes(projectId) ? [...hiddenIds] : [...hiddenIds, projectId]
