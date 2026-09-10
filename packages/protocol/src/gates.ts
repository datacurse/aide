/**
 * Why a project cannot take another turn, or a push, right now.
 *
 * ## Why this is here and not in the component that draws it
 *
 * These answers lived inline in `App.tsx`, computed for the ONE project the
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
 * ## What is no longer here
 *
 * There used to be a `commit` gate and a dirty-tree rule on `start` and `send`.
 * Both went with the commit button: aide commits the working tree itself when a
 * turn ends and its checks pass, so an uncommitted tree is a moment in the
 * cycle rather than a state a human has to clear — and blocking a new chat on
 * it, with no button left to press, would be the wedge this file exists to
 * prevent, built deliberately. What survives is the LOCK: one agent has the
 * checkout, and everything here says who.
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
  /**
   * The daemon's own hold — an auto-commit landing — rather than a
   * conversation's turn. A held run blocks nothing a human types: the daemon
   * QUEUES a send behind it and starts the turn when the commit releases, so a
   * padlock here would guard a door that is not locked. Committing was
   * automated precisely so nobody has to care that it is happening; a UI that
   * stops you while it does re-invents the wait it removed. Push is the one
   * exception — see below.
   */
  held?: boolean
}

export interface ProjectGates {
  /**
   * Why a chat's first turn cannot be SENT here, or null — the ▶ on a parked
   * row, and the survey button, which sends on the press.
   *
   * One rule: something has the checkout. A run writes files nobody can
   * anticipate and the rail only learns of them a poll after they land, so a
   * chat admitted beside a run in flight takes a tree that is being written
   * under it as its baseline.
   *
   * What this deliberately does NOT gate is CREATING a chat. A parked row is a
   * local record that touches nothing the lock protects, and the capture box
   * has never been gated — so a `new` button reading this rule refused an act
   * the box beside it allowed, and the workaround was to type into the box.
   * Creation is free everywhere; the lock lands where the turn is sent.
   */
  start: string | null
  /**
   * Why the push button cannot be pressed, or null. The same lock, for a
   * different reason: pushing while an agent writes — or while the auto-commit
   * that follows a turn is still landing — sends a branch whose tip is about
   * to move.
   */
  push: string | null
  /**
   * Why the message box cannot send, or null.
   *
   * A run somewhere ELSE stops every box, this one included: the daemon takes one
   * turn per project and refuses the rest, so a follow-up to the chat you are
   * reading is refused as flatly as a new one. The turn on THIS screen is not
   * that — it is the one you can interrupt rather than the one you must wait for
   * — so the holder is compared by RUN ID, and deliberately not by session as
   * well. A commit is attributed to a conversation without being that
   * conversation's turn, so "the holder's session is the open one" is true of a
   * commit still landing after its turn, and that box has to stay shut.
   *
   * The cost is a padlock for the length of one fetch when you open a chat whose
   * turn is already running — until the transcript comes back with its
   * `activeRunId` and the box becomes the interrupt. It is not a lie while it is
   * up: nothing could be sent in that moment either.
   */
  send: string | null
}

/**
 * The gates for one project.
 *
 * `held` is the wording, injected rather than written here, so the sentence a
 * lock speaks has one home in the web package (`heldBy` in `ui.tsx`) and this
 * file stays free of copy that would then exist twice.
 */
export function projectGates(opts: {
  holder: GateHolder | null
  /** The run being watched, exempt from the composer's lock. */
  openRunId?: string | null
  held: (title: string) => string
}): ProjectGates {
  const { holder, held } = opts

  // An auto-commit landing does not block a chat or a send: the daemon queues
  // the turn behind it and starts it when the commit lets go, so a lock drawn
  // here would refuse something the daemon accepts — the exact
  // block-reads-one-object-button-reads-another wedge this file exists to
  // prevent, in the polite direction.
  const blocking = holder && !holder.held ? holder : null

  const heldBySomethingElse = (mine: string | null) =>
    blocking && blocking.runId !== mine ? held(blocking.title) : null

  return {
    start: blocking ? held(blocking.title) : null,
    // The one gate a commit DOES hold: pushing while it lands sends a branch
    // whose tip is about to move.
    push: holder ? held(holder.title) : null,
    send: heldBySomethingElse(opts.openRunId ?? null),
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
