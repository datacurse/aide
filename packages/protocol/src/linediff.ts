/**
 * Two versions of a block of text, as one list of lines marked kept, added or
 * removed.
 *
 * An Edit card used to draw `old_string` and `new_string` whole, side by side,
 * and left the reader to find the difference by eye — which for a fifty-line
 * edit whose change is three lines is most of the card spent on text that did
 * not change, twice. This is the reading every diff tool gives instead: shared
 * lines once as context, and only what actually moved marked.
 *
 * In protocol rather than in the web package for the reason `fold.ts` and
 * `tool-timeline.ts` are: it is pure, every way it fails is invisible to the
 * compiler and quiet on screen — a line attributed to the wrong side reads as
 * a change that never happened — and a React component cannot be asserted by
 * `pnpm smoke`.
 *
 * Plain LCS over whole lines, no dependency. A word-level diff inside a
 * changed line is the obvious next step and is deliberately not here: at 11px
 * in a card, per-word tinting inside syntax-coloured code is two colour
 * systems fighting over the same glyphs.
 */

export type DiffTag = "keep" | "add" | "del"

export interface DiffLine {
  tag: DiffTag
  text: string
}

/**
 * Above this many lines on either side, the quadratic table is skipped and the
 * two blocks are reported as one wholesale replacement.
 *
 * The table is `old × new` cells; at 2000 a side that is four million, which
 * is both slow and pointless — nobody reads a four-thousand-line diff in a
 * card. The fallback is what the card drew before this existed, so the
 * degraded case is the old behaviour rather than an error.
 */
const MAX_LINES = 2000

/**
 * The classic LCS table. `keep` is emitted for lines present in both, in
 * order; everything else is a `del` from the old side or an `add` from the
 * new one.
 *
 * Deletions are emitted BEFORE insertions at the same position, so a changed
 * line reads old-then-new the way every diff tool prints it.
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split("\n")
  const b = newText.split("\n")

  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [
      ...a.map((text): DiffLine => ({ tag: "del", text })),
      ...b.map((text): DiffLine => ({ tag: "add", text })),
    ]
  }

  // lcs[i][j] = length of the longest common subsequence of a[i…] and b[j…].
  // Built from the end so the walk below can go forwards, which is what keeps
  // the output in source order without a reverse at the end.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  )
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j]
          ? (lcs[i + 1]![j + 1] ?? 0) + 1
          : Math.max(lcs[i + 1]![j] ?? 0, lcs[i]![j + 1] ?? 0)
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ tag: "keep", text: a[i] ?? "" })
      i++
      j++
      // A tie goes to the DELETION, which is what puts the old line above the
      // new one on a changed line. Taking the insertion first is equally
      // optimal as a subsequence and reads backwards.
    } else if ((lcs[i + 1]![j] ?? 0) >= (lcs[i]![j + 1] ?? 0)) {
      out.push({ tag: "del", text: a[i] ?? "" })
      i++
    } else {
      out.push({ tag: "add", text: b[j] ?? "" })
      j++
    }
  }
  while (i < a.length) out.push({ tag: "del", text: a[i++] ?? "" })
  while (j < b.length) out.push({ tag: "add", text: b[j++] ?? "" })
  return out
}

/**
 * Runs of unchanged lines longer than `context * 2 + 1` collapse to a marker.
 *
 * A `null` entry stands for the lines hidden at that point — the caller draws
 * it as a rule with a count, the way `ShellOutput` draws the daemon's own
 * elision. Kept separate from `diffLines` so the diff itself stays a pure
 * mapping of the two inputs and this stays a presentation choice.
 */
export type DiffRow = DiffLine | { tag: "gap"; hidden: number }

/**
 * A changed line split into the spans that moved and the spans that did not.
 *
 * When a line changes by one identifier, a diff that only says "this line
 * left, this line arrived" makes the reader compare two nearly-identical
 * lines character by character — which is the work side-by-side was really
 * being asked to do. Marking the span that actually moved answers it
 * directly.
 *
 * `same` spans are drawn DIMMED rather than the changed span tinted: the
 * code underneath already carries syntax colour, and a third colour over the
 * changed words would be two systems fighting for the same glyphs. Dimming
 * what did not change leaves the highlight to be the absence of dimming.
 */
export interface WordSpan {
  text: string
  changed: boolean
}

/**
 * Word-ish tokens: runs of identifier characters, and everything else one
 * character at a time. Splitting on whitespace alone makes `foo(bar)` a
 * single token, so changing `bar` marks the whole call; splitting per
 * character makes every shared letter a span and the line a mosaic. This is
 * the middle that reads.
 */
const tokenize = (s: string): string[] => s.match(/[A-Za-z0-9_$]+|\s+|[^A-Za-z0-9_$\s]/g) ?? []

/**
 * How much of a line must survive for word-level marking to be worth it.
 *
 * Measured against the SHORTER line, and this is the whole of the rule.
 * Against the longer one, a short line whose words all appear somewhere in a
 * long one scores highly — so two unrelated sentences that happen to share a
 * clause paired up, and the card drew a mostly-dimmed line whose bright
 * fragments were scattered noise. Against the shorter line the question
 * becomes the right one: is one of these lines mostly a rewrite of the
 * other? A reflowed paragraph, where every line shares most of its words
 * with a DIFFERENT line, is exactly the case this rejects.
 *
 * 0.6 rather than 0.3 for the same reason: at a third shared, the marking is
 * already a mosaic that says less than the plain +/- pair.
 */
const MIN_SHARED = 0.6

/**
 * How lopsided two lines may be and still be a rewrite of each other.
 *
 * A line whose text is wholly contained in a much longer one shares 100% of
 * itself and is still not the same line — the reflowed-paragraph case, where
 * every line shares most of its words with a DIFFERENT line and the card drew
 * mostly-dimmed noise. Half the length is the cutoff: an edit that doubles a
 * line's length has changed more than it kept.
 */
