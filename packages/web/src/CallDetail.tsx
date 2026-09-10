import type { ReactNode } from "react"
import {
  collapseUnchanged,
  diffLines,
  pairWords,
  splitRows,
  type DiffRow,
  type WordSpan,
} from "@aide/protocol"
import { highlightCode, langOfPath } from "./highlight.js"
import { X } from "./icons.js"
import { useRemembered } from "./useRemembered.js"

/**
 * Whether a card's code and result blocks render WHOLE or clamp to a scroll
 * box. Expanded by default: a card you opened to read is a card you meant to
 * read, and a scrollbar three lines in was the wall the card existed to
 * remove. Global, like the typing toggle — a reading preference, not a
 * property of any chat — and edited from `settings` in the rail's foot.
 */
export const CARD_EXPAND_KEY = "aide.card.expand"

/**
 * Whether an Edit draws as one unified diff or as two aligned columns.
 *
 * Unified is the default and the right one for most edits here — context
 * appears once, and a few changed lines inside a stable neighbourhood is the
 * shape of nearly every edit in this repo. Split earns its width on a block
 * REWRITE, where unified stacks N deletions above N insertions and comparing
 * line 3 to line 3 means crossing the boundary between two piles. It costs
 * half the card's width, which is why it is the toggle rather than the
 * default: in a wall column there is not enough room for two columns of code.
 */
export const CARD_SPLIT_KEY = "aide.card.split"

const isBool = (v: unknown): v is boolean => typeof v === "boolean"

/**
 * One tool call, structured — the card a clicked timeline dot opens.
 *
 * It renders the same recorded fields the flat row's expansion holds — the
 * input off `tool.start`, the result tail off `tool.end` — so the two
 * readings cannot disagree; what it adds is shape. The expansion was
 * `JSON.stringify` of the input, which made the reader parse an Edit with
 * their eyes to find what changed. The fields are structured enough to be
 * drawn as what they are: old and new blocks whose BORDERS carry the diff
 * colours while the text keeps the editor's own syntax colours (a wash of
 * red under code made the code the hard thing to read), a command above its
 * output, a pattern beside its filters. A tool without a dedicated body
 * falls back to the arguments as JSON — degraded and honest, so a new tool
 * is never invisible here.
 */
export interface CallDetailData {
  name: string
  /** Null while the call's event has not landed — arguments still streaming. */
  input: unknown
  target: string
  /** Null while the call is running. */
  ok: boolean | null
  /** The recorded result tail. Empty while running, and for a silent success. */
  summary: string
  failTag: string | null
  retry: boolean
}

const PRE =
  "overflow-auto rounded-sm p-2 text-[11px] leading-relaxed whitespace-pre-wrap text-fg-muted"

/** Code blocks read in the editor's default fg, with the tokens coloured over it. */
const CODE =
  "overflow-auto rounded-sm bg-editor p-2 text-[11px] leading-relaxed whitespace-pre-wrap text-fg"

function Labeled({
  label,
  tone = "text-fg-dim",
  children,
}: {
  label: string
  /** The old/new labels take the diff colours the borders carry. */
  tone?: string
  children: ReactNode
}) {
  return (
    // min-w-0 so a block can sit in a grid column: a grid item's min-width
    // defaults to its content, and a pre full of code would push its column
    // wider than the card instead of scrolling inside it.
    <div className="min-w-0">
      <div className={`mb-0.5 font-sans text-[10px] tracking-wide uppercase ${tone}`}>{label}</div>
      {children}
    </div>
  )
}

/**
 * The smallest leading indent across every non-blank line.
 *
 * An old_string is a fragment cut from the middle of a file, so it arrives
 * wearing the file's indentation — twenty columns of nothing before every
 * line, half the card spent rendering empty space. Measured over old and new
 * TOGETHER and stripped equally from both, because dedenting each on its own
 * would erase a re-indentation, which can be the entire change.
 */
function commonIndent(code: string): number {
  let min = Infinity
  for (const line of code.split("\n")) {
    if (line.trim() === "") continue
    min = Math.min(min, line.length - line.trimStart().length)
  }
  return Number.isFinite(min) ? min : 0
}

