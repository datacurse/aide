/**
 * Activity across every project, derived from the run logs.
 *
 * The dashboard's whole server side. It is a second reduction over the index
 * `spend.ts` already builds and caches — that one groups by conversation, for a
 * chat row; this one groups by project and by day, for the question the four
 * panes cannot answer because every one of them is scoped to a single project.
 *
 * Nothing here is stored. Every figure is computed on read from
 * `~/.aide/runs/*.ndjson`, which is what makes it impossible for a counter to
 * drift away from the logs it is counting, and what makes deleting a log a
 * legitimate way to make aide forget a run. The brief's first constraint is that
 * state lives in files; this is the same idea one step on — a derived number
 * that is never written down cannot disagree with its source.
 *
 * The arithmetic is pure and lives in `reduceActivity`, separately from the
 * reading, because the failure mode of an aggregate is silence: a total that is
 * wrong by one project's worth looks exactly like a total that is right, and
 * nobody checks a dashboard against the logs by hand. `pnpm smoke` drives that
 * function over a handmade index.
 */
import { createReadStream } from "node:fs"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { createInterface } from "node:readline"
import type {
  Activity,
  ActivityDay,
  CheckRun,
  HourCell,
  ModelUse,
  Outcomes,
  Project,
  ProjectActivity,
  RunEvent,
  ToolUse,
} from "@aide/protocol"
import { runsDir } from "@aide/protocol/node"
import { RunLogCache, runIndex, type RunTotals } from "./spend.js"

/** A day in ms, for the window arithmetic. */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The local calendar day a moment falls in, as `YYYY-MM-DD`.
 *
 * Local rather than UTC, and computed here rather than in the browser. A turn
 * taken at 1am belongs to that date in every sense a person cares about, and
 * `toISOString()` would file it under the day before for anyone west of
 * Greenwich — quietly, and only for the turns you took late at night, which is
 * a bug that hides for months. The daemon runs on the same machine the runs
 * happened on, so its idea of local time is the right one by construction.
 */
export function localDay(at: number): string {
  const d = new Date(at)
  const month = `${d.getMonth() + 1}`.padStart(2, "0")
  const day = `${d.getDate()}`.padStart(2, "0")
  return `${d.getFullYear()}-${month}-${day}`
}

/**
 * Midnight local time, `days` days before the start of today.
 *
 * The window is whole DAYS rather than `now - 7*24h`, because a rolling
 * 168-hour window puts a partial day at the far end of the chart: this morning's
 * work would sit in a bar that is missing the hours before you asked, and the
 * bar would shrink as the day went on. Counting from midnight makes every bar
 * but today's complete and makes the answer stable within a day.
 */
export function windowStart(now: number, days: number): number {
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  return midnight.getTime() - (days - 1) * DAY_MS
}

/**
 * Every day in the window, including the ones with nothing in them.
 *
 * Built by stepping a Date rather than by adding DAY_MS, because a daylight
 * saving boundary is 23 or 25 hours long: adding a fixed day across one drifts
 * the clock and eventually skips or repeats a calendar date. `setDate` is
 * defined to do the calendar thing.
 */
function daysInWindow(from: number, days: number): string[] {
  const out: string[] = []
  const cursor = new Date(from)
  for (let i = 0; i < days; i += 1) {
    out.push(localDay(cursor.getTime()))
    cursor.setDate(cursor.getDate() + 1)
  }
  return out
}

/**
 * Tool calls in one run log, by name.
 *
 * The only figure on the dashboard that needs a log's BODY. `spend.ts` reads
 * just the head and the tail of each file on purpose — the middle is where the
 * transcripts and the pasted screenshots are — so this is deliberately its own
 * pass with its own cache rather than something bolted into `readRun`, and the
 * cost is paid once per log for the life of the daemon.
 *
 * Streamed line by line rather than read whole: the largest logs on this machine
 * are megabytes, and `readFile` on all of them at once is the difference between
 * a steady scan and a heap spike. A torn or oversized line is skipped, because
 * the only line that can be torn is the one being written by a run in flight.
 */
/** What one log's body contributes, gathered in a single read of it. */
export interface RunBody {
  tools: Record<string, { calls: number; failed: number }>
  /** `verify.result`, one entry per check invocation. */
  checks: Array<{ command: string; ok: boolean; ms: number }>
  commits: number
  asks: number
}

const EMPTY_BODY = (): RunBody => ({ tools: {}, checks: [], commits: 0, asks: 0 })

