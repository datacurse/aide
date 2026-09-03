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
  ActiveDay,
  Activity,
  ActivityDay,
  CheckRun,
  HourCell,
  IdleStretch,
  ModelUse,
  Outcomes,
  Project,
  ProjectActivity,
  RunEvent,
  RunEventType,
  Sitting,
  TimeSplit,
  ToolUse,
  WorkSplit,
} from "@aide/protocol"
import { runsDir } from "@aide/protocol/node"
import { RunLogCache, runIndex, scanHead, type RunTotals } from "./spend.js"

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
 * The event types `bodyOfRun` counts, and the source of its prefilter.
 *
 * One list rather than two, because the two were a silent-failure pair: the
 * prefilter below skips a line before `JSON.parse` sees it, so an event added to
 * the reducer and not to the filter is dropped with no error, no failed check,
 * and nothing a grep for the new event's name would find. Deriving the strings
 * from the list means adding a counter cannot forget to widen the filter.
 *
 * `as const` so the entries are literal types: a name that is not a real
 * `RunEventType` fails to compile here rather than silently matching nothing.
 */
const COUNTED = [
  "tool.start",
  "tool.end",
  "verify.result",
  "commit.landed",
  "permission.request",
] as const satisfies readonly RunEventType[]

/**
 * What a counted line looks like on the wire, as a substring test.
 *
 * The quotes matter: `"tool.start"` cannot match a tool RESULT that happens to
 * contain the words, which a bare `tool.start` would. This is the one place the
 * events are matched as text rather than as parsed objects, and it is worth the
 * awkwardness — most lines in a large log are assistant prose or a tool result,
 * and parsing every one of them to find that out costs more than the test that
 * skips them.
 */
const COUNTED_MARKERS = COUNTED.map((type) => `"${type}"`)

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
      // Cheap prefilter before JSON.parse — see `COUNTED`, which is where the
      // list of what survives it lives, next to the reducer that consumes them.
      if (!COUNTED_MARKERS.some((marker) => line.includes(marker))) continue
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
  const hit = await scanHead(path, HEAD_SCAN, (event) =>
    // The events that open a log this aide writes. `run.started` is absent by
    // construction — that is what made this log unindexed in the first place.
    event.type === "user.message" ||
    event.type === "checkpoint.taken" ||
    event.type === "commit.step"
      ? true
      : undefined,
  )
  return hit ?? false
}

/**
 * How long a gap between turns before you were no longer at the machine.
 *
 * The one judgement call in this file, and it is a threshold rather than a
 * measurement because nothing in a run log records whether anybody was looking
 * at the screen. What the logs DO say, measured across this machine's 438 runs:
 * in-sitting gaps have a median of 57s and a 90th percentile of 8m, which is
 * the shape of reading a diff and typing the next thing. The distribution is
 * bimodal with a wide empty middle — the next thing above it is hours — so the
 * answer is robust to where in that valley the line is drawn. At 15 minutes the
 * machine reads 80% busy over 49 sittings, at 30 minutes 72% over 37, at 60
 * minutes 60% over 23; the ratio moves smoothly and no threshold in that range
 * changes the conclusion.
 *
 * 30 minutes because it is the point where single-turn sittings stop being
 * common (7 of 37, against 13 of 49 at fifteen). A sitting of one turn has no
 * gaps in it, so it contributes span == active and reports as 100% busy — a
 * threshold that manufactures those is one that flatters the number.
 *
 * Not a setting. A knob here would let the figure be tuned until it said what
 * you wanted, which for a number whose whole job is to be uncomfortable is the
 * one thing it must not do — the same reasoning as the brief's one repair
 * attempt.
 */
export const IDLE_BREAK_MS = 30 * 60 * 1000

/**
 * Consecutive turns clustered into stretches of working at the machine.
 *
 * Takes runs in any order and sorts its own copy: `runIndex` is a directory
 * listing, so it arrives in whatever order the filesystem gives, and clustering
 * an unsorted list silently produces one sitting per run.
 *
 * A turn's interval is `[openedAt, openedAt + activeMs]`. Those can OVERLAP —
 * one agent per project, but several projects run at once — so the end of a
 * sitting is the max of the ends rather than the last one seen, or a long turn
 * followed by a short one would end the sitting early and count the remainder
 * of the long one as your time.
 */