const dedent = (code: string, by: number): string =>
  by === 0
    ? code
    : code
        .split("\n")
        .map((line) => (line.trim() === "" ? "" : line.slice(by)))
        .join("\n")

const str = (o: Record<string, unknown>, key: string): string | null =>
  typeof o[key] === "string" ? (o[key] as string) : null

/** The daemon's cut marker — `clip` in agent.ts writes `…N chars…` on its own line. */
const ELISION = /^…\d+ chars…$/

/**
 * Which colour a line of shell output would have worn in a real terminal.
 * By line SHAPE, not content analysis — a `$ ` echo, a leading check mark
 * (`√` included: Windows consoles transliterate `✓`), an error or warning
 * word — so a wrong tint is possible but cheap, and the text stays the text.
 */
function shellTone(line: string): string | null {
  if (/^\s*\$\s/.test(line)) return "text-fg"
  if (/^\s*(✓|✔|√|ok\b|PASS\b|passed\b)/i.test(line)) return "text-ok"
  if (/\b(error|failed|FAIL|ERR!)\b/i.test(line)) return "text-err"
  if (/\bwarn(ing)?\b/i.test(line)) return "text-warn"
  return null
}

/**
 * Shell output, read the way a terminal would have shown it.
 *
 * The commands run headless, so the ANSI colour they would print in a live
 * terminal is stripped before anything is recorded — this puts that reading
 * back. Success rows green, failures red, warnings amber, command echoes
 * bright, everything else muted; and the elision marker draws as a rule
 * across the box rather than as three mystery words inside the output it
 * cut. The tones are a reading aid over recorded text, never a verdict —
 * the call's own ok/err stays the header's dot.
 */
function ShellOutput({ text, clamp }: { text: string; clamp: string }) {
  return (
    <pre className={`${PRE} ${clamp} bg-editor`}>
      {text.split("\n").map((line, i) => {
        if (ELISION.test(line.trim())) {
          return (
            <span
              key={i}
              className="flex items-center gap-2 py-0.5 text-[10px] text-fg-dim select-none"
            >
              <span className="h-px flex-1 bg-line" />
              {line.trim()}
              <span className="h-px flex-1 bg-line" />
            </span>
          )
        }
        const tone = shellTone(line)
        return tone === null ? (
          `${line}\n`
        ) : (
          <span key={i} className={tone}>
            {`${line}\n`}
          </span>
        )
      })}
    </pre>
  )
}

const num = (o: Record<string, unknown>, key: string): number | null =>
  typeof o[key] === "number" ? (o[key] as number) : null

/**
 * An Edit as a unified diff: shared lines once as context, and only what
 * moved marked — the reading every diff tool gives, and the reason a
 * fifty-line edit whose change is three lines no longer costs a card full of
 * text shown twice.
 *
 * The MARKER carries the direction (`+`, `-`, in the diff colours) and the
 * row takes a faint tint of it; the code itself keeps its syntax colours, so
 * the two systems layer instead of fighting — the same trade the filled
 * backgrounds lost. Long unchanged stretches collapse to a rule with a
 * count, drawn like the shell elision so a cut looks like a cut.
 *
 * `diffLines` and `collapseUnchanged` are in protocol, where `pnpm smoke`
 * pins them: a line attributed to the wrong side reads as a change that
 * never happened, and nothing about that is visible to the compiler.
 */
/** The elision rule, shared by both layouts and the shell output's cut. */
function GapRule({ hidden }: { hidden: number }) {
  return (
    <span className="flex items-center gap-2 py-0.5 text-[10px] text-fg-dim select-none">
      <span className="h-px flex-1 bg-line" />
      {hidden} unchanged
      <span className="h-px flex-1 bg-line" />
    </span>
  )
}

/**
 * One changed line, with the words that did not move DIMMED.
 *
 * The dimming is the highlight, inverted: the code carries syntax colour
 * already, so tinting the changed span would be a third colour system over
 * the same glyphs. Fading what survived leaves the eye on what did not.
 * `spans` is null when the two lines share too little to be a rewrite of each
 * other — then the line is drawn whole, because marking 90% of it as changed
 * says less than the plain +/- pair.
 */
