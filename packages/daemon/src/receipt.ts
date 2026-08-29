/**
 * What a conversation cost, where the time went, and what went wrong in it.
 *
 * The event log already holds all of this — every event is stamped on append,
 * tool calls come in matched pairs, denials carry the policy's own words, and a
 * result carries the spend. What it did not have is a form you can hand to
 * somebody. This file is the derivation: run logs in, one markdown document out,
 * meant to be copied into a question about how the conversation could have gone
 * better.
 *
 * Derived by code rather than written by a model, and that is the point. A
 * model-authored post-mortem of a model's own run is a flattering summary of the
 * thing being audited; these numbers come off the log, which has no opinion
 * about how the run went. The reading is the human's job, and the receipt exists
 * to give that reading something true to start from.
 *
 * It is not the same artifact as the diff. The diff answers "is this code
 * right"; this answers "was that a good way to ask" — the gate on the work
 * rather than the gate on the code, which is why it sits beside the diff instead
 * of inside it.
 */
import type { ModelSpend, Project, Receipt, RunEvent, RunStatus } from "@aide/protocol"
import type { EventLog } from "./eventlog.js"
import { runIndex } from "./spend.js"

export type { Receipt }

/** Tools that change the tree. Used only for the "before the first edit" signal. */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"])

export interface ToolCall {
  name: string
  /** Null when the result never came back — an interrupted turn ends this way. */
  ms: number | null
  ok: boolean | null
  /** One line of the arguments: the command, the path, the pattern. */
  detail: string
  /** The tool's own output, as `summarizeToolResult` clipped it. */
  summary: string
}

export interface RunSummary {
  runId: string
  /** The human's message, verbatim. This is the thing being asked about. */
  prompt: string
  images: number
  startedAt: number
  endedAt: number
  wallMs: number
  /** Union, not sum — parallel tool calls share one interval. */
  toolMs: number
  /** Time a permission prompt sat unanswered. The human's, not the model's. */
  blockedMs: number
  /**
   * Time inside an assistant message: thinking and generation together.
   *
   * Null when the run carries no `assistant.start` events — a task run has no
   * partial stream and so no anchor to measure from. Null means "this log cannot
   * say", and the renderer prints one model bucket rather than guessing.
   */
  generatingMs: number | null
  status: RunStatus | "unfinished"
  subtype: string
  costUsd: number
  spend: Record<string, ModelSpend>
  /** SDK agentic steps, not aide turns. One aide turn is one RunSummary. */
  steps: number
  calls: ToolCall[]
  denials: Array<{ tool: string; reason: string }>
  retries: number
  /** Permission prompts the human was asked to answer. */
  asks: number
}

// ---------------------------------------------------------------------------
// Deriving
// ---------------------------------------------------------------------------

/**
 * Total time covered by a set of spans, counting overlap once.
 *
 * The sum would be wrong, and confidently so. Tool results arrive batched in the
 * message after the calls, so three parallel `Read`s share a start stamp and an
 * end stamp; summing them reports three times the elapsed time and a receipt
 * claiming eight minutes of tool work inside a four-minute turn. The union is
 * also what makes the batching harmless: one interval in, one interval out.
 */
export function mergedMs(spans: Array<[number, number]>): number {
  const sorted = spans.filter(([a, b]) => b >= a).sort((x, y) => x[0] - y[0])
  let total = 0
  let openFrom: number | null = null
  let openTo = 0
  for (const [from, to] of sorted) {
    if (openFrom === null) {
      openFrom = from
      openTo = to
    } else if (from <= openTo) {
      openTo = Math.max(openTo, to)
    } else {
      total += openTo - openFrom
      openFrom = from
      openTo = to
    }
  }
  return openFrom === null ? total : total + (openTo - openFrom)
}

/**
 * The denials that the failed-call list does not already account for.
 *
 * A refused call is ONE event that reaches this file twice. The SDK answers a
 * denial by handing the model an error tool_result, so the call closes with
 * `ok: false` and lands in `failed`; the same refusal is also listed in the
 * result's `permissionDenials`, which is where the count is authoritative.
 * Printing both put one denied `Bash` into "What went wrong" as two bullets —
 * the real one carrying the policy's message, and a second reading "no reason
 * recorded". A section whose whole job is to say what went wrong must not
 * inflate its own count.
 *
 * Matched by name and message rather than by id, because neither event carries
 * a `toolUseId` — `permissionDenials` is a summary the SDK writes at the end of
 * the run, not a pointer back into it.
 *
 * The empty-reason case is the one this exists for and the one where matching
 * on name alone is safe: a denial with no message came from the SDK's own audit
 * list, which means the SDK resolved it, which means there IS a failed call for
 * it. A denial that DOES carry a reason is only absorbed by a call whose output
 * repeats it — otherwise it survives, because dropping a stated reason on the
 * strength of an unrelated failure of the same tool would lose the one thing
 * worth reading.
 */