export function sittingsOf(runs: RunTotals[], breakMs = IDLE_BREAK_MS): Sitting[] {
  const ordered = [...runs].sort((a, b) => a.openedAt - b.openedAt)
  const out: Sitting[] = []

  let cur: Group | null = null
  for (const run of ordered) {
    if (cur && run.openedAt - cur.end <= breakMs) {
      // max, not assignment: turns in different projects overlap, and a short
      // turn starting inside a long one must not shorten the sitting.
      cur.end = Math.max(cur.end, run.openedAt + run.activeMs)
      cur.runs.push(run)
      continue
    }
    if (cur) out.push(seal(cur))
    cur = { start: run.openedAt, end: run.openedAt + run.activeMs, runs: [run] }
  }
  if (cur) out.push(seal(cur))
  return out
}

/** A sitting mid-construction: its bounds, and the turns that fell inside it. */
interface Group {
  start: number
  end: number
  runs: RunTotals[]
}

/**
 * A sitting's two halves, which must PARTITION its span and not merely relate to
 * it.
 *
 * `activeMs` is the UNION of the turn intervals, not their sum, and that is the
 * correctness bug this function exists to avoid. aide runs one agent per
 * project but several projects at once, so two turns overlap in wall-clock
 * time: on this machine the summed durations are 33.0h against a union of
 * 30.2h, so 2.8h of "agent time" is one minute counted twice. Summing is right
 * for "how much work did aide do" — which is what the `agent time` tile has
 * always shown and still does — and wrong for "what fraction of the clock was
 * it busy", because a numerator that can exceed its own denominator is not a
 * fraction. Four of this machine's 37 sittings had summed time exceeding their
 * span outright.
 *
 * So `humanMs` is `span - union` exactly, needs no clamp, and the two halves add
 * to the span by construction rather than by luck — which is the property
 * `pnpm smoke` asserts, since a split that quietly stopped partitioning would
 * still render as a plausible bar.
 */
function seal(g: Group): Sitting {
  const spanMs = g.end - g.start
  const activeMs = unionMs(g.runs)
  return {
    start: g.start,
    end: g.end,
    spanMs,
    activeMs,
    humanMs: spanMs - activeMs,
    turns: g.runs.length,
    projects: new Set(g.runs.map((r) => r.projectId)).size,
  }
}

/**
 * Wall-clock during which at least one of these turns was running.
 *
 * The classic interval merge. A zero-length turn — one that never ran — is an
 * empty interval and contributes nothing, which is what keeps a cancelled turn
 * from reading as a moment of work.
 */
function unionMs(runs: RunTotals[]): number {
  const spans = runs
    .map((r) => [r.openedAt, r.openedAt + r.activeMs] as const)
    .sort((a, b) => a[0] - b[0])

  let total = 0
  let start: number | null = null
  let end = 0
  for (const [from, to] of spans) {
    if (start === null || from > end) {
      if (start !== null) total += end - start
      start = from
      end = to
    } else if (to > end) end = to
  }
  if (start !== null) total += end - start
  return total
}

/**
 * The days that had any work, with every interval accounted to exactly one.
 *
 * The scoreboard's denominator, and the reason it is not simply "the window":
 * 21 of this machine's last 30 days ran nothing at all, and a day you did not
 * work is not a day aide wasted. Nor is it "the sittings", which is the other
 * end of the same mistake — a sitting excludes every gap over the break, which
 * is exactly the time the goal is to reclaim.
 *
 * Built by ADDING UP intervals rather than by measuring each day's outer
 * bounds, and that is the correctness fix rather than a refactor. Bounds are
 * `end - start` of the day's own sittings, so an idle stretch running from one
 * day into the next belongs to neither: on this machine the four largest gaps
 * all cross midnight, and 71.5 of 111.6 recoverable hours were invisible to the
 * score while being listed underneath it as the top of the worklist. The page
 * disagreed with itself, and the half that was wrong was the headline.
 *
 * So a gap is attributed to the day it STARTS on — the same rule `localDay`
 * applies to a turn, and the one that keeps an evening's idle with the evening
 * rather than with the next morning.
 */
