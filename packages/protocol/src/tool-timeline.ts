/**
 * The tool timeline: a turn's calls as a grid — one row per thing touched, one
 * column per assistant MESSAGE.
 *
 * The flat list of tool rows hid the two things that matter about a turn's
 * work: which files it touched, and how many model round trips it took.
 * Round trips are the latency metric — the profile already calls them "the
 * number that predicts the wall clock" — and call count is not: ten calls in
 * one message cost one round trip. The grid draws both at a glance and keeps
 * failures conspicuous, with the flat list still there behind `show N steps`.
 *
 * Everything derivable lives HERE and not in the component, for the reason
 * `fold.ts` and `activity-line.ts` give: each rule below fails invisibly — a
 * message split in two, a retry unmarked, a folded row silently dropping a
 * file — and a React component cannot be asserted by `pnpm smoke`.
 */
import type { RunEvent } from "./events.js"

/** What the grid knows about one call. */
export interface TimelineCall {
  /** `toolUseId`, unique within the log — the grid's selection handle. */
  id: string
  /**
   * 1-based ordinal of the assistant message that issued the call, within its
   * turn. 0 means "announced but not yet logged" — a live delta's row — and
   * `buildTimeline` resolves it to one past the last known column, which is
   * where the streaming message will land when its events do.
   */
  message: number
  tool: string
  /** File path, grep pattern, or shell command — see `toolTarget`. */
  target: string
  status: "ok" | "err" | "busy"
  /** Classified failure reason, or null. See `classifyFailure`. */
  failTag: string | null
  /** Re-attempts a call that failed in an earlier message. See `timelineMeta`. */
  retry: boolean
}

export interface TimelineRow {
  /** A file path, `search`, `shell`, `reads`, or a lowercased tool name. */
  key: string
  /** What the label column draws — the key, except the folded reads row. */
  label: string
  /** Drawn muted rather than in the file colour. */
  sys: boolean
  /** In the order they happened; the component groups them by message. */
  calls: TimelineCall[]
}

export interface Timeline {
  /** Column ordinals, ascending. Contiguous from 1 by construction. */
  messages: number[]
  /** In first-touch order, never sorted by anything else. */
  rows: TimelineRow[]
  /** Messages whose calls are ALL retries: round trips a failure cost. */
  recovery: number[]
  /** Messages with at least one failed call — refusals included. */
  failed: number[]
  /**
   * Of those, the ones where EVERY failure was aide refusing — drawn amber
   * rather than red. All of them, because one genuine fault in a column makes
   * that column a fault: a message that was half refused and half broken must
   * not be coloured as though nothing went wrong. See `isRefusal`.
   */
  refused: number[]
  total: number
}

export interface TimelineMeta {
  message: number
  retry: boolean
}

/** The tools whose calls read rather than act: a hollow ring, not a disc. */
const LOOK_TOOLS = new Set(["Read", "Grep", "Glob", "WebFetch", "WebSearch"])
export const looksOnly = (tool: string): boolean => LOOK_TOOLS.has(tool)

/** The tools whose target is a file, and so get a row per file. */
const FILE_TOOLS = new Set(["Read", "Edit", "Write", "NotebookEdit"])

/**
 * What a call was about, as one string: the command for a shell, the pattern
 * for a search, the path for a file tool. Also the identity `timelineMeta`
 * matches a retry on, so it reads the RAW field rather than a shortened form —
 * two different files that truncate alike must not read as one retried call.
 */
export function toolTarget(tool: string, input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>
  const first =
    o["command"] ?? o["file_path"] ?? o["pattern"] ?? o["path"] ?? o["url"] ?? o["prompt"]
  return typeof first === "string" ? first : ""
}

/**
 * A target field whose VALUE is complete, inside JSON that is not.
 *
 * The keys are `toolTarget`'s, spelled with real quotes — inside a JSON string
 * value a quote can only appear escaped (`\"`), so this cannot match a key
 * named in some old_string being edited. The value pattern consumes escapes
 * pairwise, which is what makes the closing quote a real closing quote; a
 * buffer that ends mid-value simply does not match yet.
 */
const TARGET_IN_PARTIAL =
  /"(?:command|file_path|pattern|path|url|prompt)"\s*:\s*"((?:[^"\\]|\\.)*)"/

