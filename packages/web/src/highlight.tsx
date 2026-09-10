import type { ReactNode } from "react"

/**
 * Syntax colouring, drawn rather than installed.
 *
 * A real highlighter — shiki, highlight.js — is grammars by the megabyte for a
 * package with four dependencies, and it is the `filetypes.ts` trade again: at
 * 11px in a result pane the eye resolves token CLASSES, not grammar. Seven
 * classes over the `--color-syn-*` palette already in `index.css` — comment,
 * string, keyword, number, function, variable, type — reproduce most of what
 * "looks like VS Code" costs, because those hexes ARE Dark Modern's.
 *
 * One generic scanner driven by a per-language spec, not a parser: it gets
 * comments, strings and keywords exactly right and approximates the rest
 * (an identifier before `(` is a call, a capitalised one is a type, anything
 * else is a variable — which is what semantic highlighting mostly concludes
 * anyway). A language it does not know renders plain, never wrong.
 */

type Tone = "comment" | "string" | "func" | "var" | "type" | "keyword" | "number"

const CLASS: Record<Tone, string> = {
  comment: "text-syn-comment",
  string: "text-syn-string",
  func: "text-syn-func",
  var: "text-syn-var",
  type: "text-syn-type",
  keyword: "text-syn-keyword",
  number: "text-syn-number",
}

const KW = (words: string) => new Set(words.split(" "))

interface LangSpec {
  /** Line-comment marker. */
  line?: string
  block?: [string, string]
  quotes: string[]
  /** Python's `'''` and `"""`. */
  triple?: boolean
  keywords: Set<string>
  /** Extra identifier characters — only `-` is ever used, so no escaping. */
  idExtra?: string
  /** A key before `:` is a variable — JSON, YAML, CSS properties. */
  keyBeforeColon?: boolean
  /** Shell: the first word of a statement is the command. */
  cmdAfterBreak?: boolean
  /** Shell: `$name` and `${name}`. */
  dollarVar?: boolean
  /** CSS: `#1c1d20` is a number, not a comment. */
  hexColors?: boolean
  /** CSS: `@media` and friends. */
  atKeyword?: boolean
  /** An ordinary identifier stays plain — shell arguments, YAML scalars. */
  plainIds?: boolean
}

const TS = KW(
  "const let var function return if else for while do switch case break continue new class " +
    "extends implements interface type enum import export from default async await yield try " +
    "catch finally throw typeof instanceof in of delete void this super static readonly public " +
    "private protected abstract as satisfies keyof infer namespace declare module get set " +
    "true false null undefined never unknown any string number boolean object symbol bigint",
)

const LANGS: Record<string, LangSpec> = {
  ts: { line: "//", block: ["/*", "*/"], quotes: ['"', "'", "`"], keywords: TS },
  py: {
    line: "#",
    quotes: ['"', "'"],
    triple: true,
    keywords: KW(
      "def class if elif else for while return import from as with try except finally raise " +
        "lambda pass break continue None True False and or not in is global nonlocal yield " +
        "async await del assert self match case",
    ),
  },
  sh: {
    line: "#",
    quotes: ['"', "'"],
    dollarVar: true,
    cmdAfterBreak: true,
    plainIds: true,
    keywords: KW(
      "if then else elif fi for while until do done case esac function in select export local readonly return exit set",
    ),
  },
  json: { quotes: ['"'], keyBeforeColon: true, plainIds: true, keywords: KW("true false null") },
  yaml: {
    line: "#",
    quotes: ['"', "'"],
    keyBeforeColon: true,
    plainIds: true,
    keywords: KW("true false null yes no"),
  },
  css: {
    block: ["/*", "*/"],
    quotes: ['"', "'"],
    idExtra: "-",
    keyBeforeColon: true,
    hexColors: true,
    atKeyword: true,
    plainIds: true,
    keywords: KW("important inherit initial unset auto none"),
  },
  go: {
    line: "//",
    block: ["/*", "*/"],
    quotes: ['"', "'", "`"],
    keywords: KW(
      "func package import return if else for range switch case break continue type struct " +
        "interface map chan go defer select var const nil true false make new len cap append fallthrough goto",
    ),
  },
  rs: {
    line: "//",
    block: ["/*", "*/"],
    quotes: ['"'],
    keywords: KW(
      "fn let mut pub use mod struct enum impl trait for while loop if else match return self " +
        "Self crate super where async await move ref dyn in continue break const static type " +
        "unsafe extern as true false Some None Ok Err",
    ),
  },
}