export function activeDaysOf(sittings: Sitting[], gaps: IdleStretch[]): ActiveDay[] {
  const byDay = new Map<
    string,
    { sittings: Sitting[]; activeMs: number; idleMs: number; turns: number }
  >()
  const dayOf = (at: number) => {
    const key = localDay(at)
    const row = byDay.get(key) ?? { sittings: [], activeMs: 0, idleMs: 0, turns: 0 }
    byDay.set(key, row)
    return row
  }

  for (const s of sittings) {
    const row = dayOf(s.start)
    row.sittings.push(s)
    row.activeMs += s.activeMs
    // A sitting's own internal gaps — the seconds and minutes between turns
    // while you read a diff. Idle in the same sense as the big ones, and the
    // 15.6h of it on this machine is the half the old shape hid completely.
    row.idleMs += s.humanMs
    row.turns += s.turns
  }

  // The gaps BETWEEN sittings, each landing on the day it began. Only the
  // recoverable ones: nights and days off are excluded upstream by
  // `idleStretchesOf`, and a night charged to a day is a score lost by sleeping.
  for (const gap of gaps) {
    if (!gap.withinDay) continue
    // Night can still clip the edge of an otherwise-waking gap; take out only
    // the overlap, never the whole stretch. Classifying whole gaps is what
    // produced a 373% score with negative idle.
    const waking = gap.ms - nightOverlapMs(gap.from, gap.to)
    if (waking > 0) dayOf(gap.from).idleMs += waking
  }

  return [...byDay.entries()]
    .map(([day, row]) => {
      const starts = row.sittings.map((s) => s.start)
      const ends = row.sittings.map((s) => s.end)
      return {
        day,
        // A day whose only entry is a trailing gap has no sittings of its own;
        // it cannot happen while gaps are keyed to their start, but the bounds
        // must still be numbers rather than Infinity from an empty Math.min.
        start: starts.length ? Math.min(...starts) : 0,
        end: ends.length ? Math.max(...ends) : 0,
        // The span is what the two halves add up to, not the clock between the
        // first turn and the last. Those differ precisely by the sleep and the
        // days off, which is the whole point of excluding them.
        spanMs: row.activeMs + row.idleMs,
        activeMs: row.activeMs,
        idleMs: row.idleMs,
        turns: row.turns,
        sittings: row.sittings.length,
      }
    })
    .sort((a, b) => a.day.localeCompare(b.day))
}

/**
 * The hours counted as sleep: [NIGHT_FROM, NIGHT_TO) local.
 *
 * There has to be a rule of this kind and it has to be crude, because nothing in
 * a run log says whether you were in bed — and without one the goal charges you
 * for sleeping, which is unwinnable and would make the whole scoreboard a thing
 * to ignore. Two cruder rules were tried and both failed on this machine's own
 * data, which is why the window is narrow and why it is measured by OVERLAP
 * rather than by classifying whole gaps:
 *
 * - "begins and ends on the same local day" puts a 1:23am → 1:16pm gap at the
 *   top of the worklist as 11.9h of winnable idle. This machine's five busiest
 *   hours are between 1am and 5am, so working past midnight is the norm and the
 *   calendar boundary lands in the middle of a working night.
 * - "a gap containing 4am is entirely sleep" removes the whole of a 6:37am →
 *   00:16am gap — 17.7 hours, nearly all of it daytime — and produced a 373%
 *   score with negative idle. A gap is not sleep because it touches a night; it
 *   is sleep only for the part that overlaps one.
 *
 * 01:00–08:00 rather than a wider window because this machine demonstrably works
 * either side of it. The narrow choice is the conservative one for the goal: it
 * forgives less, so the target stays honest.
 */
const NIGHT_FROM = 1
const NIGHT_TO = 8

/**
 * How much of a stretch overlaps the sleeping hours.
 *
 * Walks night by night rather than doing modular arithmetic on hours, so a gap
 * of several days is handled by the same code as one of several hours and
 * daylight saving stays the Date object's problem. Returns 0 for a stretch
 * entirely inside the waking day, which is the common case.
 */