/**
 * Everything the dashboard needs from one run log's BODY, in one pass.
 *
 * One pass rather than one per figure, and that is the whole reason this is
 * shaped as a bag of counters instead of four tidy functions. The head and tail
 * of a log are cheap — `spend.ts` reads those — but the middle is where the
 * transcripts and the pasted screenshots are, so a second traversal of 27MB to
 * count commits after having just traversed it to count tools would double the
 * only expensive thing this file does.
 *
 * Streamed line by line rather than read whole: the largest logs on this machine
 * are megabytes, and `readFile` on all of them at once is the difference between
 * a steady scan and a heap spike. A torn line is skipped, because the only line
 * that can be torn is the one being written by a run in flight.
 */
async function bodyOfRun(path: string): Promise<RunBody> {
  const out = EMPTY_BODY()
  // `tool.end` names no tool — only its id — so the outcome has to be joined
  // back to the call that opened it. One turn's ids, dropped with the run.
  const nameOf = new Map<string, string>()
  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  })
  try {
    for await (const line of rl) {
      // Cheap prefilter before JSON.parse. Most lines in a large log are
      // assistant text or a tool result, and parsing every one of them to
      // discover that costs more than the substring tests that skip them.
      if (
        !line.includes('"tool.') &&
        !line.includes('"verify.result"') &&
        !line.includes('"commit.landed"') &&
        !line.includes('"permission.request"')
      ) {
        continue
      }
      let event: RunEvent
      try {
        event = JSON.parse(line) as RunEvent
      } catch {
        continue
      }
      if (event.type === "tool.start") {
        nameOf.set(event.toolUseId, event.name)
        const before = out.tools[event.name]
        out.tools[event.name] = { calls: (before?.calls ?? 0) + 1, failed: before?.failed ?? 0 }
      } else if (event.type === "tool.end" && !event.ok) {
        const name = nameOf.get(event.toolUseId)
        // An end with no start is a log whose head was rotated or truncated.
        // Counting it under a placeholder would invent a tool; dropping it only
        // undercounts failures, which is the safer of the two.
        if (!name) continue
        const before = out.tools[name]
        if (before) out.tools[name] = { ...before, failed: before.failed + 1 }
      } else if (event.type === "verify.result") {
        out.checks.push({ command: event.command, ok: event.ok, ms: event.durationMs })
      } else if (event.type === "commit.landed") {
        out.commits += 1
      } else if (event.type === "permission.request") {
        out.asks += 1
      }
    }
  } catch {
    // A log that cannot be read contributes nothing. It must not take the whole
    // dashboard down: the headline totals come from a different pass entirely.
  } finally {
    rl.close()
  }
  return out
}

/**
 * What each run log's body held, remembered the way `spend.ts` remembers totals
 * — literally, now: the same `RunLogCache`, so the invalidation rule that makes
 * the in-flight log correct exists once rather than in two copies.
 *
 * That is what makes a body scan affordable at all: 27MB across 667 logs on this
 * machine, read once, then free.
 */
const bodyCache = new RunLogCache<RunBody>()

/** Everything the window's logs hold in their bodies, merged. */
async function bodies(runs: RunTotals[]): Promise<{
  tools: ToolUse[]
  checks: CheckRun[]
  commits: number
  asks: number
}> {
  const tools: Record<string, { calls: number; failed: number }> = {}
  const checks = new Map<string, { passed: number; failed: number; times: number[] }>()
  let commits = 0
  let asks = 0

  for (const run of runs) {
    const file = `${run.runId}.ndjson`
    // Null is a log that vanished between the index being built and here, which
    // contributes nothing rather than taking the dashboard down.
    const body = await bodyCache.get(join(runsDir(), file), file, bodyOfRun)
    if (!body) continue

    for (const [name, use] of Object.entries(body.tools)) {
      const before = tools[name]
      tools[name] = {
        calls: (before?.calls ?? 0) + use.calls,
        failed: (before?.failed ?? 0) + use.failed,
      }
    }
    for (const check of body.checks) {
      const before = checks.get(check.command) ?? { passed: 0, failed: 0, times: [] }
      before[check.ok ? "passed" : "failed"] += 1
      before.times.push(check.ms)
      checks.set(check.command, before)
    }
    commits += body.commits
    asks += body.asks
  }

  return {
    tools: Object.entries(tools)
      .map(([name, use]) => ({ name, ...use }))
      .sort((a, b) => b.calls - a.calls),
    checks: [...checks.entries()]
      .map(([command, c]) => ({
        command,
        passed: c.passed,
        failed: c.failed,
        medianMs: median(c.times),
      }))
      // Failing checks first: a gate that has started refusing commits is the
      // thing you came to this section to find, and sorting by volume buries it
      // under the four that pass every time.
      .sort((a, b) => b.failed - a.failed || b.passed + b.failed - (a.passed + a.failed)),
    commits,
    asks,
  }
}

