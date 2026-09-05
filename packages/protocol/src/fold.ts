/**
 * Which rows of a transcript travel together as one openable step.
 *
 * The rule lives here rather than in `Transcript.tsx` for the reason
 * `activity-line.ts` and `gates.ts` do: it is pure, the ways it fails are
 * invisible to the compiler, and a React component cannot be asserted by
 * `pnpm smoke`. A fold that quietly drops a row still type-checks and still
 * renders — it just shows you less than happened, which is the one thing this
 * must never do.
 *
 * It is deliberately structural. The caller passes anything with a `kind` and,
 * for prose, a `text`; nothing here knows what a `ToolLine` is, so the web
 * package keeps its own row types and this stays testable from Node.
 */

/**
 * Below this many rows, folding costs more than it saves: the fold and the rows
 * it replaces are the same height, so you have traded readable lines for one
 * that has to be opened.
 */
export const FOLD_FROM = 2

/**
 * Rows that are the DERIVATION: everything the agent does on the way to an
 * answer. All of it folds.
 *
 * `text` is in here, which is the counter-intuitive one and the whole reason the
 * fold works. An earlier version asked whether a given block of prose was
 * narration by LENGTH — under 120 characters folded, over it did not — and that
 * is the wrong instrument: a mid-turn paragraph explaining what a check printed
 * is long AND is derivation. Prose is not special. Only its POSITION is, and
 * `foldRows` decides that once per turn.
 */
const DERIVATION = new Set(["tool", "thinking", "text"])

/**
 * The rows a commit is made of.
 *
 * A commit is a RUN — a checkpoint, some checks, a drafted message, the commit
 * itself, maybe a push — but nothing on screen said so: those six row kinds were
 * peers of every other row, so a commit began and ended wherever you guessed it
 * did, and the message box in the middle of it spent a dozen lines printing text
 * nobody typed. It was the single largest thing in a transcript and the least
 * re-read.
 *
 * So it collapses like a turn's derivation does, into one row that names its
 * outcome — the sha, the file count — with everything else an expand away.
 * `commit-landed` and `push-landed` are inside the fold rather than out: they
 * are what the closed row is BUILT from, so leaving them beside it would print
 * the same sha twice.
 */
const COMMIT = new Set([
  "commit-step",
  "commit-message",
  "commit-landed",
  "push-landed",
  "verify",
  "verify-skipped",
])

/** The least a row has to be for the fold to have an opinion about it. */
export interface FoldableRow {
  kind: string
  text?: string
}

/**
 * One group: the calls, the narration between them, and the original order.
 *
 * `rows` is the whole run as it happened — that is what an opened fold renders,
 * and keeping it is the difference between hiding rows and rewriting them.
 * `steps` and `asides` are views onto it for the closed row's label, which counts
 * calls and does not care where the prose sat.
 *
 * They were once two separate lists with no `rows`, and re-joining them on open
 * put every aside after every call: `Grep, Bash, "Clean.", Read` opened as
 * `Grep, Bash, Read, "Clean."`. The count was right, so nothing looked missing —
 * it just claimed the agent had said "Clean." about work it had not done yet.
 */
export interface FoldGroup<T> {
  rows: T[]
  steps: T[]
  asides: T[]
  /**
   * This group is a COMMIT rather than a turn's derivation.
   *
   * Two kinds of fold, deliberately one mechanism: they collapse for the same
   * reason and must expand with the same gesture, and a second implementation
   * would be a second set of edge cases around the same list.
   */
  commit?: boolean
}

/**
 * A folded row, or a row that was left alone.
 *
 * A discriminated result rather than a mutated list, so the caller decides what
 * a group renders as and this file never grows a view.
 */
export type Folded<T> = { folded: false; row: T } | { folded: true; group: FoldGroup<T> }

