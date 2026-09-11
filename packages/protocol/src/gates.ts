/**
 * Why a project cannot take another turn, or a push, right now.
 *
 * ## Why this is here and not in the component that draws it
 *
 * These answers lived inline in `App.tsx`, computed for the ONE project the four
 * panes are scoped to. They were lifted out when a second view needed the same
 * answers per project, and they stay out now that it is gone: the alternative is
 * recomputing them wherever they are next wanted, which puts two implementations
 * of "is this project blocked" in the codebase.
 *
 * The brief has already been bitten by that shape twice, and both times the
 * symptom was a gate that could not be cleared. A block that reads one object
 * while the button that releases it reads another can wedge, and the only way out
 * of the worst one was a terminal. So the rules live in one pure function every
 * caller shares, and `pnpm smoke` asserts them — which a React component cannot
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

/**
 * The holder a surface may DRAW, which is not the holder the gates read.
 *
 * A commit is a run — it has a run id, it holds the checkout, and `holderFor`
 * reports it — so every surface that drew "something is running here" off the
 * lock drew the auto-commit too. That is the one thing committing was automated
 * to stop doing. The rail pulsed a dot, named the run `committing what is
 * uncommitted` in `text-info` and swapped `forget` for a padlock; the chat list
 * turned the chat the commit is ATTRIBUTED to into a spinning dial with a clock
 * on it. Nobody asked for any of it, nothing waits on it, and a send is queued
 * rather than refused underneath it — so what the human sees is the work
 * apparently still going, on a chat that answered a minute ago, with a lock over
 * a button that did not need one.
 *
 * `liveCommit.ts` already says this for the conversation pane ("nothing about it
 * is drawn while it is in flight") and `projectGates` already says it for the
 * controls. This is the same sentence for everything that draws the lock, in one
 * place for the reason the rest of this file is in one place: the rule was
 * written twice and the two surfaces that never got it are the ones in the
 * screenshot.
 *
 * The gates deliberately do NOT read this. `push` is blocked by a commit and
 * must stay blocked — its tip is about to move — and it is the one control whose
 * refusal is allowed to name a commit, because there a commit really is in the
 * way.
 *
 * Generic over the holder rather than taking `GateHolder`, so a caller gets its
 * own type back and the SAME object: the chat list depends on that identity —
 * it extracts primitives off the holder precisely to avoid re-sorting on every
 * poll, and a defensive copy here would restore the churn. The constraint is
 * `object` rather than `{ held?: boolean }` because a `held`-less holder is a
 * real case (a daemon older than the field), and against the narrower bound TS
 * rejects one outright as having no properties in common.
 */
export function visibleHolder<T extends object>(holder: T | null): T | null {
  return holder && (holder as { held?: boolean }).held ? null : holder
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

