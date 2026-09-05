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
 * Rows that are the DERIVATION: everything the agent did on the way to an
 * answer. All of it folds.
 *
 * The first version asked instead whether a given block of prose was narration,
 * by LENGTH — under 120 characters folded, over it broke the run. That was the
 * wrong instrument, and the failure is worth keeping because it looked like a
 * near miss rather than a wrong idea. Length does not distinguish narration from
 * conclusion: a mid-turn paragraph explaining what a check printed is long AND
 * is derivation, so every one of them ended a run. What came out was a dozen
 * small folds separated by prose — "6 steps", two paragraphs, "4 steps" — which
 * is the transcript with extra clicks in it, not a summary of one.
 *
 * What actually marks the answer is POSITION, not size: it is the last thing the
 * turn says. So the rule inverted — instead of asking which prose is narration,
 * fold everything and keep the final block out. See `foldRows`.
 */
const DERIVATION = new Set(["tool", "thinking", "text"])

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
}

/**
 * A folded row, or a row that was left alone.
 *
 * A discriminated result rather than a mutated list, so the caller decides what
 * a group renders as and this file never grows a view.
 */
export type Folded<T> = { folded: false; row: T } | { folded: true; group: FoldGroup<T> }

/**
 * Fold a turn's derivation into one openable row, leaving the answer out.
 *
 * The shape this produces is the whole point: ONE fold, then the closing prose.
 * Not a fold per burst of tool calls — that was the first version, and against a
 * real transcript it produced a dozen small folds with paragraphs between them,
 * which is more rows to look at than it removed.
 *
 * `liveTail` says the turn is still being written. There is no answer yet — the
 * prose arriving now is not a conclusion, it is the turn in progress — and the
 * tool rows are the only thing on screen saying it is going somewhere, so
 * nothing folds until it is over. That is the working bar's argument again.
 */
export function foldRows<T extends FoldableRow>(rows: T[], liveTail = true): Folded<T>[] {
  // The answer is the LAST block of prose in the log — everything after it is
  // structural (the outcome line, a checkpoint) and everything before it is how
  // the agent got there. Found first, because the fold below is defined by where
  // it is rather than by any property of the rows themselves.
  //
  // A live turn has no answer yet: the prose still being typed is the last block
  // there is, and treating it as the conclusion would fold the tool rows that are
  // the only thing on screen saying the turn is progressing.
  let answer = -1
  if (!liveTail) {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i]?.kind === "text") {
        answer = i
        break
      }
    }
  }

  const out: Folded<T>[] = []
  // ONE list, in the order the rows arrived. Accumulating calls and asides
  // separately and re-joining them on flush is what reordered the transcript —
  // see `FoldGroup`.
  let run: T[] = []

  const flush = () => {
    if (run.length >= FOLD_FROM) {
      out.push({
        folded: true,
        group: {
          rows: run,
          steps: run.filter((r) => r.kind === "tool"),
          asides: run.filter((r) => r.kind !== "tool"),
        },
      })
    } else {
      for (const r of run) out.push({ folded: false, row: r })
    }
    run = []
  }

  rows.forEach((row, i) => {
    // Everything on the way to the answer folds together, whatever it is and
    // however long it is — calls, reasoning, and the prose between them. One
    // fold per turn is the whole point: a dozen small ones separated by
    // paragraphs is the transcript with extra clicks in it.
    if (i < answer && DERIVATION.has(row.kind)) {
      run.push(row)
      return
    }
    // Anything else — the answer, the outcome, a checkpoint, a permission
    // prompt — ends the run and stands on its own.
    flush()
    out.push({ folded: false, row })
  })
  flush()
  return out
}