export function unexplainedDenials(
  failed: readonly ToolCall[],
  denials: ReadonlyArray<{ tool: string; reason: string }>,
): Array<{ tool: string; reason: string }> {
  const claimed = new Set<ToolCall>()
  return denials.filter((d) => {
    const reason = d.reason.trim()
    const hit = failed.find(
      (c) =>
        !claimed.has(c) &&
        c.name === d.tool &&
        (reason === "" || c.summary.includes(reason)),
    )
    if (!hit) return true
    claimed.add(hit)
    return false
  })
}

/** One line of a tool's arguments — enough to know what it touched. */
function describeInput(input: unknown): string {
  const args = (input ?? {}) as Record<string, unknown>
  const pick = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : "")
  const first =
    pick("command") ||
    pick("file_path") ||
    pick("pattern") ||
    pick("path") ||
    pick("url") ||
    pick("description") ||
    pick("prompt")
  // Collapsed onto one line: a heredoc inside a Bash command would otherwise
  // break the table this gets printed into.
  const line = first.replace(/\s+/g, " ").trim().slice(0, 160)
  // Named rather than left empty. Some tools take none of these keys —
  // `AskUserQuestion` is one — and an empty string renders as a pair of
  // backticks with nothing between them, which reads as a bug in the receipt
  // rather than as a call that had nothing to show.
  return line || "(no arguments)"
}

/**
 * One run log into one turn's worth of numbers.
 *
 * Pure, and exported for it. Everything interesting here is arithmetic over an
 * array, and the arithmetic is where this can be wrong in ways nobody notices —
 * an unpaired tool call, a permission prompt billed to the model as thinking, a
 * turn that never ended. `smoke:queue` checks it against events built by hand.
 */
export function summarizeRun(runId: string, events: RunEvent[]): RunSummary {
  const summary: RunSummary = {
    runId,
    prompt: "",
    images: 0,
    startedAt: events[0]?.ts ?? 0,
    endedAt: events.at(-1)?.ts ?? 0,
    wallMs: 0,
    toolMs: 0,
    blockedMs: 0,
    generatingMs: null,
    status: "unfinished",
    subtype: "",
    costUsd: 0,
    spend: {},
    steps: 0,
    calls: [],
    denials: [],
    retries: 0,
    asks: 0,
  }
  summary.wallMs = Math.max(0, summary.endedAt - summary.startedAt)

  const toolSpans: Array<[number, number]> = []
  const blockedSpans: Array<[number, number]> = []
  const generateSpans: Array<[number, number]> = []
  const openTools = new Map<string, { at: number; call: ToolCall }>()
  const openAsks = new Map<string, number>()
  /** Set while an assistant message is in flight; cleared by the next event. */
  let messageFrom: number | null = null

  for (const e of events) {
    // ANY event closes the message that was in flight. The durable events an
    // assistant message produces are appended once it is complete, so the next
    // stamp of any kind is when it stopped — and doing it this way rather than
    // only on assistant.* also covers the turn interrupted mid-message, which
    // leaves an anchor followed by a result and nothing in between.
    if (messageFrom !== null && e.type !== "assistant.start") {
      generateSpans.push([messageFrom, e.ts])
      messageFrom = null
    }

    switch (e.type) {
      case "user.message":
        // The FIRST one. The only other `user.message` a live run's log can hold
        // is the SDK echoing back the prompt aide already wrote down itself.
        if (!summary.prompt) {
          summary.prompt = e.text
          summary.images = e.images?.length ?? 0
        }
        break
      case "assistant.start":
        messageFrom = e.ts
        break
      case "tool.start": {
        const call: ToolCall = {
          name: e.name,
          ms: null,
          ok: null,
          detail: describeInput(e.input),
          summary: "",
        }
        summary.calls.push(call)
        openTools.set(e.toolUseId, { at: e.ts, call })
        break
      }
      case "tool.end": {
        const open = openTools.get(e.toolUseId)
        if (!open) break
        open.call.ms = Math.max(0, e.ts - open.at)
        open.call.ok = e.ok
        open.call.summary = e.summary
        toolSpans.push([open.at, e.ts])
        openTools.delete(e.toolUseId)
        break
      }
      case "tool.denied":
        summary.denials.push({ tool: e.name, reason: e.reason })
        break
      case "permission.request":
        summary.asks += 1
        openAsks.set(e.requestId, e.ts)
        break
      case "permission.resolved": {
        const at = openAsks.get(e.requestId)
        if (at !== undefined) blockedSpans.push([at, e.ts])
        openAsks.delete(e.requestId)
        break
      }
      case "run.retry":
        summary.retries += 1
        break
      case "run.finished":
        summary.status = e.status
        summary.subtype = e.subtype
        summary.costUsd = e.totalCostUsd
        summary.spend = e.modelUsage
        summary.steps = e.numTurns
        // The result's own denial list wins. `tool.denied` comes from a callback
        // that only sees calls the SDK did not already resolve, so it is a gate
        // rather than an audit log and undercounts by however many the SDK
        // refused on its own.
        if (e.permissionDenials.length) summary.denials = e.permissionDenials
        break
      case "run.error":
        summary.status = "failed"
        summary.subtype = "run.error"
        break
      default:
        break
    }
  }

  summary.toolMs = mergedMs(toolSpans)
  summary.blockedMs = mergedMs(blockedSpans)
  if (generateSpans.length) summary.generatingMs = mergedMs(generateSpans)
  return summary
}