function DiffText({ spans, text, lang }: { spans: WordSpan[] | null; text: string; lang: string | null }) {
  if (spans === null) return <>{highlightCode(text, lang)}</>
  return (
    <>
      {spans.map((s, i) => (
        <span key={i} className={s.changed ? "" : "opacity-45"}>
          {highlightCode(s.text, lang)}
        </span>
      ))}
    </>
  )
}

/**
 * The row wash, deliberately faint.
 *
 * At /10 a fifteen-line addition drew as a solid green slab — and the tint is
 * the LEAST informative thing on the row, since the marker in the gutter
 * already says which direction it went. Worse, the slab swamped the
 * word-level dimming it sits behind, which is the signal actually worth
 * seeing. /[0.025] is enough to group a changed stretch when the eye scans
 * for one, and not enough to compete with the code.
 */
const rowTint = (tag: "add" | "del") =>
  tag === "add" ? "bg-diff-add-fg/[0.025]" : "bg-diff-del-fg/[0.025]"
const markTone = (tag: "add" | "del") => (tag === "add" ? "text-diff-add-fg" : "text-diff-del-fg")

/**
 * A unified diff: context once, changes marked, and the words inside a
 * changed line that actually moved left undimmed.
 *
 * Word pairing needs BOTH lines, so a deletion is paired with the insertion
 * at the matching offset in its own changed stretch — the same zip
 * `splitRows` does for two columns, done here so both layouts mark the same
 * spans. Without it the pairing would differ between views and the same edit
 * would highlight differently depending on a setting.
 */
function UnifiedDiff({ rows, lang }: { rows: DiffRow[]; lang: string | null }) {
  const pairs = splitRows(rows)
  // Which insertion answers which deletion, by text — built from the pairing
  // so a lookup here cannot disagree with the split view's alignment.
  const partner = new Map<string, string>()
  for (const p of pairs) {
    if (p.tag === "change" && p.left !== null && p.right !== null) {
      partner.set(`l${p.left}`, p.right)
      partner.set(`r${p.right}`, p.left)
    }
  }
  return (
    <>
      {rows.map((row, i) => {
        if (row.tag === "gap") return <GapRule key={i} hidden={row.hidden} />
        if (row.tag === "keep") {
          return (
            <span key={i} className="block">
              <span className="text-fg-dim select-none">{"  "}</span>
              {highlightCode(row.text, lang)}
              {"\n"}
            </span>
          )
        }
        const other = partner.get(`${row.tag === "del" ? "l" : "r"}${row.text}`)
        const paired =
          other === undefined
            ? null
            : row.tag === "del"
              ? (pairWords(row.text, other)?.left ?? null)
              : (pairWords(other, row.text)?.right ?? null)
        return (
          <span key={i} className={`block ${rowTint(row.tag)}`}>
            <span className={`select-none ${markTone(row.tag)}`}>
              {row.tag === "add" ? "+ " : "- "}
            </span>
            <DiffText spans={paired} text={row.text} lang={lang} />
            {"\n"}
          </span>
        )
      })}
    </>
  )
}