/** Middle value, or 0 for nothing. Sorted copy — the caller's array is its own. */
export function median(ns: number[]): number {
  if (ns.length === 0) return 0
  const sorted = [...ns].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

/**
 * A percentile, by nearest rank.
 *
 * Nearest-rank rather than interpolated: these are wall-clock times of real
 * turns, and answering "the 90th percentile turn took 506s" with a number no
 * turn actually took is a worse answer for a page whose whole claim is that
 * nothing on it is invented.
 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const rank = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))] ?? 0
}

/**
 * Runs that really did die before the SDK named a session.
 *
 * `runIndex` drops every log with no `run.started`, and the obvious count —
 * logs on disk minus logs indexed — is badly wrong. On this machine it reports
 * 294 of 667, which reads as "44% of your turns vanished" and is almost entirely
 * false: 266 of those are `{"type":"run.queued"}` logs written on one day in
 * August by the task queue, a design that no longer exists. `run.queued` appears
 * nowhere in the current protocol, so nothing but this function will ever meet
 * one again.
 *
 * A number nobody can act on and that overstates the problem twentyfold is worse
 * than no number: the first thing it costs is trust in every other figure on the
 * page. So a log only counts here if it holds an event this aide still writes —
 * which leaves the case the figure is actually for, a turn whose daemon died
 * between the first event and the SDK's reply.
 *
 * Bounded by `HEAD_SCAN` lines rather than reading each file, for the reason
 * `sessionOfRun` gives: line 1 can carry a pasted screenshot as base64, so
 * "read a bit of the front" has to mean lines, not bytes.
 */
async function unattributedRuns(indexed: Set<string>): Promise<number> {
  try {
    const files = (await readdir(runsDir())).filter((f) => f.endsWith(".ndjson"))
    let lost = 0
    for (const file of files) {
      if (indexed.has(file.slice(0, -".ndjson".length))) continue
      if (await isLiveFormat(join(runsDir(), file))) lost += 1
    }
    return lost
  } catch {
    return 0
  }
}

/** How far into an unindexed log to look before calling it someone else's format. */
const HEAD_SCAN = 4

/**
 * Whether a log was written by an aide that still exists.
 *
 * True when its first few events are ones the current protocol declares. A
 * `run.queued` log fails on its first line and costs one read of one line.
 */
async function isLiveFormat(path: string): Promise<boolean> {
  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  })
  try {
    let seen = 0
    for await (const line of rl) {
      if (!line.trim()) continue
      if (++seen > HEAD_SCAN) return false
      let event: RunEvent
      try {
        event = JSON.parse(line) as RunEvent
      } catch {
        continue
      }
      // The events that open a log this aide writes. `run.started` is absent by
      // construction — that is what made this log unindexed in the first place.
      if (
        event.type === "user.message" ||
        event.type === "checkpoint.taken" ||
        event.type === "commit.step"
      ) {
        return true
      }
    }
    return false
  } catch {
    return false
  } finally {
    rl.close()
  }
}

/**
 * The whole dashboard, from an index and a registry. Pure, and therefore tested.
 *
 * Takes `now` rather than reading the clock so the window is reproducible, which
 * is what lets `pnpm smoke` assert that a run from eight days ago is outside a
 * seven-day window and one from this morning is inside it. A function that
 * called `Date.now()` itself could only be tested by mocking the clock.
 */
