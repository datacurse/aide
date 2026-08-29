/**
 * What every conversation spent, cheap enough to put on every row of the list.
 *
 * The event log already holds this — each run log ends in a `run.finished`
 * carrying the SDK's duration, its cost estimate and its per-model token counts
 * — but `receipt.ts` reads it one conversation at a time, on a button press. The
 * list asks about thirty conversations every poll, so this is the same data read
 * the other way round: one pass over `~/.aide/runs`, an index from session to
 * totals, held until a log changes underneath it.
 *
 * Two reads per log and neither is the whole file. `run.started` is line 2 or 3
 * and is the only event carrying a session id; `run.finished` is the last line,
 * because `chat.ts` guarantees a log ends in exactly one terminal event. The
 * middle is where the transcripts and the pasted screenshots are, and nothing
 * here needs it.
 *
 * Every figure is an estimate, and the cost one doubly so — it comes from a
 * price table bundled into the SDK at build time. Fine for a dashboard, never
 * for billing, which is why the row says so when you hover it.
 */
import { createReadStream } from "node:fs"
import { open, readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { createInterface } from "node:readline"
import type { ChatSpend, RunEvent } from "@aide/protocol"
import { runsDir } from "@aide/protocol/node"

/**
 * How far into a run log to look for `run.started` before giving up.
 *
 * It is line 2 or 3 — `user.message`, `checkpoint.taken`, then the SDK's init.
 * The bound is not an optimisation, it is a refusal to read a whole log looking
 * for an event that a turn which died before it spawned is never going to have.
 */
const HEADER_LINES = 8

/**
 * How much of the end of a log to read looking for its terminal event.
 *
 * The line itself is a few hundred bytes. The window is this wide because the
 * line before it can be a tool result several kilobytes long, and a window that
 * only reached into the middle of one would find no whole line at all.
 */
const TAIL_BYTES = 64 * 1024

/** One run log, reduced to what a list row and a receipt need from it. */
export interface RunTotals {
  runId: string
  sessionId: string
  /** epoch ms of the log's first event — when the turn opened, not when it ended. */
  openedAt: number
  /** The SDK's own duration for the turn. Zero while the turn is still running. */
  activeMs: number
  costUsd: number
  /** Input, output, cache read and cache write together. See `spendBySession`. */
  tokens: number
}

/**
 * Run logs are append-only and a finished one never changes again, so a log is
 * read once per daemon and then remembered. Keyed by size and mtime rather than
 * by name: that is what makes the turn currently in flight — the one log that
 * does change — reread on the next poll instead of frozen at its first reading.
 */
const cache = new Map<string, { key: string; totals: RunTotals | null }>()

/**
 * How long a scan of the directory itself stands.
 *
 * The per-log cache above already stops the reading; this stops the `stat` of
 * every log, which one browser poll would otherwise do twice — the chat list and
 * the open conversation both ask, a few milliseconds apart. Shorter than the
 * poll interval, so the numbers still land on the poll after the turn that
 * earned them.
 */
const SCAN_FRESH_MS = 1_000

let scan: { at: number; runs: Promise<RunTotals[]> } | null = null

/** Every run log on this machine, in no particular order. */
export async function runIndex(): Promise<RunTotals[]> {
  if (scan && Date.now() - scan.at < SCAN_FRESH_MS) return scan.runs
  const runs = scanRuns()
  scan = { at: Date.now(), runs }
  // A failed scan must not be remembered as the answer for the next second.
  runs.catch(() => {
    scan = null
  })
  return runs
}

async function scanRuns(): Promise<RunTotals[]> {
  let files: string[]
  try {
    files = await readdir(runsDir())
  } catch {
    // No runs directory at all: a daemon that has never taken a turn.
    return []
  }

  const out: RunTotals[] = []
  const present = new Set<string>()
  for (const file of files) {
    if (!file.endsWith(".ndjson")) continue
    present.add(file)
    const path = join(runsDir(), file)
    let key: string
    try {
      const info = await stat(path)
      key = `${info.size}:${info.mtimeMs}`
    } catch {
      continue
    }
    const hit = cache.get(file)
    const totals =
      hit?.key === key ? hit.totals : await readRun(path, file.slice(0, -".ndjson".length))
    cache.set(file, { key, totals })
    if (totals) out.push(totals)
  }
  // A log that has been deleted is not coming back, and a daemon that runs for
  // weeks should not go on holding the history of a directory it no longer
  // matches.
  for (const file of [...cache.keys()]) if (!present.has(file)) cache.delete(file)
  return out
}

/**
 * Session id to what the conversation spent.
 *
 * Only turns aide itself ran are in here. A chat held in the CLI or the VS Code
 * extension writes to the same session store aide reads but leaves no event log,
 * so it is absent rather than zero — and the row shows nothing rather than
 * claiming that conversation was free.
 *
 * `usageShare` is measured against every token in the index, not against the
 * project being looked at, because "how much of my usage did this eat" is a
 * question about the machine. Cache reads are counted in: they are the bulk of a
 * long conversation's tokens and they are billed, at a discount — leaving them
 * out would rank a twenty-turn conversation below a one-shot that wrote more
 * code. It is not the plan utilisation figure `/usage` reports, and nothing
 * per-conversation could be: a plan window is measured across every client at
 * once, and aide is one of them.
 */
export async function spendBySession(): Promise<Map<string, ChatSpend>> {
  const runs = await runIndex()
  const allTokens = runs.reduce((n, r) => n + r.tokens, 0)

  const out = new Map<string, ChatSpend>()
  for (const run of runs) {
    const before = out.get(run.sessionId)
    out.set(run.sessionId, {
      turns: (before?.turns ?? 0) + 1,
      activeMs: (before?.activeMs ?? 0) + run.activeMs,
      costUsd: (before?.costUsd ?? 0) + run.costUsd,
      tokens: (before?.tokens ?? 0) + run.tokens,
      usageShare: 0,
    })
  }
  for (const [sessionId, spend] of out) {
    out.set(sessionId, { ...spend, usageShare: allTokens ? spend.tokens / allTokens : 0 })
  }
  return out
}

async function readRun(path: string, runId: string): Promise<RunTotals | null> {
  const head = await sessionOfRun(path)
  // A turn that died before the SDK named its session has no `run.started` and
  // is invisible here. That omission is real and there is nothing to fix it
  // with — the log never learned which conversation it belonged to.
  if (!head) return null

  const totals: RunTotals = {
    runId,
    sessionId: head.sessionId,
    openedAt: head.at,
    activeMs: 0,
    costUsd: 0,
    tokens: 0,
  }

  const end = await terminalEvent(path)
  // Anything else means the turn has not finished — or that it ended in
  // `run.error`, which carries no numbers. Zeroes are the honest answer either
  // way, and the row prints a turn with none as running rather than as free.
  if (end?.type === "run.finished") {
    totals.activeMs = end.durationMs
    totals.costUsd = end.totalCostUsd
    for (const use of Object.values(end.modelUsage)) {
      totals.tokens +=
        use.inputTokens + use.outputTokens + use.cacheReadInputTokens + use.cacheCreationInputTokens
    }
  }
  return totals
}

/**
 * The session a run log belongs to, and when that log opened.
 *
 * Read only as far as `run.started`; breaking the loop closes the stream.
 * Reading a fixed prefix of bytes instead would have been simpler and quietly
 * wrong: `user.message` is line 1 and carries pasted screenshots inline as
 * base64, so any turn with an attachment puts megabytes in front of the line
 * being looked for.
 */
export async function sessionOfRun(
  path: string,
): Promise<{ sessionId: string; at: number } | null> {
  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  })
  try {
    let seen = 0
    let openedAt = 0
    for await (const line of rl) {
      if (!line.trim()) continue
      if (++seen > HEADER_LINES) return null
      let event: RunEvent
      try {
        event = JSON.parse(line) as RunEvent
      } catch {
        // A torn line can only be one being written right now, in a run that is
        // too young to be asked about anyway.
        continue
      }
      if (!openedAt) openedAt = event.ts
      if (event.type === "run.started" && event.sessionId) {
        return { sessionId: event.sessionId, at: openedAt || event.ts }
      }
    }
    return null
  } catch {
    return null
  } finally {
    rl.close()
  }
}