const BY_EXTENSION: Record<string, string> = {
  ts: "ts", tsx: "ts", mts: "ts", cts: "ts",
  js: "ts", jsx: "ts", mjs: "ts", cjs: "ts",
  py: "py",
  sh: "sh", bash: "sh", zsh: "sh", ps1: "sh",
  json: "json", jsonc: "json",
  yaml: "yaml", yml: "yaml",
  css: "css", scss: "css", less: "css",
  md: "md", mdx: "md",
  go: "go",
  rs: "rs",
}

/** Which language a path's contents are in, or null for "plain, never wrong". */
export function langOfPath(path: string): string | null {
  const ext = path.toLowerCase().split(".").pop() ?? ""
  return BY_EXTENSION[ext] ?? null
}

/**
 * Past this, plain. The scanner is linear but the spans are DOM nodes, and a
 * pasted megabyte of Write content is a scroll box, not a reading.
 */
const CAP = 60_000

export function highlightCode(code: string, lang: string | null): ReactNode {
  if (lang === null || code.length > CAP) return code
  if (lang === "md") return markdown(code)
  const spec = LANGS[lang]
  if (!spec) return code
  return tokenize(code, spec)
}

/**
 * One line, syntax-highlighted, with the character ranges that did NOT change
 * dimmed.
 *
 * The line is tokenised WHOLE and the dimming applied over the result, which
 * is the whole point of this function existing. Highlighting each word-diff
 * span separately — the obvious version, and the one that shipped — re-lexes
 * every span from scratch: a string, a comment or a keyword split across a
 * span boundary is two fragments, each parsed as if it began a line, so
 * `bg-fg-dim/5` → `bg-fg-dim/[0.04]` drew half a string in string colour and
 * the rest as code. Syntax is a property of the line; the diff is a property
 * of ranges within it, and the two have to be applied in that order.
 */
export function highlightWithDim(
  code: string,
  lang: string | null,
  /** Ranges that survived the edit, as [start, end) character offsets. */
  dim: Array<[number, number]>,
): ReactNode {
  if (dim.length === 0) return highlightCode(code, lang)
  const nodes = highlightCode(code, lang)
  const parts = Array.isArray(nodes) ? nodes : [nodes]
  const isDim = (at: number) => dim.some(([from, to]) => at >= from && at < to)

  const out: ReactNode[] = []
  let at = 0
  let key = 0
  // Each highlighted piece is walked by character so a token straddling the
  // boundary between a changed and an unchanged range is split HERE, keeping
  // whatever colour the tokenizer already gave it.
  const emit = (text: string, className: string | undefined) => {
    let run = ""
    let runDim = isDim(at)
    const flush = () => {
      if (run === "") return
      const cls = [className, runDim ? "opacity-45" : ""].filter(Boolean).join(" ")
      out.push(
        cls === "" ? (
          run
        ) : (
          <span key={key++} className={cls}>
            {run}
          </span>
        ),
      )
      run = ""
    }
    for (const ch of text) {
      const d = isDim(at)
      if (d !== runDim) {
        flush()
        runDim = d
      }
      run += ch
      at += ch.length
    }
    flush()
  }

  for (const part of parts) {
    if (typeof part === "string") {
      emit(part, undefined)
      continue
    }
    // A tokenizer span: keep its class, subdivide by the dim ranges.
    const el = part as { props?: { className?: string; children?: unknown } }
    const text = String(el.props?.children ?? "")
    emit(text, el.props?.className)
  }
  return out
}