export function nightOverlapMs(from: number, to: number): number {
  let total = 0
  // Start at the night that may already be in progress at `from`.
  const cursor = new Date(from)
  cursor.setHours(0, 0, 0, 0)
  cursor.setDate(cursor.getDate() - 1)

  for (let guard = 0; cursor.getTime() < to && guard < 400; guard += 1) {
    const start = new Date(cursor)
    start.setHours(NIGHT_FROM, 0, 0, 0)
    const end = new Date(cursor)
    end.setHours(NIGHT_TO, 0, 0, 0)
    total += Math.max(0, Math.min(to, end.getTime()) - Math.max(from, start.getTime()))
    cursor.setDate(cursor.getDate() + 1)
  }
  return total
}

/**
 * The gaps between sittings: every stretch with nothing running.
 *
 * `withinDay` marks the ones the goal is about, and there is exactly ONE test:
 * whether the stretch crosses a day on which no work happened. The 43.8-hour
 * gap in this machine's history spans a Wednesday nobody opened the laptop, and
 * counting it puts the single largest item on the worklist beyond anything aide
 * could do about it.
 *
 * There is deliberately no second test for sleep, and the version that had one
 * is the bug this comment exists to prevent coming back. "Mostly night, so
 * discard the stretch" threw away a 00:40 → 09:30 gap ENTIRELY — including its
 * 110 waking minutes — because 420 of its 530 minutes were night. Sleep is
 * removed by measuring the OVERLAP wherever this is consumed, which takes out
 * exactly the sleeping part and leaves the rest, so a whole-stretch verdict on
 * top of it can only double-count the exclusion. That is the same mistake as the
 * 373% score, one layer up.
 */
function idleStretchesOf(sittings: Sitting[]): IdleStretch[] {
  const worked = new Set(sittings.map((s) => localDay(s.start)))
  const out: IdleStretch[] = []
  for (let i = 1; i < sittings.length; i += 1) {
    const before = sittings[i - 1]
    const after = sittings[i]
    if (!before || !after) continue
    out.push({
      from: before.end,
      to: after.start,
      ms: after.start - before.end,
      withinDay: !crossesIdleDay(before.end, after.start, worked),
    })
  }
  return out.sort((a, b) => b.ms - a.ms)
}

/**
 * Whether a stretch contains a whole calendar day with no work on it.
 *
 * Only days strictly BETWEEN the two ends count: the day the gap starts on and
 * the day it ends on both had work by construction, and a gap from Monday
 * evening to Tuesday morning crosses no idle day at all.
 */
function crossesIdleDay(from: number, to: number, worked: ReadonlySet<string>): boolean {
  const cursor = new Date(from)
  cursor.setHours(0, 0, 0, 0)
  cursor.setDate(cursor.getDate() + 1)
  for (let guard = 0; cursor.getTime() < to && guard < 400; guard += 1) {
    if (!worked.has(localDay(cursor.getTime()))) return true
    cursor.setDate(cursor.getDate() + 1)
  }
  return false
}

