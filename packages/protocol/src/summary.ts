/**
 * The closing block a turn writes about itself, and how it is read.
 *
 * ## Why this is text and not a tool
 *
 * The obvious design is a `submit_summary` tool the model must call as its final
 * action, which gets a validated object for free. It is the wrong shape HERE,
 * for a reason this codebase has already paid for once: `canUseTool` is awaited
 * BEFORE the SDK runs a tool, so a mandatory closing call parks the run — with
 * the project's lock still held — at the exact moment the turn is finishing.
 * That is the wedge `AskUserQuestion` is refused for and the one `ExitPlanMode`
 * only escapes by being approved without asking. Adding a second such tool to
 * the end of EVERY turn means the allowlist must never be got wrong again.
 *
 * A fenced block has no permission surface. It also fails better: a turn that
 * forgets one degrades to exactly what happens today, rather than hanging.
 *
 * ## Why the fields are what they are
 *
 * This is the middle of three layers. Below it, `verify.result`, `commit.landed`
 * and `run.finished` already carry the checks, the sha and the outcome, off exit
 * codes and git — ground truth, no model involved. Above it, the raw transcript.
 * So this layer carries ONLY what the model alone knows: what it was trying to
 * do, what should happen next, what it is unsure of.
 *
 * Nothing here may assert pass/fail. A `status: ok` field would be a second,
 * softer answer to a question the exit codes have already answered hard, and the
 * two would disagree eventually — on the line a human reads first and trusts
 * most. The card gets its green tick from `verify.result` and from nowhere else.
 */

/** The fields a turn may report about itself. See `RunEventBody["turn.summary"]`. */
export interface TurnSummary {
  headline: string
  next?: string
  intent?: string
  risk?: string
}

/**
 * The fence the block is written in.
 *
 * A named language rather than a bare fence, so a reply that happens to end in
 * an ordinary code block is not mistaken for a summary. `aide-summary` is not a
 * language any highlighter knows, which is deliberate — it renders as plain text
 * wherever this leaks into a markdown viewer, rather than as broken syntax.
 */
export const SUMMARY_FENCE = "aide-summary"

/** Keys read off the block. Anything else is ignored rather than an error. */
const FIELDS = ["headline", "next", "intent", "risk"] as const

/**
 * How long any one field may be before it is cut.
 *
 * The block exists to be read in two seconds; a model that writes a paragraph
 * into `headline` has misunderstood the job, and truncating is a better answer
 * than refusing because the first sentence is usually still the right one. Cut
 * rather than rejected for the same reason the project doc is: silently losing
 * the whole thing is worse than keeping the front of it.
 */
const MAX_FIELD_CHARS = 300

/**
 * Pull the summary out of an assistant reply, or null if there is not one.
 *
 * Reads the LAST block in the text, not the first. The turn is asked to close
 * with it, and a reply that quotes an earlier turn's summary — which happens the
 * moment somebody asks "what did you say last time" — would otherwise report
 * that older one as this turn's.
 *
 * Never throws. This runs on model output in the middle of normalizing a
 * message, so a malformed block has to mean "no summary" rather than take the
 * turn's events down with it.
 */
export function parseTurnSummary(text: string): TurnSummary | null {
  const blocks = [...text.matchAll(blockPattern())]
  const last = blocks.at(-1)?.[1]
  if (last === undefined) return null

  const found: Record<string, string> = {}
  let key: string | null = null
  for (const raw of last.split("\n")) {
    // `key: value`, where the key is one we know. Anything else is treated as a
    // continuation of the field above it, so a `next:` that wraps onto a second
    // line keeps its second line instead of dropping it.
    const match = /^([a-z]+):\s?(.*)$/.exec(raw.trim())
    if (match && (FIELDS as readonly string[]).includes(match[1] ?? "")) {
      key = match[1] ?? null
      if (key) found[key] = match[2] ?? ""
      continue
    }
    if (key && raw.trim()) found[key] = `${found[key] ?? ""} ${raw.trim()}`.trim()
  }

  const clean = (value: string | undefined): string | undefined => {
    const trimmed = (value ?? "").replace(/\s+/g, " ").trim()
    if (!trimmed) return undefined
    return trimmed.length > MAX_FIELD_CHARS ? `${trimmed.slice(0, MAX_FIELD_CHARS)}…` : trimmed
  }

  // The headline is what makes it a summary. A block with only a `next:` is a
  // fragment, and reporting it as a summary would draw a card with an empty
  // first line — which reads as aide having lost the text rather than as the
  // model not having written one.
  const headline = clean(found["headline"])
  if (!headline) return null

  const summary: TurnSummary = { headline }
  const next = clean(found["next"])
  const intent = clean(found["intent"])
  const risk = clean(found["risk"])
  // Assigned only when present, because `exactOptionalPropertyTypes` is on and
  // because an absent field and an empty one are drawn differently: one is a
  // turn with nothing to hand over, the other is a turn that did not answer.
  if (next) summary.next = next
  if (intent) summary.intent = intent
  if (risk) summary.risk = risk
  return summary
}

/**
 * Built per call rather than kept as a module constant: a global regex carries
 * `lastIndex` between uses, and a shared one silently skips the first block of
 * every other call.
 */
const blockPattern = () => new RegExp("```" + SUMMARY_FENCE + "\\r?\\n([\\s\\S]*?)```", "g")

/**
 * Strip the block from text that is about to be shown to a human.
 *
 * The card renders the fields; the transcript should not then repeat them as a
 * lump of pseudo-YAML at the bottom of the reply. Applied at render time rather
 * than before the event is logged — the raw text stays exactly as the model
 * wrote it in `~/.aide/runs`, which is the tier-3 record and must not be edited
 * on its way to disk.
 */
export function stripTurnSummary(text: string): string {
  return text.replace(blockPattern(), "").trimEnd()
}

/**
 * The same, for text that is still being typed.
 *
 * The live stream shows a reply one token at a time, so the closing fence has
 * not arrived yet while the block is being written — `stripTurnSummary` matches
 * nothing and the reader watches ```aide-summary and a list of field names type
 * themselves out, which is the raw machinery the card exists to replace.
 *
 * So an UNCLOSED fence is cut from its opening to the end of the text. Safe
 * because the block is the last thing in the reply by construction: there is
 * nothing after it to lose. Once the closing fence lands the ordinary strip
 * takes over and the two agree.
 */
export function stripPartialTurnSummary(text: string): string {
  const stripped = stripTurnSummary(text)
  const opening = stripped.lastIndexOf("```" + SUMMARY_FENCE)
  return opening === -1 ? stripped : stripped.slice(0, opening).trimEnd()
}