/**
 * How a run ended, read from the end of its log.
 *
 * Scans backwards for a TERMINAL event rather than taking the last line and
 * checking it, and the difference is not pedantry. The invariant — a log ends in
 * exactly one terminal event — held for 423 of this machine's 432 logs and not
 * for the rest: one had a stray `assistant.start` land after its `run.finished`,
 * which is the SDK reporting a message for a turn that had already ended. Taking
 * the last line called that run unfinished forever, so it billed as $0 and its
 * row read "running" for good, over a log that plainly said what it cost two
 * lines up.
 *
 * `EventLog.append` seals a run at its terminal event now, so no new log can
 * gain a straggler. This is what makes the ones already written readable.
 *
 * Null means no terminal event in the window, which is what a turn still in
 * flight looks like — and, before boot reconciliation, what a turn whose daemon
 * died looked like forever.
 */
export async function terminalEvent(path: string): Promise<RunEvent | null> {
  let fh: Awaited<ReturnType<typeof open>>
  try {
    fh = await open(path, "r")
  } catch {
    return null
  }
  try {
    const size = (await fh.stat()).size
    if (size === 0) return null
    const from = Math.max(0, size - TAIL_BYTES)
    const buf = Buffer.alloc(size - from)
    await fh.read(buf, 0, buf.length, from)
    const lines = buf.toString("utf8").split("\n")
    // Starting at a byte offset lands mid-line, and mid-character with it. The
    // first fragment is never a whole event, so drop it rather than let a
    // half-decoded one through.
    if (from > 0) lines.shift()
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]?.trim()
      if (!line) continue
      let event: RunEvent
      try {
        event = JSON.parse(line) as RunEvent
      } catch {
        // A torn line. Only the one being written right now can be torn, so it
        // is skipped rather than returned — and skipping rather than giving up
        // is what lets the terminal event one line above it still be found.
        continue
      }
      if (event.type === "run.finished" || event.type === "run.error") return event
    }
    return null
  } catch {
    return null
  } finally {
    await fh.close().catch(() => {})
  }
}