/**
 * The call's target read out of STREAMING input, or null until it is knowable.
 *
 * For the live timeline dot: a call announced by the `tool` delta has no
 * arguments yet, and waiting for the event parks the dot on a placeholder row
 * for the whole time the model spends writing them — which for a big edit is
 * most of the call's visible life. A complete string field is a filename
 * whatever the JSON around it is missing. Null for an empty value as well as
 * an unfinished one, because an empty target names no row either.
 */
export function partialToolTarget(partialJson: string): string | null {
  const m = TARGET_IN_PARTIAL.exec(partialJson)
  if (!m) return null
  try {
    // Through JSON.parse rather than hand-unescaping: the value was JSON-encoded
    // by the API, and a second implementation of its escape rules would be the
    // one that disagrees on `\\u0041`.
    const decoded = JSON.parse(`"${m[1] ?? ""}"`) as string
    return decoded === "" ? null : decoded
  } catch {
    return null
  }
}

/** Which row a call lands in. `sys` rows draw muted; file rows get the path colour. */
export function timelineRowOf(tool: string, target: string): { key: string; sys: boolean } {
  if (tool === "Grep" || tool === "Glob") return { key: "search", sys: true }
  if (tool === "Bash" || tool === "BashOutput" || tool === "KillShell")
    return { key: "shell", sys: true }
  if (FILE_TOOLS.has(tool) && target) return { key: target, sys: false }
  // Agent spawns, web fetches, a live file call whose arguments have not
  // arrived: one muted row per tool, so nothing is silently dropped.
  return { key: tool.toLowerCase(), sys: true }
}

/**
 * A failure's reason, classified ONCE, here.
 *
 * The grid shows the tag on hover, and the rule the spec sets is that the tag
 * is the harness's verdict rather than something each surface re-derives. aide
 * writes no per-call tag on the wire — `tool.end` carries the result tail the
 * SDK reported — so this is the one classifier over that recorded text, kept
 * deliberately small: a failure it does not recognise is a red dot with no
 * tag, which is degraded and honest, where a wrong tag is a lie in red.
 *
 * `denied` is matched first because aide's own refusals often NAME the thing
 * that was not found or not allowed, and a policy denial labelled `not found`
 * would send the reader looking for a missing file instead of at the policy.
 */
export function classifyFailure(tool: string, note: string): string | null {
  const n = note.toLowerCase()
  if (n.includes("denied") || n.includes("not allowed") || n.includes("refused"))
    return "denied"
  if (tool === "Edit" && (n.includes("string to replace not found") || n.includes("old_string")))
    return "stale anchor"
  if (n.includes("timed out") || n.includes("timeout")) return "timeout"
  if (n.includes("does not exist") || n.includes("no such file") || n.includes("enoent") ||
      n.includes("not found"))
    return "not found"
  return null
}

/**
 * A failure that is aide REFUSING, rather than something breaking.
 *
 * The two deserve different colours and did not get them. A policy denial —
 * the shell policy turning down `grep`, a Plan turn declining to edit — is the
 * system working exactly as designed, and the run routes around it in one round
 * trip. A tool that actually blew up is a fault. Drawn identically in red, the
 * refusals read to a human as "errors in my tool", which is both wrong and the
 * opposite of reassuring: the wall doing its job looked like the wall being
 * broken.
 *
 * Derived from the tag rather than stored as a third `status`, because that is
 * the field the grid, the flat row and the card all already agree on — a fourth
 * status would mean four places deciding what counts as a refusal. Everything
 * here still FAILED and still counts as a failure everywhere failures are
 * counted; only its colour says which kind.
 */
export const isRefusal = (failTag: string | null): boolean => failTag === "denied"

/**
 * Which assistant message each main-loop call belongs to, and whether it is a
 * retry — read off the event log, for every turn in it.
 *
 * MESSAGE. The log has no per-call message field, but it does not need one:
 * `tool.start` events are read off the COMPLETED assistant message and
 * appended in one batch, so the calls of one message are consecutive in the
 * log and anything else between two `tool.start`s means a new message. The
 * counter resets at each `user.message`, so ordinals are per TURN — which is
 * the unit the grid draws. Messages that issued no calls are not counted;
 * they have no column to own.
 *
 * Subagent calls (`parentToolUseId` non-null) are skipped WITHOUT breaking the
 * group: they interleave with the main loop in real time, and letting one
 * split a message in two would draw a single round trip as several. The grid
 * charts the main loop only — the `Agent` call itself is the dot, and the
 * subagent's own work is read in the transcript, nested where it always was.
 *
 * RETRY. True when an earlier message of the same turn had a FAILED call with
 * the same tool and target. Same-message repeats are not retries — calls in
 * one message went out together, before the model could see either fail. A
 * retry that succeeds clears the failure, so a third identical call later in
 * the turn is an ordinary call, not a permanent echo of one old mistake. The
 * spec forbids the UI inferring recovery from target matching so that two
 * surfaces cannot disagree; this is the one place the flag is computed.
 */