/**
 * Fold each turn's derivation into one openable row, leaving its answer out.
 *
 * The unit is the TURN, and that is the whole design: a question you asked opens
 * a fold, everything the agent did in reply goes into it, and the last thing it
 * said comes back out as the answer. One fold and one answer per thing you
 * asked for, however long the turn ran and whatever it did in the middle.
 *
 * Two earlier rules are worth keeping as the reason this one is shaped like it
 * is, because both looked reasonable and both produced a transcript that folded
 * in places nobody could predict.
 *
 * (1) By CONSECUTIVE TOOL CALLS. Every paragraph between two calls ended a run,
 * so a turn came out as a dozen small folds with prose between them — more rows
 * to look at than it removed.
 *
 * (2) By the LAST PROSE BLOCK in the log, with a live turn folding nothing. That
 * fixed the fragmentation and introduced a moving boundary: while a turn ran the
 * fold covered whatever had happened so far and the newest rows hung outside it,
 * so the split point crept down the screen as the turn went. Watched doing it —
 * `28 steps` with two running calls and a paragraph below them, then `31 steps`
 * a moment later. Nothing was wrong with any single frame; it just meant the
 * reader could not learn where the boundary was, because it was never in the
 * same place twice.
 *
 * The fix is to stop deriving the boundary from CONTENT and take it from
 * STRUCTURE. A user message is an unambiguous, already-recorded fact about where
 * a turn begins, so the fold opens there and the only question left is which row
 * ends it — which is answered once, when the turn is over.
 *
 * `live` says the last turn is still being written. Its derivation still folds
 * from the user message down; what it does NOT do is guess at an answer, since
 * the prose arriving now is the turn in progress rather than its conclusion.
 */
export function foldRows<T extends FoldableRow>(rows: T[], live = true): Folded<T>[] {
  // Where each turn starts: the row after a user message. A transcript that
  // opens mid-conversation — the wall tails one — has no user row at the top, so
  // index 0 starts a turn too, or the first turn on screen would never fold.
  const starts: number[] = []
  rows.forEach((row, i) => {
    if (row.kind === "user") starts.push(i + 1)
  })
  if (starts[0] !== 0) starts.unshift(0)

  const out: Folded<T>[] = []

  const flush = (run: T[], commit = false) => {
    // A commit folds from the FIRST row, not from `FOLD_FROM`. Even a one-check
    // commit is a distinct episode with a beginning and an end, and the point of
    // collapsing it is to draw that boundary — a lone `committed a1b2c3d` left
    // loose in the transcript is exactly the unmarked row this exists to stop.
    if (run.length >= (commit ? 1 : FOLD_FROM)) {
      out.push({
        folded: true,
        group: {
          rows: run,
          steps: run.filter((r) => r.kind === "tool"),
          asides: run.filter((r) => r.kind !== "tool"),
          ...(commit ? { commit: true } : {}),
        },
      })
    } else {
      for (const r of run) out.push({ folded: false, row: r })
    }
  }

  for (let s = 0; s < starts.length; s++) {
    const from = starts[s] ?? 0
    // Up to the next user message, or the end of the log.
    const to = s + 1 < starts.length ? (starts[s + 1] ?? rows.length) - 1 : rows.length
    if (from > 0 && rows[from - 1]?.kind === "user") {
      out.push({ folded: false, row: rows[from - 1] as T })
    }

    const turn = rows.slice(from, to)
    if (turn.length === 0) continue

    // The answer is the last prose block of a FINISHED turn. The final turn of a
    // live transcript has not got one yet, so everything it has done so far
    // folds and the fold simply grows — which is the stable thing to do, because
    // the boundary above it never moves.
    const settled = !live || s + 1 < starts.length
    let answer = -1
    if (settled) {
      for (let i = turn.length - 1; i >= 0; i--) {
        if (turn[i]?.kind === "text") {
          answer = i
          break
        }
      }
    }

    // Everything from the question to the answer folds, whatever it is: calls,
    // reasoning, and the prose in between. A row that is neither derivation nor
    // the answer — an outcome line, a checkpoint, a permission prompt — is
    // structural and stands on its own wherever it falls.
    //
    // A commit accumulates into its OWN run alongside that one. The two never
    // merge: a commit is an episode with its own start and end, and folding it
    // in with the work that preceded it is what left it unmarked in the first
    // place. Whichever run a row does not belong to is flushed as it starts, so
    // their order on screen is the order they happened in.
    let run: T[] = []
    let commit: T[] = []
    turn.forEach((row, i) => {
      if (COMMIT.has(row.kind)) {
        flush(run)
        run = []
        commit.push(row)
        return
      }
      flush(commit, true)
      commit = []
      if (i !== answer && DERIVATION.has(row.kind)) {
        run.push(row)
        return
      }
      flush(run)
      run = []
      out.push({ folded: false, row })
    })
    flush(run)
    flush(commit, true)
  }
  return out
}