// ---------------------------------------------------------------------------
// Finding the runs
// ---------------------------------------------------------------------------

/**
 * Which run logs belong to a conversation, oldest first.
 *
 * The scan itself lives in `spend.ts`, which the chat list already asks on every
 * poll and which remembers what it read. There is still no index from session to
 * run and no database — the brief is explicit about not adding one until
 * run-history queries hurt — but a receipt that reuses the list's cache pays for
 * nothing twice, and the two had the same subtle header-scan in them.
 *
 * A turn that died before the SDK named its session has no `run.started` and is
 * invisible here. That omission is real and there is nothing to fix it with —
 * the log never learned which conversation it belonged to.
 */
async function runsForSession(sessionId: string): Promise<string[]> {
  const runs = (await runIndex()).filter((r) => r.sessionId === sessionId)
  // By when the log opened, not by filename: run ids are random, and mtime is
  // when the turn ENDED, which reorders a long turn behind a short one that
  // started after it.
  return runs.sort((a, b) => a.openedAt - b.openedAt).map((r) => r.runId)
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function dur(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  // Rounded to whole seconds FIRST, then split. Taking the minutes off before
  // rounding the remainder prints "128m 60s" for anything in the last half
  // second of a minute, which is how a receipt ends up saying a number that does
  // not exist.
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`
}

const compact = (n: number): string =>
  n < 1000
    ? String(n)
    : n < 1_000_000
      ? `${(n / 1000).toFixed(1)}k`
      : `${(n / 1_000_000).toFixed(2)}M`

const money = (n: number): string => `$${n.toFixed(n < 1 ? 4 : 2)}`

const stamp = (ms: number): string =>
  ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) : "?"

/** Every line prefixed, so a multi-line prompt stays one blockquote. */
const quote = (text: string): string =>
  text.trim()
    ? text
        .trim()
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n")
    : "> _(no text)_"

/** The conversation's name, taken from what opened it. */
const titleOf = (runs: RunSummary[]): string => {
  const first = runs[0]?.prompt.trim().split("\n")[0]?.trim() ?? ""
  return first.length > 80 ? `${first.slice(0, 80)}…` : first || "(untitled conversation)"
}

function render(opts: { project: Project; sessionId: string; runs: RunSummary[] }): string {
  const { runs } = opts
  const out: string[] = []

  if (!runs.length) {
    return [
      `# aide receipt`,
      "",
      `${opts.project.name} · session \`${opts.sessionId}\``,
      "",
      "aide has no run log for this conversation, so there is nothing to measure.",
      "That is the ordinary answer for a chat held somewhere else: the CLI and the",
      "VS Code extension write to the same session store aide reads, but only turns",
      "aide itself ran leave an event log behind.",
    ].join("\n")
  }

  const wallMs = runs.reduce((n, r) => n + r.wallMs, 0)
  const toolMs = runs.reduce((n, r) => n + r.toolMs, 0)
  const blockedMs = runs.reduce((n, r) => n + r.blockedMs, 0)
  const modelMs = Math.max(0, wallMs - toolMs - blockedMs)
  // Null unless EVERY turn can answer. A conversation mixing anchored and
  // unanchored turns has no split to state for the whole of it, and printing a
  // partial one as a total understates thinking by however many turns were
  // missing their anchors — silently, and in the flattering direction.
  const generatingMs = runs.every((r) => r.generatingMs !== null)
    ? runs.reduce((n, r) => n + (r.generatingMs ?? 0), 0)
    : null
  const cost = runs.reduce((n, r) => n + r.costUsd, 0)
  const calls = runs.flatMap((r) => r.calls)
  const failed = calls.filter((c) => c.ok === false)
  const denials = unexplainedDenials(failed, runs.flatMap((r) => r.denials))
  const retries = runs.reduce((n, r) => n + r.retries, 0)
  const asks = runs.reduce((n, r) => n + r.asks, 0)

  const spend = new Map<string, ModelSpend>()
  for (const run of runs) {
    for (const [model, use] of Object.entries(run.spend)) {
      const before = spend.get(model)
      spend.set(model, {
        inputTokens: (before?.inputTokens ?? 0) + use.inputTokens,
        outputTokens: (before?.outputTokens ?? 0) + use.outputTokens,
        cacheReadInputTokens: (before?.cacheReadInputTokens ?? 0) + use.cacheReadInputTokens,
        cacheCreationInputTokens:
          (before?.cacheCreationInputTokens ?? 0) + use.cacheCreationInputTokens,
        costUSD: (before?.costUSD ?? 0) + use.costUSD,
      })
    }
  }

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

  out.push(`# aide receipt — ${titleOf(runs)}`)
  out.push("")
  out.push(`${opts.project.name} · session \`${opts.sessionId}\` · ${plural(runs.length, "turn")}`)
  out.push(`${stamp(runs[0]?.startedAt ?? 0)} → ${stamp(runs.at(-1)?.endedAt ?? 0)} UTC`)
  out.push("")

  out.push("## Totals")
  out.push("")
  out.push("| | |")
  out.push("| --- | --- |")
  out.push(`| wall clock | ${dur(wallMs)} |`)
  if (generatingMs === null) {
    out.push(`| model | ${dur(modelMs)} — thinking, generation and API latency together |`)
  } else {
    out.push(`| thinking and generating | ${dur(generatingMs)} |`)
    out.push(`| waiting on the API | ${dur(Math.max(0, modelMs - generatingMs))} |`)
  }
  out.push(`| tools | ${dur(toolMs)} over ${plural(calls.length, "call")} |`)
  if (asks) {
    out.push(`| waiting on you | ${dur(blockedMs)} over ${plural(asks, "permission prompt")} |`)
  }
  out.push(`| cost | ${money(cost)} — an estimate; see the note at the end |`)
  for (const [model, use] of spend) {
    out.push(
      `| ${model} | ${compact(use.inputTokens)} in · ${compact(use.outputTokens)} out · ${compact(use.cacheReadInputTokens)} cache read · ${compact(use.cacheCreationInputTokens)} cache write |`,
    )
  }
  out.push("")

  // First, and first on purpose. Durations say where the wall clock went; these
  // are the lines that say where the ASKING went wrong, which is the question
  // this document exists to be asked.
  out.push("## What went wrong")
  out.push("")
  const wrong: string[] = []
  for (const call of failed) {
    wrong.push(`- **\`${call.name}\` failed** — \`${call.detail}\``)
    if (call.summary.trim()) {
      wrong.push(
        ...call.summary
          .trim()
          .split("\n")
          .map((l) => `  > ${l}`),
      )
    }
  }
  // Only the ones the failed list above does not already show — see
  // `unexplainedDenials`. The reason can still be blank here: the SDK's own
  // denial list carries a message for the ones aide refused and nothing for the
  // ones it resolved itself.
  for (const d of denials) {
    wrong.push(`- **\`${d.tool}\` denied** — ${d.reason.trim() || "no reason recorded"}`)
  }
  if (retries) wrong.push(`- ${retries} API retr${retries === 1 ? "y" : "ies"}`)
  runs.forEach((run, i) => {
    if (run.status === "success") return
    // "unfinished" is not a failure. It is a log with no terminal event, which
    // is what a turn in flight looks like — and asking for a receipt mid-turn is
    // a normal thing to do. Reporting it as a failed turn would put a red mark
    // on the turn that is currently going fine.
    wrong.push(
      run.status === "unfinished"
        ? `- turn ${i + 1} has no outcome recorded — still running, or the run died before it could report one`
        : `- turn ${i + 1} ended **${run.status}**${run.subtype ? ` (\`${run.subtype}\`)` : ""}`,
    )
  })
  out.push(
    wrong.length ? wrong.join("\n") : "Nothing failed, nothing was denied, nothing was retried.",
  )
  out.push("")

  const signals: string[] = []
  const firstEdit = calls.findIndex((c) => EDIT_TOOLS.has(c.name))
  if (firstEdit > 0) {
    signals.push(
      `- ${plural(firstEdit, "tool call")} before the first edit — how much of this went on finding where to work.`,
    )
  } else if (firstEdit === -1 && calls.length) {
    signals.push(`- nothing was edited; all ${plural(calls.length, "call")} were reads.`)
  }
  const edits = new Map<string, number>()
  for (const call of calls) {
    if (!EDIT_TOOLS.has(call.name) || !call.detail) continue
    edits.set(call.detail, (edits.get(call.detail) ?? 0) + 1)
  }
  for (const [file, n] of [...edits].filter(([, count]) => count > 1).sort((a, b) => b[1] - a[1])) {
    signals.push(`- \`${file}\` was edited ${n} times.`)
  }
  if (signals.length) {
    out.push("## Signals")
    out.push("")
    out.push(...signals)
    out.push("")
  }

  if (calls.length) {
    const byName = new Map<string, { calls: number; failed: number; ms: number }>()
    for (const call of calls) {
      const row = byName.get(call.name) ?? { calls: 0, failed: 0, ms: 0 }
      row.calls += 1
      if (call.ok === false) row.failed += 1
      row.ms += call.ms ?? 0
      byName.set(call.name, row)
    }
    out.push("## Tools")
    out.push("")
    out.push("| tool | calls | failed | time |")
    out.push("| --- | --- | --- | --- |")
    for (const [name, row] of [...byName].sort((a, b) => b[1].ms - a[1].ms)) {
      out.push(`| ${name} | ${row.calls} | ${row.failed} | ${dur(row.ms)} |`)
    }
    out.push("")
    // Summed here, merged in the totals, and the difference is worth saying out
    // loud: this column answers "how long does this tool take", where two
    // parallel calls really did each take that long, while the total is being
    // subtracted from wall clock and has to count their shared seconds once.
    out.push("_Per-tool time is summed, so parallel calls each count; the total above")
    out.push("counts the wall clock they shared once._")
    out.push("")

    const slowest = [...calls]
      .filter((c) => c.ms !== null)
      .sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0))
      .slice(0, 5)
    if (slowest.length) {
      out.push("### Slowest calls")
      out.push("")
      // Numbered by hand rather than left as markdown's `1.` shorthand: this
      // document is read as raw text far more often than it is rendered, and
      // five lines all starting "1." read as a mistake.
      slowest.forEach((call, i) => {
        out.push(`${i + 1}. ${dur(call.ms ?? 0)} · \`${call.name}\` — \`${call.detail}\``)
      })
      out.push("")
    }
  }

  out.push("## Turns")
  out.push("")
  out.push("The prompts, verbatim. They are what the rest of this document is about.")
  out.push("")
  runs.forEach((run, i) => {
    const bits = [
      run.status,
      dur(run.wallMs),
      plural(run.calls.length, "call"),
      money(run.costUsd),
      plural(run.steps, "model step"),
    ]
    out.push(`### ${i + 1} · ${bits.join(" · ")}`)
    out.push("")
    out.push(quote(run.prompt))
    if (run.images) {
      out.push(">")
      out.push(`> _[${plural(run.images, "image")} attached]_`)
    }
    out.push("")
  })

  out.push("---")
  out.push("")
  out.push("Cost is a client-side **estimate**, from a price table bundled into the Agent")
  out.push("SDK at build time. Fine for judging one turn against another, never for billing.")
  out.push("")
  out.push("Tool time is measured from when a call was delivered to when its result came")
  out.push("back — the closest the log gets. Nothing instruments the tool itself.")
  if (generatingMs === null) {
    out.push("")
    out.push("Some turns here carry no `assistant.start` anchor, so model time is reported as")
    out.push("one bucket: thinking, generation and API latency cannot be told apart.")
  }
  return out.join("\n")
}

// ---------------------------------------------------------------------------

/** The receipt for one conversation. Always answers; no runs is an answer. */
export async function conversationReceipt(
  log: EventLog,
  project: Project,
  sessionId: string,
): Promise<Receipt> {
  const runIds = await runsForSession(sessionId)
  const runs = runIds
    .map((runId) => summarizeRun(runId, log.read(runId)))
    // A log with no events is a turn that was admitted and never wrote anything.
    // A row of zeroes for it would read as a turn that did nothing, rather than
    // as one that never happened.
    .filter((r) => r.startedAt > 0)
  return {
    sessionId,
    runs: runs.length,
    markdown: render({ project, sessionId, runs }),
  }
}
