import type { ReactNode } from "react"
import { X } from "./icons.js"

/**
 * One tool call, structured — the card a clicked timeline dot opens.
 *
 * It renders the same recorded fields the flat row's expansion holds — the
 * input off `tool.start`, the result tail off `tool.end` — so the two
 * readings cannot disagree; what it adds is shape. The expansion was
 * `JSON.stringify` of the input, which made the reader parse an Edit with
 * their eyes to find what changed. The fields are structured enough to be
 * drawn as what they are: old and new in the diff colours, a command above
 * its output, a pattern beside its filters. A tool without a dedicated body
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
  "max-h-48 overflow-auto rounded-sm p-2 text-[11px] leading-relaxed whitespace-pre-wrap text-fg-muted"

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-0.5 font-sans text-[10px] tracking-wide text-fg-dim uppercase">{label}</div>
      {children}
    </div>
  )
}

const str = (o: Record<string, unknown>, key: string): string | null =>
  typeof o[key] === "string" ? (o[key] as string) : null
const num = (o: Record<string, unknown>, key: string): number | null =>
  typeof o[key] === "number" ? (o[key] as number) : null

/** The search knobs worth surfacing — the half of a Grep a JSON dump buries. */
const SEARCH_FLAGS = ["path", "glob", "type", "output_mode", "-n", "-i", "-A", "-B", "-C"] as const

function Body({ call }: { call: CallDetailData }) {
  if (call.input === null) {
    return <p className="font-sans text-[11px] text-fg-dim">arguments still streaming…</p>
  }
  const o = (call.input ?? {}) as Record<string, unknown>

  if (call.name === "Edit") {
    return (
      <>
        {o["replace_all"] === true && (
          <p className="font-sans text-[10px] text-fg-dim">replaces every occurrence</p>
        )}
        {/* The two blocks in the diff colours the rail already taught: what
            left in red, what arrived in green. This IS the call's meaning —
            the file path is in the header above. */}
        <Labeled label="old">
          <pre className={`${PRE} bg-diff-del`}>{str(o, "old_string") ?? ""}</pre>
        </Labeled>
        <Labeled label="new">
          <pre className={`${PRE} bg-diff-add`}>{str(o, "new_string") ?? ""}</pre>
        </Labeled>
      </>
    )
  }
  if (call.name === "Write") {
    return (
      <Labeled label="content">
        {/* Add-coloured whole: a Write is all arrival, whatever it replaced. */}
        <pre className={`${PRE} bg-diff-add`}>{str(o, "content") ?? ""}</pre>
      </Labeled>
    )
  }
  if (call.name === "Bash") {
    return (
      // The header truncates a long command; this is the whole of it.
      <Labeled label="command">
        <pre className={`${PRE} bg-editor text-syn-string`}>{str(o, "command") ?? ""}</pre>
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
          <pre className={`${PRE} bg-editor text-syn-string`}>{str(o, "pattern") ?? ""}</pre>
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
      <pre className={`${PRE} bg-editor`}>{JSON.stringify(call.input, null, 2)}</pre>
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
      <div className="space-y-1.5 px-2 py-1.5">
        <Body call={call} />
        {call.summary !== "" && (
          <Labeled label="result">
            <pre className={`${PRE} bg-editor`}>{call.summary}</pre>
          </Labeled>
        )}
      </div>
    </div>
  )
}