/** The same diff in two aligned columns — for a block rewrite, where unified stacks. */
function SplitDiff({ rows, lang }: { rows: DiffRow[]; lang: string | null }) {
  const pairs = splitRows(rows)
  const side = (text: string | null, spans: WordSpan[] | null, tag: "add" | "del") =>
    text === null ? (
      // An empty half of a lopsided change: faintly tinted, so the column
      // reads as "nothing here" rather than as a line that happens to be
      // blank. Same restraint as `rowTint` — it marks absence, which nobody
      // needs shouted.
      <span className="block bg-fg-dim/[0.04]">{"\n"}</span>
    ) : (
      <span className={`block ${rowTint(tag)}`}>
        <span className={`select-none ${markTone(tag)}`}>{tag === "add" ? "+ " : "- "}</span>
        <DiffText spans={spans} text={text} lang={lang} />
        {"\n"}
      </span>
    )
  return (
    <div className="grid grid-cols-2 gap-x-1.5">
      {pairs.map((p, i) => {
        if (p.tag === "gap") {
          return (
            <div key={i} className="col-span-2">
              <GapRule hidden={p.hidden} />
            </div>
          )
        }
        if (p.tag === "keep") {
          // Context spans BOTH columns rather than being printed twice: the
          // reason to use two columns is the changed stretches, and repeating
          // every unchanged line is the cost that made side-by-side worse.
          return (
            <div key={i} className="col-span-2">
              <span className="block">
                <span className="text-fg-dim select-none">{"  "}</span>
                {highlightCode(p.text, lang)}
                {"\n"}
              </span>
            </div>
          )
        }
        const words =
          p.left !== null && p.right !== null ? pairWords(p.left, p.right) : null
        return (
          <div key={i} className="contents">
            <div className="min-w-0 overflow-x-auto">{side(p.left, words?.left ?? null, "del")}</div>
            <div className="min-w-0 overflow-x-auto">
              {side(p.right, words?.right ?? null, "add")}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function DiffBlock({
  old,
  next,
  lang,
  clamp,
}: {
  old: string
  next: string
  lang: string | null
  clamp: string
}) {
  const [split] = useRemembered<boolean>(CARD_SPLIT_KEY, false, isBool)
  const rows = collapseUnchanged(diffLines(old, next))
  return (
    <pre className={`${CODE} ${clamp}`}>
      {split ? <SplitDiff rows={rows} lang={lang} /> : <UnifiedDiff rows={rows} lang={lang} />}
    </pre>
  )
}

/** The search knobs worth surfacing — the half of a Grep a JSON dump buries. */
const SEARCH_FLAGS = ["path", "glob", "type", "output_mode", "-n", "-i", "-A", "-B", "-C"] as const

function Body({ call, clamp }: { call: CallDetailData; clamp: string }) {
  if (call.input === null) {
    return <p className="font-sans text-[11px] text-fg-dim">arguments still streaming…</p>
  }
  const o = (call.input ?? {}) as Record<string, unknown>
  const lang = langOfPath(call.target)

  if (call.name === "Edit") {
    const oldS = str(o, "old_string") ?? ""
    const newS = str(o, "new_string") ?? ""
    const cut = commonIndent(`${oldS}\n${newS}`)
    return (
      <>
        {o["replace_all"] === true && (
          <p className="font-sans text-[10px] text-fg-dim">replaces every occurrence</p>
        )}
        {/* ONE diff, not two blocks. Side by side was the version before
            this and left the reader finding the change by eye: for a
            fifty-line edit whose change is three lines, most of the card was
            unchanged text shown twice, and the two columns scrolled apart. */}
        <DiffBlock old={dedent(oldS, cut)} next={dedent(newS, cut)} lang={lang} clamp={clamp} />
      </>
    )
  }
  if (call.name === "Write") {
    return (
      // The add border whole: a Write is all arrival, whatever it replaced.
      <Labeled label="content" tone="text-diff-add-fg">
        <pre className={`${CODE} border-l-2 border-diff-add-fg/70 ${clamp}`}>
          {highlightCode(str(o, "content") ?? "", lang)}
        </pre>
      </Labeled>
    )
  }
  if (call.name === "Read") {
    const offset = num(o, "offset")
    const limit = num(o, "limit")
    if (offset === null && limit === null) return null
    return (
      <p className="font-sans text-[11px] text-fg-dim">
        {offset !== null ? `from line ${offset}` : "from the top"}
        {limit !== null && `, ${limit} lines`}
      </p>
    )
  }
  if (call.name === "Grep" || call.name === "Glob") {
    const flags = SEARCH_FLAGS.flatMap((k) => {
      const v = o[k]
      if (v === undefined || v === null || v === false) return []
      return [`${k.replace(/^-/, "")} ${v === true ? "" : String(v)}`.trim()]
    })
    return (
      <>
        <Labeled label="pattern">
          <pre className={`${PRE} ${clamp} bg-editor text-syn-string`}>{str(o, "pattern") ?? ""}</pre>
        </Labeled>
        {flags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {flags.map((f) => (
              <span key={f} className="rounded bg-input px-1.5 py-0.5 text-[10px] text-fg-muted">
                {f}
              </span>
            ))}
          </div>
        )}
      </>
    )
  }
  return (
    <Labeled label="arguments">
      <pre className={`${CODE} ${clamp}`}>{highlightCode(JSON.stringify(call.input, null, 2), "json")}</pre>
    </Labeled>
  )
}

export function CallDetail({
  call,
  duration,
  onClose,
}: {
  call: CallDetailData
  /** Preformatted by the caller, which owns the one duration formatter. */
  duration: string | null
  onClose: () => void
}) {
  return (
    // The commit fold's box: bordered, because like a commit this is neither
    // the model talking nor a row in the flow — it is an inspection the reader
    // opened, with a clear top and bottom and its own close.
    <div className="my-1.5 overflow-hidden rounded border border-line bg-chrome">
      <div className="flex min-w-0 items-center gap-2 border-b border-line px-2 py-1 text-[11px]">
        {call.ok === null ? (
          <span className="size-2.5 shrink-0 animate-spin rounded-full border-2 border-info border-t-transparent" />
        ) : (
          <span className={`size-2 shrink-0 rounded-full ${call.ok ? "bg-ok" : "bg-err"}`} />
        )}
        <span className="shrink-0 text-syn-func">{call.name}</span>
        <span className="min-w-0 truncate text-syn-string" title={call.target}>
          {call.target}
        </span>
        {call.failTag && <span className="shrink-0 text-err">{call.failTag}</span>}
        {call.retry && (
          <span
            className="shrink-0 text-warn"
            title="Re-attempts a call that failed in an earlier message"
          >
            retry
          </span>
        )}
        {duration !== null && <span className="shrink-0 text-fg-dim">{duration}</span>}
        <button
          type="button"
          onClick={onClose}
          title="Close"
          className="ml-auto shrink-0 text-fg-dim hover:text-fg"
        >
          <X className="size-3" />
        </button>
      </div>
      <div className="px-2 py-1.5">
        <CallBlocks call={call} />
      </div>
    </div>
  )
}

/**
 * The per-tool blocks and the result, WITHOUT the card's frame — shared
 * verbatim between the card a timeline dot opens and a flat row's expansion
 * behind `show N steps`. One component is the point: the expansion used to be
 * a JSON dump with the escapes showing, so the same call had a structured
 * reading in one place and `\n`-riddled soup in the other, and which one you
 * got depended on where you happened to click.
 */
export function CallBlocks({ call }: { call: CallDetailData }) {
  const [expand] = useRemembered<boolean>(CARD_EXPAND_KEY, true, isBool)
  const clamp = expand ? "" : "max-h-48"
  // A shell call is ONE terminal reading, not a labelled command box above a
  // labelled result box — the command was already in the header, so the boxes
  // spent two section labels saying it twice. `$ command`, then what it
  // printed: the shape every terminal ever taught, and the `$ ` rule in
  // ShellOutput brights this line exactly like the `$ ` echoes pnpm itself
  // prints beneath it. `target` rather than the input, so a still-streaming
  // call already shows the command its delta named.
  if (call.name === "Bash") {
    return (
      <ShellOutput
        text={`$ ${call.target}${call.summary === "" ? "" : `\n${call.summary}`}`}
        clamp={clamp}
      />
    )
  }
  return (
    <div className="space-y-1.5">
      <Body call={call} clamp={clamp} />
      {call.summary !== "" && (
        <Labeled label="result">
          {/* A Read's result IS file content, so it reads in that file's
              colours. Every other tool's result stays plain — colouring a
              stack trace as TypeScript would be decoration claiming to be
              meaning. */}
          {call.name === "Read" ? (
            <pre className={`${CODE} ${clamp}`}>{highlightCode(call.summary, langOfPath(call.target))}</pre>
          ) : (
            <pre className={`${PRE} ${clamp} bg-editor`}>{call.summary}</pre>
          )}
        </Labeled>
      )}
    </div>
  )
}