export function reduceActivity(
  all: RunTotals[],
  projects: Project[],
  now: number,
  days: number,
  body: { tools: ToolUse[]; checks: CheckRun[]; commits: number; asks: number },
  unattributed: number,
): Activity {
  const from = windowStart(now, days)
  const runs = all.filter((r) => r.openedAt >= from)

  const byDay = new Map<string, ActivityDay>()
  for (const day of daysInWindow(from, days)) {
    byDay.set(day, { day, runs: 0, activeMs: 0, costUsd: 0, tokens: 0 })
  }
  const byProject = new Map<string, ProjectActivity & { sessions: Set<string> }>()
  const byModel = new Map<string, ModelUse>()
  const sessions = new Set<string>()

  // Every one of the 168 cells, including the empty ones — the grid is the
  // shape, and a sparse map would leave the renderer inventing the gaps.
  const hours = new Map<string, HourCell>()
  for (let weekday = 0; weekday < 7; weekday += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      hours.set(`${weekday}:${hour}`, { weekday, hour, runs: 0 })
    }
  }
  const outcomes: Outcomes = { success: 0, cancelled: 0, failed: 0 }
  const finished: number[] = []

  for (const run of runs) {
    sessions.add(run.sessionId)

    const when = new Date(run.openedAt)
    // JS weekday is 0=Sunday; the grid is drawn Monday-first, so shift here —
    // once, where the data is built — rather than in the renderer, where the
    // off-by-one would mislabel every row and look like a data bug.
    const cell = hours.get(`${(when.getDay() + 6) % 7}:${when.getHours()}`)
    if (cell) cell.runs += 1

    // A turn still in flight has no outcome yet and is counted in none of them.
    if (run.status === "success") outcomes.success += 1
    else if (run.status === "cancelled") outcomes.cancelled += 1
    else if (run.status !== null) outcomes.failed += 1
    // Zero-duration turns are the ones that never ran; including them would
    // drag the median toward a number describing nothing that happened.
    if (run.activeMs > 0) finished.push(run.activeMs)

    const day = byDay.get(localDay(run.openedAt))
    // A run outside the window cannot reach here, so a missing bucket would be
    // a bug in the window arithmetic rather than ordinary data. Skipping is
    // still right: a dashboard is not worth a crash.
    if (day) {
      day.runs += 1
      day.activeMs += run.activeMs
      day.costUsd += run.costUsd
      day.tokens += run.tokens
    }

    const known = projects.find((p) => p.id === run.projectId)
    const row = byProject.get(run.projectId) ?? {
      projectId: run.projectId,
      // Null rather than a dropped row: run logs outlive the project they were
      // taken in, and dropping them would make the totals at the top of the
      // page disagree with the sum of the table underneath.
      name: known?.name ?? null,
      host: known?.host ?? null,
      runs: 0,
      chats: 0,
      activeMs: 0,
      costUsd: 0,
      tokens: 0,
      lastRunAt: null,
      share: 0,
      sessions: new Set<string>(),
    }
    row.runs += 1
    row.activeMs += run.activeMs
    row.costUsd += run.costUsd
    row.tokens += run.tokens
    row.sessions.add(run.sessionId)
    row.lastRunAt = Math.max(row.lastRunAt ?? 0, run.openedAt)
    byProject.set(run.projectId, row)

    for (const [model, use] of Object.entries(run.byModel)) {
      const before = byModel.get(model)
      byModel.set(model, {
        model,
        costUsd: (before?.costUsd ?? 0) + use.costUsd,
        tokens: (before?.tokens ?? 0) + use.tokens,
      })
    }
  }

  const tokens = runs.reduce((n, r) => n + r.tokens, 0)
  // Sorted once and shared by all three percentile reads below.
  const sortedFinished = [...finished].sort((a, b) => a - b)
  const projectRows = [...byProject.values()]
    .map(({ sessions: chats, ...row }) => ({
      ...row,
      chats: chats.size,
      // Against the window's tokens, not the machine's: this is "how much of
      // what I did was this project", and the row sits in a table whose other
      // rows are the rest of that same window.
      share: tokens ? row.tokens / tokens : 0,
    }))
    .sort((a, b) => b.tokens - a.tokens)

  return {
    days,
    readAt: now,
    runs: runs.length,
    chats: sessions.size,
    activeMs: runs.reduce((n, r) => n + r.activeMs, 0),
    costUsd: runs.reduce((n, r) => n + r.costUsd, 0),
    tokens,
    daily: [...byDay.values()],
    projects: projectRows,
    tools: body.tools,
    models: [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd),
    hours: [...hours.values()],
    outcomes,
    checks: body.checks,
    durations: {
      p50Ms: percentile(sortedFinished, 50),
      p90Ms: percentile(sortedFinished, 90),
      maxMs: sortedFinished[sortedFinished.length - 1] ?? 0,
      counted: sortedFinished.length,
    },
    commits: body.commits,
    asks: body.asks,
    unattributed,
    lifetime: {
      runs: all.length,
      activeMs: all.reduce((n, r) => n + r.activeMs, 0),
      costUsd: all.reduce((n, r) => n + r.costUsd, 0),
      tokens: all.reduce((n, r) => n + r.tokens, 0),
      since: all.length ? Math.min(...all.map((r) => r.openedAt)) : null,
    },
  }
}

/** The dashboard, read from this machine's logs. */
export async function activity(projects: Project[], days: number): Promise<Activity> {
  const all = await runIndex()
  const from = windowStart(Date.now(), days)
  // Bodies are read for the WINDOW's runs only, unlike the lifetime totals
  // above. Those come from an index that is already in memory; this one opens
  // files, and scanning every log aide has ever written to draw one bar chart
  // of the last week is the whole-history read this design exists to avoid.
  const [body, unattributed] = await Promise.all([
    bodies(all.filter((r) => r.openedAt >= from)),
    unattributedRuns(new Set(all.map((r) => r.runId))),
  ])
  return reduceActivity(all, projects, Date.now(), days, body, unattributed)
}