export function timelineMeta(events: readonly RunEvent[]): Map<string, TimelineMeta> {
  const meta = new Map<string, TimelineMeta>()
  // Outcomes first, so retry bookkeeping can see how a call ended. On a live
  // log a call's end may not have landed yet; it is then neither a failure to
  // retry nor a success that clears one, and the flags settle on the next pass.
  const okById = new Map<string, boolean>()
  for (const e of events) if (e.type === "tool.end") okById.set(e.toolUseId, e.ok)

  let message = 0
  let inMessage = false
  let failedAt = new Map<string, number>()

  for (const e of events) {
    if (e.type === "tool.start") {
      if (e.parentToolUseId !== null) continue
      if (!inMessage) {
        message += 1
        inMessage = true
      }
      const key = `${e.name} ${toolTarget(e.name, e.input)}`
      const before = failedAt.get(key)
      const retry = before !== undefined && before < message
      meta.set(e.toolUseId, { message, retry })
      const ok = okById.get(e.toolUseId)
      if (ok === false) failedAt.set(key, message)
      else if (ok === true && retry) failedAt.delete(key)
      continue
    }
    inMessage = false
    if (e.type === "user.message") {
      message = 0
      failedAt = new Map()
    }
  }
  return meta
}

/**
 * More distinct files than this and the ones that were only read fold into a
 * single `reads · N files` row. Files that were edited or written always keep
 * their own row — they are the diff about to appear in the rail, and folding
 * one would hide the part of the turn that says what the review will be.
 */
const FOLD_FILES = 8

/** One turn's calls arranged into the grid. Pure; the component only draws it. */
export function buildTimeline(calls: readonly TimelineCall[]): Timeline {
  let last = 0
  for (const c of calls) if (c.message > last) last = c.message
  // Live calls — message 0 — land one past the last logged column, together:
  // they were all announced by the one message still streaming.
  const resolved = calls.map((c) => (c.message > 0 ? c : { ...c, message: last + 1 }))

  const placed = resolved.map((c) => ({ c, at: timelineRowOf(c.tool, c.target) }))
  const acted = new Set(
    placed.filter((p) => !p.at.sys && !looksOnly(p.c.tool)).map((p) => p.at.key),
  )
  const files = new Set(placed.filter((p) => !p.at.sys).map((p) => p.at.key))
  const fold = files.size > FOLD_FILES

  const rows: TimelineRow[] = []
  const index = new Map<string, TimelineRow>()
  for (const { c, at } of placed) {
    const folded = fold && !at.sys && !acted.has(at.key)
    const key = folded ? "reads" : at.key
    let row = index.get(key)
    if (!row) {
      row = { key, label: key, sys: folded ? true : at.sys, calls: [] }
      index.set(key, row)
      rows.push(row)
    }
    row.calls.push(c)
  }
  const reads = index.get("reads")
  if (reads) {
    const n = new Set(reads.calls.map((c) => timelineRowOf(c.tool, c.target).key)).size
    reads.label = `reads · ${n} files`
  }

  const messages = [...new Set(resolved.map((c) => c.message))].sort((a, b) => a - b)
  const byMsg = new Map<number, TimelineCall[]>()
  for (const c of resolved) {
    const list = byMsg.get(c.message)
    if (list) list.push(c)
    else byMsg.set(c.message, [c])
  }
  const recovery = messages.filter((m) => (byMsg.get(m) ?? []).every((c) => c.retry))
  const failed = messages.filter((m) => (byMsg.get(m) ?? []).some((c) => c.status === "err"))
  const refused = failed.filter((m) =>
    (byMsg.get(m) ?? []).every((c) => c.status !== "err" || isRefusal(c.failTag)),
  )

  return { messages, rows, recovery, failed, refused, total: resolved.length }
}