/** Where the window's wall-clock went. Pure; see `Sitting` for the unit. */
export function reduceTime(runs: RunTotals[], from: number, now: number): TimeSplit {
  const sittings = sittingsOf(runs)
  const engagedMs = sittings.reduce((n, s) => n + s.spanMs, 0)
  const activeMs = sittings.reduce((n, s) => n + s.activeMs, 0)
  const humanMs = sittings.reduce((n, s) => n + s.humanMs, 0)

  // Gaps first: the days are built FROM them, so that an idle stretch crossing
  // midnight lands on a day rather than falling between two.
  const idleStretches = idleStretchesOf(sittings)
  const activeDays = activeDaysOf(sittings, idleStretches)
  const activeDaySpanMs = activeDays.reduce((n, d) => n + d.spanMs, 0)

  // The longest single gap INSIDE a sitting, which needs the runs again rather
  // than the sittings: a sitting knows its total human time, not how that time
  // was distributed, and one 25-minute wait reads very differently from fifty
  // half-minute ones.
  //
  // `prevEnd` is the running maximum rather than the last turn's end, so a short
  // turn nested inside a longer one cannot open a gap that was never there —
  // the same overlap that made summing wrong above. A gap longer than the break
  // is a sitting boundary by definition and belongs to `awayMs`.
  const ordered = [...runs].sort((a, b) => a.openedAt - b.openedAt)
  let longestGapMs = 0
  let longestGapAt: number | null = null
  let prevEnd = 0
  for (const run of ordered) {
    const gap = run.openedAt - prevEnd
    if (prevEnd && gap > longestGapMs && gap <= IDLE_BREAK_MS) {
      longestGapMs = gap
      longestGapAt = prevEnd
    }
    prevEnd = Math.max(prevEnd, run.openedAt + run.activeMs)
  }

  const spans = sittings.map((s) => s.spanMs).sort((a, b) => a - b)
  return {
    // Newest first: the sitting you care about is the one you just finished.
    sittings: [...sittings].reverse(),
    activeDays,
    engagedMs,
    activeMs,
    humanMs,
    activeDaySpanMs,
    // Summed from the days rather than `activeDaySpanMs - activeMs`, so it is
    // the same arithmetic the per-day rows print and cannot disagree with their
    // total — and so a turn that ran through a night, whose day clamps its own
    // idle at zero, cannot drag the headline negative.
    idleWithinDaysMs: activeDays.reduce((n, d) => n + d.idleMs, 0),
    // Everything in the window that was not working time: days off, and the
    // nights inside a working stretch. `activeDaySpanMs` has already had the
    // nights taken out of it, so the two still partition the window exactly —
    // which is what `pnpm smoke` asserts, since a scoreboard whose parts do not
    // add up to the whole is one whose target can be hit by losing time
    // somewhere it is not counted. Clamped because `from` is local midnight
    // `days` ago, so a window wider than the history would overshoot.
    awayMs: Math.max(0, now - from - activeDaySpanMs),
    activeDayCount: activeDays.length,
    // Ceil, not round. `from` is local midnight `days-1` days back, so the
    // window is `days` calendar days but only `days - 1` whole 24-hour periods
    // plus however far into today it is — which rounds DOWN to `days - 1` for
    // any reading taken before noon. The page then printed "8 active days of
    // 7", which reads as a bug in the counting rather than in the label.
    windowDays: Math.max(1, Math.ceil((now - from) / DAY_MS)),
    // The three-way reading. `reviewMs` is every sitting's internal idle — the
    // gaps short enough to have kept the sitting together — and `deadMs` is
    // what is left of the working span once running and reviewing are out of
    // it. Derived by subtraction rather than re-summing the gaps so it cannot
    // disagree with the total it sits under.
    split: {
      activeMs,
      reviewMs: humanMs,
      deadMs: Math.max(0, activeDaySpanMs - activeMs - humanMs),
    },
    idleStretches,
    medianSpanMs: median(spans),
    longestGapMs,
    longestGapAt,
    breakMs: IDLE_BREAK_MS,
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
      // Filled in below, once every run has been seen: a project's sittings are
      // clustered over its whole set, so there is nothing to accumulate here.
      engagedMs: 0,
      busyMs: 0,
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
  // Each project's sittings, clustered over ITS OWN runs. Slicing the machine's
  // sittings by project would be the cheaper spelling and a different figure:
  // a sitting that jumped between two projects would have its whole span
  // charged to both, and the column would sum to more than the window holds.
  //
  // `busyMs` is the union rather than the summed `activeMs` on the row beside
  // it, for the reason `Sitting.activeMs` gives: a project's own turns can
  // overlap — the commit gate's repair attempt runs INSIDE the commit's run —
  // so a row dividing the sum by the span would be mixing two definitions and
  // could print a share above 100%. Small here (6 seconds across this machine's
  // history) and exactly the kind of thing that is not small on someone else's.
  const engagedOf = new Map<string, { engagedMs: number; busyMs: number }>()
  for (const projectId of byProject.keys()) {
    const mine = sittingsOf(runs.filter((r) => r.projectId === projectId))
    engagedOf.set(projectId, {
      engagedMs: mine.reduce((n, s) => n + s.spanMs, 0),
      busyMs: mine.reduce((n, s) => n + s.activeMs, 0),
    })
  }
  const projectRows = [...byProject.values()]
    .map(({ sessions: chats, ...row }) => ({
      ...row,
      chats: chats.size,
      engagedMs: engagedOf.get(row.projectId)?.engagedMs ?? 0,
      busyMs: engagedOf.get(row.projectId)?.busyMs ?? 0,
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
    time: reduceTime(runs, from, now),
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