const MIN_LENGTH_RATIO = 0.5

/** Longest common subsequence over tokens, as spans. Null when too dissimilar. */
export function pairWords(oldLine: string, newLine: string): {
  left: WordSpan[]
  right: WordSpan[]
} | null {
  const a = tokenize(oldLine)
  const b = tokenize(newLine)
  if (a.length === 0 || b.length === 0) return null
  // The same quadratic table as `diffLines`, over tokens of one line. Lines
  // are short, so the guard is generous and only exists to stop a pathological
  // minified line from costing a frame.
  if (a.length > 400 || b.length > 400) return null

  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  )
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j]
          ? (lcs[i + 1]![j + 1] ?? 0) + 1
          : Math.max(lcs[i + 1]![j] ?? 0, lcs[i]![j + 1] ?? 0)
    }
  }

  // Shared material measured in CHARACTERS, not tokens: ten shared spaces and
  // one shared identifier are not the same amount of "this line survived".
  let sharedChars = 0
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] === b[j]) {
      sharedChars += (a[i] ?? "").length
      i++
      j++
    } else if ((lcs[i + 1]![j] ?? 0) >= (lcs[i]![j + 1] ?? 0)) i++
    else j++
  }
  const shorter = Math.min(oldLine.trim().length, newLine.trim().length)
  const longer = Math.max(oldLine.trim().length, newLine.trim().length)
  if (shorter === 0) return null
  // Two guards, because one ratio cannot say both things. `shorter` asks
  // whether the surviving material is most of the smaller line — the mosaic
  // test. `longer` asks whether these are even comparable lengths: a short
  // line WHOLLY CONTAINED in a long one scores 1.0 on the first test and is
  // still not a rewrite of it, which is how two unrelated sentences sharing
  // a clause paired up and drew a mostly-dimmed line of scattered fragments.
  if (sharedChars / shorter < MIN_SHARED) return null
  if (shorter / longer < MIN_LENGTH_RATIO) return null

  const left: WordSpan[] = []
  const right: WordSpan[] = []
  // Consecutive spans of the same kind are merged as they are pushed, so a
  // renderer gets one element per readable run rather than one per token.
  const push = (into: WordSpan[], text: string, changed: boolean) => {
    const last = into[into.length - 1]
    if (last && last.changed === changed) last.text += text
    else into.push({ text, changed })
  }
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push(left, a[i] ?? "", false)
      push(right, b[j] ?? "", false)
      i++
      j++
    } else if ((lcs[i + 1]![j] ?? 0) >= (lcs[i]![j + 1] ?? 0)) {
      push(left, a[i++] ?? "", true)
    } else {
      push(right, b[j++] ?? "", true)
    }
  }
  while (i < a.length) push(left, a[i++] ?? "", true)
  while (j < b.length) push(right, b[j++] ?? "", true)
  return { left, right }
}

/**
 * One row of a SPLIT view: what sits on the left, and what sits on the right.
 *
 * The same diff as `DiffRow`, paired for two columns. A changed stretch is a
 * run of deletions beside a run of insertions, zipped index by index — three
 * lines out against one line in gives three rows, two of them with nothing on
 * the right, so the columns stay aligned however lopsided the change is.
 * Pairing here rather than in the renderer for the same reason the diff
 * itself is here: an off-by-one in the zip puts a deletion next to the wrong
 * insertion, which reads as a change nobody made and is invisible to `tsc`.
 */
export type SplitRow =
  | { tag: "keep"; text: string }
  | { tag: "change"; left: string | null; right: string | null }
  | { tag: "gap"; hidden: number }

export function splitRows(rows: readonly DiffRow[]): SplitRow[] {
  const out: SplitRow[] = []
  let i = 0
  while (i < rows.length) {
    const row = rows[i]!
    if (row.tag === "gap") {
      out.push(row)
      i++
      continue
    }
    if (row.tag === "keep") {
      out.push({ tag: "keep", text: row.text })
      i++
      continue
    }
    // A maximal run of deletions, then the insertions that follow it: one
    // changed STRETCH, which is what the two columns have to line up.
    const dels: string[] = []
    while (i < rows.length && rows[i]!.tag === "del") dels.push((rows[i++] as DiffLine).text)
    const adds: string[] = []
    while (i < rows.length && rows[i]!.tag === "add") adds.push((rows[i++] as DiffLine).text)
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      out.push({ tag: "change", left: dels[k] ?? null, right: adds[k] ?? null })
    }
  }
  return out
}

export function collapseUnchanged(lines: readonly DiffLine[], context = 3): DiffRow[] {
  const out: DiffRow[] = []
  // One pass: find each maximal run of `keep`, and if it is long
  // enough, print `context` lines at each end with a gap between them. The
  // first and last runs of the whole diff only need context on their inner
  // side — leading and trailing context is the part nobody reads.
  let idx = 0
  while (idx < lines.length) {
    const line = lines[idx]!
    if (line.tag !== "keep") {
      out.push(line)
      idx++
      continue
    }
    let end = idx
    while (end < lines.length && lines[end]!.tag === "keep") end++
    const length = end - idx
    const atStart = idx === 0
    const atEnd = end === lines.length
    const head = atStart ? 0 : context
    const tail = atEnd ? 0 : context
    if (length <= head + tail + 1) {
      for (let k = idx; k < end; k++) out.push(lines[k]!)
    } else {
      for (let k = idx; k < idx + head; k++) out.push(lines[k]!)
      out.push({ tag: "gap", hidden: length - head - tail })
      for (let k = end - tail; k < end; k++) out.push(lines[k]!)
    }
    idx = end
  }
  return out
}