function tokenize(code: string, spec: LangSpec): ReactNode[] {
  const out: ReactNode[] = []
  let plain = ""
  let key = 0
  const flush = () => {
    if (plain !== "") {
      out.push(plain)
      plain = ""
    }
  }
  const push = (tone: Tone, text: string) => {
    flush()
    out.push(
      <span key={key++} className={CLASS[tone]}>
        {text}
      </span>,
    )
  }

  const idChar = new RegExp(`[A-Za-z0-9_$${spec.idExtra ?? ""}]`)
  const n = code.length
  let i = 0
  let expectCmd = spec.cmdAfterBreak === true

  while (i < n) {
    const c = code[i]!

    if (spec.line !== undefined && code.startsWith(spec.line, i)) {
      const end = code.indexOf("\n", i)
      const stop = end === -1 ? n : end
      push("comment", code.slice(i, stop))
      i = stop
      continue
    }
    if (spec.block && code.startsWith(spec.block[0], i)) {
      const close = code.indexOf(spec.block[1], i + spec.block[0].length)
      const stop = close === -1 ? n : close + spec.block[1].length
      push("comment", code.slice(i, stop))
      i = stop
      continue
    }
    if (spec.quotes.includes(c)) {
      if (spec.triple && code.startsWith(c.repeat(3), i)) {
        const close = code.indexOf(c.repeat(3), i + 3)
        const stop = close === -1 ? n : close + 3
        push("string", code.slice(i, stop))
        i = stop
        continue
      }
      let j = i + 1
      while (j < n) {
        const ch = code[j]
        if (ch === "\\") {
          j += 2
          continue
        }
        // An unterminated string stops at the newline instead of eating the
        // rest of the block — this scanner sees FRAGMENTS (an old_string cut
        // mid-file), and one open quote must not paint everything after it.
        if (ch === c || (ch === "\n" && c !== "`")) break
        j++
      }
      const stop = Math.min(j + (code[j] === c ? 1 : 0), n)
      const text = code.slice(i, stop)
      if (spec.keyBeforeColon) {
        let k = stop
        while (k < n && (code[k] === " " || code[k] === "\t")) k++
        push(code[k] === ":" ? "var" : "string", text)
      } else {
        push("string", text)
      }
      i = stop
      continue
    }
    if (spec.hexColors && c === "#" && /[0-9a-fA-F]/.test(code[i + 1] ?? "")) {
      let j = i + 1
      while (j < n && /[0-9a-fA-F]/.test(code[j]!)) j++
      push("number", code.slice(i, j))
      i = j
      continue
    }
    if (spec.atKeyword && c === "@") {
      let j = i + 1
      while (j < n && idChar.test(code[j]!)) j++
      push("keyword", code.slice(i, j))
      i = j
      continue
    }
    if (spec.dollarVar && c === "$") {
      let j = i + 1
      if (code[j] === "{") {
        const close = code.indexOf("}", j)
        j = close === -1 ? n : close + 1
      } else {
        while (j < n && /[A-Za-z0-9_]/.test(code[j]!)) j++
      }
      push("var", code.slice(i, j))
      i = j
      continue
    }
    if (/[0-9]/.test(c)) {
      let j = i
      // Greedy through letters as well: `0x1f`, `1.5e3`, and CSS's `24px`
      // are one token each. `foo2` never gets here — identifiers match first.
      while (j < n && /[0-9a-zA-Z._]/.test(code[j]!)) j++
      push("number", code.slice(i, j))
      i = j
      continue
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1
      while (j < n && idChar.test(code[j]!)) j++
      const word = code.slice(i, j)
      let k = j
      while (k < n && (code[k] === " " || code[k] === "\t")) k++
      const next = code[k]
      if (spec.keywords.has(word)) {
        push("keyword", word)
      } else if (expectCmd) {
        push("func", word)
        expectCmd = false
      } else if (next === "(") {
        push("func", word)
      } else if (spec.keyBeforeColon && next === ":") {
        push("var", word)
      } else if (spec.plainIds) {
        plain += word
      } else if (/[A-Z]/.test(c)) {
        push("type", word)
      } else {
        push("var", word)
      }
      i = j
      continue
    }
    if (spec.cmdAfterBreak && (c === "\n" || c === "|" || c === ";" || c === "&" || c === "(")) {
      expectCmd = true
    }
    plain += c
    i++
  }
  flush()
  return out
}

/**
 * Markdown is lines, not tokens, so it gets its own tiny pass: headings and
 * quotes coloured whole, inline code within a line. Everything else is prose
 * and stays prose.
 */
function markdown(code: string): ReactNode[] {
  let key = 0
  return code.split(/(\n)/).map((line) => {
    if (line === "\n" || line === "") return line
    if (/^#{1,6}\s/.test(line)) {
      return (
        <span key={key++} className="text-syn-var">
          {line}
        </span>
      )
    }
    if (/^\s*>/.test(line)) {
      return (
        <span key={key++} className="text-syn-comment">
          {line}
        </span>
      )
    }
    return line.split(/(`[^`]+`)/).map((part) =>
      part.startsWith("`") && part.endsWith("`") && part.length > 1 ? (
        <span key={key++} className="text-syn-string">
          {part}
        </span>
      ) : (
        part
      ),
    )
  })
}
