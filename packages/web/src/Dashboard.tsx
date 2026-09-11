import { useCallback, useEffect, useState } from "react"
import type { ActivityDay, HourCell, ProjectActivity } from "@aide/protocol"
import { api, type Activity } from "./api.js"
import { Hint } from "./Hint.js"
import { ArrowClockwise } from "./icons.js"
import { Scroller } from "./Scroller.js"
import { Button, Empty, money } from "./ui.js"

/**
 * Activity across every project — the one screen in aide that is not about a
 * single project.
 *
 * A PAGE rather than a fifth pane, and that is the whole design decision. The
 * four panes are a pipeline you read left to right about one repository, and
 * they are the product's surface; a dashboard is a different question — where
 * the week went, across everything — asked at a different moment, when you are
 * not in the middle of a piece of work. Wedging it in as a fifth column would
 * cost every pane a fifth of its width permanently to show something you look at
 * for thirty seconds a day. So it takes the whole window and hands it back.
 *
 * It is also NOT a repository browser by another name, which is the non-goal
 * nearest to this. Nothing here opens a commit, a file or a diff: every row is a
 * COUNT, and the only thing you can click is a project, which takes you to that
 * project's four panes. The rule the brief sets for the git rail holds here too
 * — a diff is read in the conversation that produced it.
 *
 * Everything is derived from the run logs on read; see `daemon/src/activity.ts`.
 * Nothing on this page is stored, so nothing on it can drift from the logs.
 */

/** The windows offered. Days, because that is what the daemon's route takes. */
const WINDOWS = [7, 30, 90] as const

/**
 * The categorical colours, in fixed order, never cycled.
 *
 * `--color-graph-1..4` from `index.css` — IBM's colourblind-safe set, which is
 * already in the theme for the commit graph and is there for exactly this
 * property: these are the colours in aide whose job is being told apart.
 *
 * FOUR, not the five the theme defines. Run through the palette validator
 * against this surface, `graph-5` (#c586c0, purple) sits at ΔE 6.7 from
 * `graph-4` (#40c8ae, teal) under deuteranopia — inside the 6–8 band that is
 * only legal with a secondary encoding. Dropping it takes the worst adjacent
 * pair to ΔE 14.5, comfortably past the ≥8 target, with contrast against
 * `--color-editor` above 3:1 on all four. A fifth series folds into "other"
 * rather than inventing a hue, which is the rule that stops a palette degrading
 * one series at a time.
 */
const SERIES = ["bg-graph-1", "bg-graph-2", "bg-graph-3", "bg-graph-4"] as const

/**
 * The heatmap's ramp: one hue, light → dark, ending at `--color-graph-1`.
 *
 * Sequential rather than categorical, because the punchcard's job is MAGNITUDE
 * — how much work happened in this hour — and the categorical set would say
 * "these cells are different kinds of thing", which they are not. The rule the
 * skill states and the reason it exists: a rainbow heatmap makes the reader
 * decode a legend to compare two cells, where a single hue is read directly.
 *
 * Five steps, checked for monotonic luminance (0.081 → 0.482). Monotonicity is
 * the sequential check the way ΔE is the categorical one: a ramp that goes
 * lighter then darker inverts the reading of half its cells and nothing on
 * screen would say so. The empty step is a surface tint rather than the first
 * colour, so "nothing happened" cannot be mistaken for "a little happened".
 *
 * The ramp starts well ABOVE that tint — step 1 is 1.96× its luminance —
 * because the first version began at #173a5e, only 1.5× the empty cell, and on
 * a grid where most cells hold one or two turns that rendered the majority of
 * the data as very nearly background. A sequential ramp has to spend its range
 * where the values are, and for a punchcard that is the bottom.
 */
const HEAT = ["#24537f", "#2e6ba6", "#3a86cc", "#5b9ce6", "#8fbaff"] as const
const HEAT_EMPTY = "#232323"

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const

/**
 * Money in a COLUMN, always two decimals.
 *
 * `money()` from `ui.tsx` gives four places under a dollar, which is right where
 * it was written — a single chat row, where the difference between $0.004 and
 * $0.04 is the whole figure. In a column it is wrong: `$0.4367` next to `$47.60`
 * puts the decimal points in different places and the eye stops being able to
 * compare the magnitudes, which is the only thing a column of costs is for.
 *
 * Sub-cent totals round to `$0.00` rather than growing places, and that is the
 * honest answer here: this is a window's total spend, and a project that cost
 * two tenths of a cent did not cost anything worth reading.
 */
const columnMoney = (n: number) => `$${n.toFixed(2)}`

/** `1.2M`, `43k`, `907`. Tokens run to the hundreds of millions. */
function compact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`
  return `${Math.round(n)}`
}

/**
 * `2h 40m`, `18m`, `9.4s`, `340ms`. Never `0.44 hours`.
 *
 * Seconds and milliseconds matter because this formats commit checks as well as
 * turn totals, and those live at the small end: rounding to whole minutes drew
 * `pnpm typecheck` (1.5s) and `pnpm smoke` (13s) both as `0m`, a column of
 * zeroes beside bars that plainly differed. One formatter across the page rather
 * than two, so the same duration never appears in two spellings.
 */
function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return `${mins}m`
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
}

/** `Sep 2`. The bar chart's axis, and short enough to repeat thirty times. */
function shortDay(day: string): string {
  // Parsed as local by hand rather than `new Date(day)`, which reads a bare
  // `YYYY-MM-DD` as UTC and so prints the day before for anyone west of
  // Greenwich — the same trap `localDay` avoids on the daemon side.
  const [y, m, d] = day.split("-").map(Number)
  if (!y || !m || !d) return day
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

const isToday = (day: string): boolean => {
  const now = new Date()
  const month = `${now.getMonth() + 1}`.padStart(2, "0")
  return day === `${now.getFullYear()}-${month}-${`${now.getDate()}`.padStart(2, "0")}`
}

/**
 * A headline figure.
 *
 * The hero-number form rather than a chart, because these are single magnitudes
 * with no shape to show. The label sits UNDER the number: the number is what you
 * came for and it should be what your eye lands on first.
 */
function Stat({
  value,
  label,
  hint,
  tone,
}: {
  value: string
  label: string
  hint?: string
  tone?: string
}) {
  return (
    <Hint hint={hint}>
      <div className="flex flex-col gap-0.5 rounded border border-line bg-chrome px-3 py-2.5">
        <span className={`font-sans text-[19px] leading-none ${tone ?? "text-fg"}`}>{value}</span>
        <span className="font-sans text-[10px] tracking-wide text-fg-dim uppercase">{label}</span>
      </div>
    </Hint>
  )
}

/**
 * Runs per day, as bars.
 *
 * A bar chart because the job is magnitude over an ordinal axis, and one series
 * so there is no legend and no categorical colour — the title names it, which is
 * the rule for a single series.
 *
 * Empty days INSIDE the history are drawn as empty rather than skipped. That is
 * the whole reason the daemon returns every day in the window: a chart that
 * omits them draws a fortnight of solid work over a fortnight that had four days
 * in it, and those gaps are usually the thing you are looking for.
 *
 * Leading empty days are different, and are dropped. A 30-day window over a
 * history that starts eight days ago is two thirds blank — not a quiet period,
 * just time before aide was watching — and it squeezes the days that do have
 * something into a third of the width. The distinction is "no work" versus "no
 * records", and only the first is worth a column of air. The axis still names
 * the first day drawn, so nothing is hidden about which span is on screen.
 */
function DailyBars({ days }: { days: ActivityDay[] }) {
  const first = days.findIndex((d) => d.runs > 0)
  // All empty is a real state — a window in which nothing ran — and it keeps
  // every bucket rather than collapsing to nothing, so the chart still says
  // "these thirty days, none of them".
  const shown = first <= 0 ? days : days.slice(first)
  const peak = Math.max(1, ...shown.map((d) => d.runs))
  const trimmed = days.length - shown.length

  const heading = (extra?: string) => (
    <h3 className="font-sans text-[11px] font-semibold tracking-wide text-fg-muted uppercase">
      turns per day
      {extra && (
        <span className="ml-2 font-normal normal-case tracking-normal text-fg-dim">{extra}</span>
      )}
    </h3>
  )

  // A window with nothing in it says so instead of drawing an empty plot area.
  // Tools and models below already name their own emptiness, and 112px of
  // silence beside them reads as a component that failed rather than as a quiet
  // month — and the axis labels under it would be describing no bars.
  if (first === -1) {
    return (
      <section className="rounded border border-line bg-chrome p-3">
        {heading()}
        <p className="mt-2 font-sans text-[11px] text-fg-dim">Nothing ran in this window.</p>
      </section>
    )
  }

  return (
    <section className="rounded border border-line bg-chrome p-3">
      {heading(trimmed > 0 ? "from the first turn aide logged" : undefined)}
      {/* items-end so every bar grows from a shared baseline. A bar chart whose
          bars are not anchored to one line is not a bar chart. */}
      <div className="mt-3 flex h-28 items-end gap-[2px]">
        {shown.map((day) => {
          const height = day.runs === 0 ? 0 : Math.max(3, (day.runs / peak) * 100)
          return (
            // The whole column is the hit target, not the bar — a 3px bar on a
            // quiet day is unhoverable, and those are the days you most want
            // to ask about.
            <Hint
              key={day.day}
              hint={`${shortDay(day.day)} — ${day.runs} turn${day.runs === 1 ? "" : "s"}, ${duration(day.activeMs)}, ${money(day.costUsd)}`}
            >
              <div className="group relative flex h-full flex-1 flex-col justify-end">
                <div
                  // rounded-t only: the data end is rounded, the baseline end is
                  // square, so the bar reads as growing out of the axis.
                  className={`w-full rounded-t-[2px] transition-colors ${
                    isToday(day.day) ? "bg-graph-2" : "bg-graph-1"
                  } group-hover:brightness-125`}
                  style={{ height: `${height}%` }}
                />
              </div>
            </Hint>
          )
        })}
      </div>
      {/* Two labels, not thirty. The ends of the axis are what orient you; a
          label under every bar at this width is a grey smear. */}
      <div className="mt-1.5 flex justify-between font-sans text-[10px] text-fg-dim">
        <span>{shown[0] ? shortDay(shown[0].day) : ""}</span>
        <span>today</span>
      </div>
    </section>
  )
}

/**
 * When the work happens: weekday × hour, as a heatmap.
 *
 * The punchcard, and the thing whose absence made the first version of this page
 * so thin. `runIndex` has always carried a full timestamp per run; reducing it
 * to one bar per day threw away both questions the shape answers — what time of
 * day you work, and whether the weekend differs from the week. On the machine
 * this was built for the answer is emphatic and was completely invisible: the
 * five busiest cells are all Saturday and Sunday, four of them between 1am and
 * 5am.
 *
 * A heatmap because the job is magnitude over a GRID, which is the one case the
 * form heuristic sends here rather than to bars: two ordinal axes at once, and
 * 168 values that would be an unreadable bar chart and a meaningless line.
 *
 * Hour labels every six, not every hour — 24 labels under a 24-column grid at
 * this width is a grey smear, and the quarter marks are what you actually
 * navigate by.
 */
function Punchcard({ cells }: { cells: HourCell[] }) {
  // Cells are indexed rather than searched per draw: `find` inside a 168-cell
  // render is 28k comparisons for a grid that arrives in a known order.
  const at = new Map(cells.map((c) => [`${c.weekday}:${c.hour}`, c.runs]))

  /**
   * The step boundaries, by QUANTILE of the non-empty cells rather than by a
   * linear share of the peak.
   *
   * Linear-on-the-peak is the obvious version and it collapses on this data:
   * one busy hour of 27 turns against a grid where most occupied cells hold one
   * or two puts ~90% of them in step 1, so the map is two colours and the ramp
   * is decoration. Quantiles spend the five steps where the cells actually are,
   * which is what makes the difference between a quiet hour and a busy one
   * visible at all.
   *
   * Computed off non-empty cells only — including the ~120 zeroes would put the
   * first three boundaries all at zero and undo the whole thing.
   */
  const occupied = cells
    .map((c) => c.runs)
    .filter((n) => n > 0)
    .sort((a, b) => a - b)
  const cut = (q: number) => occupied[Math.min(occupied.length - 1, Math.floor(q * occupied.length))] ?? 1

  // Boundaries at the 20th/40th/60th/80th percentile of occupied cells, computed
  // once rather than inside `step` — which runs 168 times per render.
  const bounds = [cut(0.2), cut(0.4), cut(0.6), cut(0.8)]

  const step = (runs: number) => {
    if (runs === 0) return HEAT_EMPTY
    let i = 0
    while (i < bounds.length && runs > (bounds[i] ?? 0)) i += 1
    return HEAT[Math.min(HEAT.length - 1, i)] ?? HEAT[0]
  }

  return (
    <section className="rounded border border-line bg-chrome p-3">
      <div className="flex items-baseline justify-between">
        <h3 className="font-sans text-[11px] font-semibold tracking-wide text-fg-muted uppercase">
          when the work happens
        </h3>
        {/* The legend a sequential ramp needs: two words and the ramp itself,
            rather than five numeric buckets nobody reads. */}
        <span className="flex items-center gap-1 font-sans text-[10px] text-fg-dim">
          less
          <span className="flex gap-[2px]">
            {[HEAT_EMPTY, ...HEAT].map((c) => (
              <span key={c} className="size-2 rounded-[1px]" style={{ background: c }} />
            ))}
          </span>
          more
        </span>
      </div>

      <div className="mt-3 flex flex-col gap-[2px]">
        {WEEKDAYS.map((label, weekday) => (
          <div key={label} className="flex items-center gap-[3px]">
            <span className="w-7 shrink-0 font-sans text-[10px] text-fg-dim">{label}</span>
            {Array.from({ length: 24 }, (_, hour) => {
              const runs = at.get(`${weekday}:${hour}`) ?? 0
              return (
                <Hint
                  key={hour}
                  hint={`${label} ${`${hour}`.padStart(2, "0")}:00 — ${runs} turn${runs === 1 ? "" : "s"}`}
                >
                  <span
                    className="h-3.5 flex-1 rounded-[1px]"
                    style={{ background: step(runs) }}
                  />
                </Hint>
              )
            })}
          </div>
        ))}
        <div className="mt-0.5 flex items-center gap-[3px]">
          <span className="w-7 shrink-0" />
          {Array.from({ length: 24 }, (_, hour) => (
            <span key={hour} className="flex-1 text-center font-sans text-[9px] text-fg-dim">
              {hour % 6 === 0 ? hour : ""}
            </span>
          ))}
        </div>
      </div>
    </section>
  )
}

/**
 * How close aide is to running whenever you are working. The page's scoreboard.
 *
 * The first version of this section reported 66% and treated away time as
 * context it explicitly refused to score — right for "is aide efficient while I
 * watch it", wrong for the goal, which is that the idle time IS the thing to
 * drive down. So the framing is inverted: one number, one target, and a
 * worklist of the specific stretches that make up the gap.
 *
 * The denominator is the hard part and two obvious ones are both unusable. The
 * WINDOW includes the 21 days of 30 this machine ran nothing — a day you did not
 * work is not a day aide wasted, and scoring it makes the number unwinnable.
 * The SITTINGS exclude every gap over half an hour, which is exactly the time
 * being targeted, so that reading can only ever say 66% and cannot improve. What
 * is left is the waking hours of days you did work: 30.6h of aide across 86.5h,
 * so 35% — a number with real headroom that no amount of sleeping can flatter.
 *
 * Sleep and days off are subtracted rather than forgiven quietly, and the
 * section says both figures, because a scoreboard that hides its exclusions is
 * one nobody can check.
 */
function Score({ time }: { time: Activity["time"] }) {
  const { activeDaySpanMs, activeMs, awayMs } = time
  // No working days in the window is a real state — a week you did not open
  // aide — and every share below would divide by zero.
  if (activeDaySpanMs === 0) {
    return (
      <section className="rounded border border-line bg-chrome p-3">
        <h3 className="font-sans text-[11px] font-semibold tracking-wide text-fg-muted uppercase">
          how much of your working time aide is running
        </h3>
        <p className="mt-2 font-sans text-[11px] text-fg-dim">
          Nothing ran in this window, so there is no working time to measure against.
        </p>
      </section>
    )
  }

  const pct = (activeMs / activeDaySpanMs) * 100
  const { reviewMs, deadMs } = time.split
  // Three shares of one span, so the segments are the figures rather than an
  // illustration of them.
  const share = (n: number) => (n / activeDaySpanMs) * 100

  return (
    <section className="rounded border border-line bg-chrome p-3">
      <div className="flex items-baseline justify-between">
        <h3 className="font-sans text-[11px] font-semibold tracking-wide text-fg-muted uppercase">
          how much of your working time aide is running
        </h3>
        <Hint
          hint={`Measured over the ${time.activeDayCount} day${time.activeDayCount === 1 ? "" : "s"} in this window that had any work, from the first turn to the last, with sleeping hours taken out. Days you did not work at all are excluded — see 'not counted' below.`}
        >
          <span className="font-sans text-[10px] text-fg-dim">
            {time.activeDayCount} working day{time.activeDayCount === 1 ? "" : "s"} of{" "}
            {time.windowDays}
          </span>
        </Hint>
      </div>

      {/* The number, big. This is the one figure the page exists to move, so it
          is the thing the eye lands on rather than a percentage buried in a
          sentence under a chart. */}
      <div className="mt-3 flex items-baseline gap-3">
        <span className="font-sans text-[34px] leading-none tabular-nums text-fg">
          {pct.toFixed(0)}%
        </span>
        <span className="font-sans text-[11px] leading-tight text-fg-dim">
          of your working hours
          <br />
          had aide running
        </span>
      </div>

      {/* THREE segments, not two, and that is the whole reading. "Idle" was one
          bucket holding two things that want opposite responses: the minutes
          between turns while you read a diff — which the brief calls the second
          gate, so it is the product working — and the hours where aide sat
          finished with nothing queued. On this machine that is 15.6h against
          96.8h. They partition the span exactly; `pnpm smoke` asserts it. */}
      <div className="mt-3 flex h-2.5 gap-[2px] overflow-hidden">
        <Hint hint={`${duration(activeMs)} — a turn was running`}>
          <span
            className="rounded-[2px] bg-graph-1"
            style={{ width: `${share(activeMs)}%` }}
          />
        </Hint>
        <Hint
          hint={`${duration(reviewMs)} — between turns in a sitting: reading, typing, deciding`}
        >
          <span
            className="rounded-[2px] bg-graph-4"
            style={{ width: `${share(reviewMs)}%` }}
          />
        </Hint>
        <Hint hint={`${duration(deadMs)} — aide finished, nothing queued`}>
          <span
            className="rounded-[2px] bg-warn"
            style={{ width: `${share(deadMs)}%` }}
          />
        </Hint>
      </div>

      <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 font-sans text-[11px]">
        <span className="flex items-baseline gap-1.5">
          <span className="size-2 shrink-0 translate-y-[0.1em] rounded-sm bg-graph-1" aria-hidden="true" />
          <span className="tabular-nums text-fg">{duration(activeMs)}</span>
          <span className="text-fg-dim">aide running</span>
        </span>
        <span className="flex items-baseline gap-1.5">
          <span className="size-2 shrink-0 translate-y-[0.1em] rounded-sm bg-graph-4" aria-hidden="true" />
          <span className="tabular-nums text-fg-muted">{duration(reviewMs)}</span>
          <span className="text-fg-dim">you, between turns</span>
        </span>
        <span className="flex items-baseline gap-1.5">
          <span className="size-2 shrink-0 translate-y-[0.1em] rounded-sm bg-warn" aria-hidden="true" />
          <span className="tabular-nums text-warn">{duration(deadMs)}</span>
          <span className="text-fg-dim">dead — the target</span>
        </span>
        <span className="flex-1" />
        <Hint hint="Days with no work at all, and the hours between 1am and 8am. Neither is something aide can win back, so neither is counted against the score.">
          <span className="text-fg-dim">{duration(awayMs)} not counted</span>
        </Hint>
      </div>

      {/* The reading in a sentence, because the three-way split is the one
          thing on this page somebody arrives with a theory about. It names
          which of the two idle halves is the one to attack. */}
      <p className="mt-3 border-t border-line pt-3 font-sans text-[11px] leading-relaxed text-fg-dim">
        Of {duration(activeDaySpanMs)} working,{" "}
        <span className="text-warn">{duration(deadMs)}</span> was aide sitting finished with
        nothing queued — {share(deadMs).toFixed(0)}% of the time you were at it. Only{" "}
        {duration(reviewMs)} went on reading and typing between turns, so the gap is not the
        review: it is the {time.idleStretches.filter((s) => s.withinDay).length} stretches where
        nothing was waiting to run.
      </p>
    </section>
  )
}

/**
 * The score, day by day. Whether the number above is moving.
 *
 * A single percentage over a window says where you are and nothing about the
 * direction, which for a goal is half the information — and the daily spread is
 * wide enough to matter: this machine's nine working days run from 21% to 80%,
 * so the 35% headline describes none of them well.
 *
 * Bars are the working span and the fill is aide's share of it, so a short
 * intense day and a long thin one are visibly different shapes rather than two
 * percentages that happen to be equal. Height carries hours; fill carries the
 * score.
 */
function ScoreByDay({ days }: { days: Activity["time"]["activeDays"] }) {
  if (days.length === 0) return null
  const peak = Math.max(...days.map((d) => d.spanMs))

  return (
    <section className="rounded border border-line bg-chrome p-3">
      <h3 className="font-sans text-[11px] font-semibold tracking-wide text-fg-muted uppercase">
        each working day
      </h3>
      <div className="mt-3 flex h-24 items-end gap-1">
        {days.map((day) => {
          const pct = day.spanMs ? (day.activeMs / day.spanMs) * 100 : 0
          return (
            <Hint
              key={day.day}
              hint={`${shortDay(day.day)} — aide ran ${duration(day.activeMs)} of ${duration(day.spanMs)} working (${pct.toFixed(0)}%), leaving ${duration(day.idleMs)} idle. ${day.turns} turns over ${day.sittings} sitting${day.sittings === 1 ? "" : "s"}.`}
            >
              <div className="group flex h-full flex-1 flex-col justify-end">
                {/* The column is the day's working span; the filled part at the
                    bottom is aide. Anchored to the baseline so the fill grows the
                    way the bar does. */}
                <div
                  className="flex w-full flex-col justify-end overflow-hidden rounded-t-[2px] bg-input"
                  style={{ height: `${Math.max(4, (day.spanMs / peak) * 100)}%` }}
                >
                  <div className="w-full bg-graph-1" style={{ height: `${pct}%` }} />
                </div>
              </div>
            </Hint>
          )
        })}
      </div>
      <div className="mt-1.5 flex items-baseline justify-between font-sans text-[10px] text-fg-dim">
        <span>{days[0] ? shortDay(days[0].day) : ""}</span>
        <span className="text-fg-muted">
          {/* Named so the two encodings are not left to be inferred: the height
              is hours, the fill is the score, and they move independently. */}
          bar height = hours worked · fill = aide running
        </span>
        <span>{days[days.length - 1] ? shortDay(days[days.length - 1]!.day) : ""}</span>
      </div>
    </section>
  )
}

/**
 * Where the work went, by project.
 *
 * A table rather than a pie: these are magnitudes to be compared and read
 * exactly, several of them per row, and a pie can show one series badly. The bar
 * under each name is the share, so the shape is still readable at a glance
 * without giving up the numbers.
 *
 * Every row is direct-labelled with its project name, so colour here is
 * decoration rather than the encoding — which is what makes a fifth project
 * folding into a repeated hue harmless.
 */
function Projects({
  rows,
  onOpen,
}: {
  rows: ProjectActivity[]
  onOpen: (projectId: string) => void
}) {
  return (
    <section className="rounded border border-line bg-chrome p-3">
      <h3 className="font-sans text-[11px] font-semibold tracking-wide text-fg-muted uppercase">
        projects
      </h3>
      <div className="mt-2 flex flex-col">
        {rows.map((row, i) => {
          const known = row.name !== null
          return (
            <Hint
              key={row.projectId}
              hint={
                known
                  ? `${row.runs} turn${row.runs === 1 ? "" : "s"} over ${row.chats} conversation${row.chats === 1 ? "" : "s"}. Open this project.`
                  : "This project has been removed from aide. Its history is still counted above."
              }
            >
              <button
                type="button"
                // A removed project has nothing to open — the registry entry it
                // would navigate to is gone, and the four panes would land on an
                // empty shell. It stays as a row because the totals above include
                // it, but it is not a link.
                disabled={!known}
                onClick={() => known && onOpen(row.projectId)}
                className="group flex flex-col gap-1 rounded-sm px-2 py-1.5 text-left enabled:hover:bg-hover disabled:cursor-default"
              >
                <span className="flex items-baseline gap-2 font-sans text-[12px]">
                  {/* No separate host badge. A remote project's registry name is
                      already `<dir> · <host>` — see `addRemoteProject` — so one
                      drew `games42_mono · tg` followed by a second `tg`. The name
                      is what every other list in aide shows, and it says it. */}
                  <span className={`truncate ${known ? "text-fg" : "text-fg-dim italic"}`}>
                    {/* A removed project is identified by the id its logs carry,
                        because there can be several and "removed project" three
                        times over is a list you cannot tell apart — and that id is
                        the only handle left to grep the run logs with. */}
                    {row.name ?? `removed · ${row.projectId}`}
                  </span>
                  <span className="flex-1" />
                  {/* Text tokens, not the series colour: the mark beside them
                      carries identity, and a number painted the series hue stops
                      reading as a number. */}
                  <span className="w-16 shrink-0 text-right tabular-nums text-fg-muted">
                    {columnMoney(row.costUsd)}
                  </span>
                  <span className="w-12 shrink-0 text-right tabular-nums text-fg-dim">
                    {duration(row.activeMs)}
                  </span>
                  {/* This project's own busy share, which is the reason the row
                      carries `engagedMs` at all: the machine-wide 66% is an
                      average over projects that differ enormously — 62% here
                      against 36% on one that is mostly read-and-think. A project
                      with no sittings yet shows nothing rather than 0%. */}
                  <Hint
                    hint={
                      row.engagedMs
                        ? `${duration(row.engagedMs)} at this project, of which ${duration(row.busyMs)} was a turn running.`
                        : undefined
                    }
                  >
                    <span className="w-10 shrink-0 text-right tabular-nums text-fg-dim">
                      {row.engagedMs ? `${Math.round((row.busyMs / row.engagedMs) * 100)}%` : "·"}
                    </span>
                  </Hint>
                  <span className="w-10 shrink-0 text-right tabular-nums text-fg-dim">
                    {row.chats} ch
                  </span>
                </span>
                <span className="flex h-1 w-full overflow-hidden rounded-full bg-input">
                  <span
                    className={`h-full rounded-full ${SERIES[i % SERIES.length]}`}
                    style={{ width: `${Math.max(1, row.share * 100)}%` }}
                  />
                </span>
              </button>
            </Hint>
          )
        })}
      </div>
    </section>
  )
}

/**
 * How turns ended, and how long they took.
 *
 * Two facts the four headline totals actively hide. "386 turns" says nothing
 * about how many of them you stopped — 206 of the 656 in this machine's full
 * history were cancelled — and a single summed "agent time" describes no turn
 * that ever ran, since the median is 95s and the 90th percentile 701s.
 *
 * The outcome bar is a part-to-whole stacked bar, which is the form for a
 * handful of parts of one total, and it is direct-labelled underneath rather
 * than given a legend box: three segments with their own names beside their own
 * counts needs no key.
 *
 * Status colours, not the categorical set. These are STATES — succeeded, you
 * stopped it, it broke — and the skill reserves the status palette for exactly
 * this so that "failed" is never also "series 3" somewhere else on the page.
 */
function Outcomes({ activity }: { activity: Activity }) {
  const { success, cancelled, failed } = activity.outcomes
  const total = success + cancelled + failed
  const parts = [
    { key: "succeeded", n: success, bg: "bg-ok", text: "text-ok" },
    { key: "cancelled", n: cancelled, bg: "bg-warn", text: "text-warn" },
    { key: "failed", n: failed, bg: "bg-err", text: "text-err" },
  ].filter((p) => p.n > 0)

  return (
    <section className="rounded border border-line bg-chrome p-3">
      <h3 className="font-sans text-[11px] font-semibold tracking-wide text-fg-muted uppercase">
        how turns ended
      </h3>
      {total === 0 ? (
        <p className="mt-2 font-sans text-[11px] text-fg-dim">No turns finished in this window.</p>
      ) : (
        <>
          {/* gap-[2px] between segments: the skill's surface gap, so two
              adjacent fills read as two rather than as one two-tone bar. */}
          <div className="mt-3 flex h-2.5 gap-[2px] overflow-hidden">
            {parts.map((p) => (
              <Hint key={p.key} hint={`${p.n} ${p.key} — ${((p.n / total) * 100).toFixed(0)}%`}>
                <span
                  className={`${p.bg} rounded-[2px]`}
                  style={{ width: `${(p.n / total) * 100}%` }}
                />
              </Hint>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-sans text-[11px]">
            {parts.map((p) => (
              <span key={p.key} className="flex items-baseline gap-1.5">
                <span className={`${p.text} tabular-nums`}>{p.n}</span>
                <span className="text-fg-dim">{p.key}</span>
              </span>
            ))}
          </div>
        </>
      )}

      <div className="mt-3 grid grid-cols-3 gap-2 border-t border-line pt-3">
        {/* The spread, as three figures rather than a histogram. A distribution
            this skewed (95s median against a 155-minute max) needs the numbers
            themselves; a histogram of it is one tall bar and a long flat tail. */}
        <Figure label="median turn" value={duration(activity.durations.p50Ms)} />
        <Figure label="90th pct" value={duration(activity.durations.p90Ms)} />
        <Figure label="longest" value={duration(activity.durations.maxMs)} />
      </div>

      {/* The reading, in a sentence. Every number above is already on screen;
          what a rate adds is the comparison nobody makes in their head, and it
          is the one figure here that says whether anything needs attention. */}
      {total > 0 && (
        <p className="mt-3 border-t border-line pt-3 font-sans text-[11px] leading-relaxed text-fg-dim">
          {cancelled === 0 ? (
            <>You stopped none of them.</>
          ) : (
            <>
              You stopped{" "}
              <span className="text-warn">{((cancelled / total) * 100).toFixed(0)}%</span> of turns
              before they finished
              {activity.asks > 0 && (
                <>
                  , and <span className="text-fg-muted">{activity.asks}</span> waited on a
                  permission prompt
                </>
              )}
              .
            </>
          )}
        </p>
      )}
    </section>
  )
}

/** A small labelled number, for the secondary rows. */
function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-sans text-[13px] tabular-nums text-fg">{value}</span>
      <span className="font-sans text-[10px] tracking-wide text-fg-dim uppercase">{label}</span>
    </div>
  )
}

/**
 * The commit gate's own record.
 *
 * `verify.result` has carried the command, its outcome and its duration since
 * the gate existed, and nothing has ever shown it. Two things are only visible
 * here: a check that has started FAILING, and one that has quietly become the
 * slowest part of committing — on this machine `engine-check.mts` takes 334
 * seconds against `pnpm typecheck`'s 1.5.
 *
 * Failing checks sort first, from the daemon. Sorting by volume instead would
 * bury the one row you came to find under the four that always pass.
 */
function Checks({ rows }: { rows: Activity["checks"] }) {
  if (rows.length === 0) return null
  const slowest = Math.max(1, ...rows.map((r) => r.medianMs))
  return (
    <section className="rounded border border-line bg-chrome p-3">
      <h3 className="font-sans text-[11px] font-semibold tracking-wide text-fg-muted uppercase">
        commit checks
      </h3>
      <div className="mt-2 flex flex-col gap-1.5">
        {rows.slice(0, 8).map((row) => (
          <div key={row.command} className="flex items-center gap-2 font-sans text-[11px]">
            {/* rtl + `truncate` clips the FRONT, which is where the shared
                prefix is: `node_modules/.bin/tsx checks/engine-check.mts` and
                its four siblings are identical for 30 characters and differ only
                at the tail, so a normal truncate drew five rows reading
                `node_modules/.bin/tsx chec…` and made them one row repeated. */}
            <Hint hint={row.command}>
              <span
                dir="rtl"
                className={`w-44 shrink-0 truncate text-left ${
                  row.failed > 0 ? "text-fg" : "text-fg-muted"
                }`}
              >
                {row.command}
              </span>
            </Hint>
            <span className="flex h-2 flex-1 overflow-hidden rounded-sm bg-input">
              <span
                // Time, not pass rate: the pass/fail counts are already printed
                // beside it, and how long the gate takes is the thing no other
                // number on this page says.
                className="h-full rounded-sm bg-graph-1"
                style={{ width: `${(row.medianMs / slowest) * 100}%` }}
              />
            </span>
            <span className="w-14 shrink-0 text-right tabular-nums text-fg-dim">
              {duration(row.medianMs)}
            </span>
            <span className="w-10 shrink-0 text-right tabular-nums text-ok">{row.passed}</span>
            <Hint hint={row.failed > 0 ? `${row.failed} refused a commit` : undefined}>
              <span
                className={`w-12 shrink-0 text-right tabular-nums ${
                  row.failed > 0 ? "text-err" : "text-transparent"
                }`}
              >
                {/* The word, for the reason the tools column uses one: this mono
                    stack has no ✗ glyph and falls back to a capital X. */}
                {row.failed > 0 ? `${row.failed} fail` : "·"}
              </span>
            </Hint>
          </div>
        ))}
      </div>
    </section>
  )
}

/** What the agents actually did, and what the money was spent on. */
function ToolsAndModels({ activity }: { activity: Activity }) {
  const peak = Math.max(1, ...activity.tools.map((t) => t.calls))
  return (
    <div className="grid grid-cols-2 gap-3">
      <section className="rounded border border-line bg-chrome p-3">
        <h3 className="font-sans text-[11px] font-semibold tracking-wide text-fg-muted uppercase">
          tools
        </h3>
        <div className="mt-2 flex flex-col gap-1.5">
          {activity.tools.length === 0 ? (
            <p className="font-sans text-[11px] text-fg-dim">No tool calls in this window.</p>
          ) : (
            activity.tools.slice(0, 8).map((tool) => (
              <div key={tool.name} className="flex items-center gap-2">
                <span className="w-20 shrink-0 truncate font-sans text-[11px] text-fg-muted">
                  {tool.name}
                </span>
                <span className="flex h-2.5 flex-1 overflow-hidden rounded-sm bg-input">
                  <span
                    className="h-full rounded-sm bg-graph-1"
                    style={{ width: `${(tool.calls / peak) * 100}%` }}
                  />
                </span>
                <span className="w-12 shrink-0 text-right font-sans text-[11px] tabular-nums text-fg-dim">
                  {compact(tool.calls)}
                </span>
                {/* Failures only when there are some. A column of zeroes reads
                    as a problem being reported rather than an absence of one.
                    The word, not a ✗: the mono stack here has no glyph for it
                    and falls back to a capital X, so `148✗` rendered as `148X`
                    — which reads as a multiplier, and as a count of successes
                    rather than of failures. */}
                <Hint hint={tool.failed > 0 ? `${tool.failed} came back an error` : undefined}>
                  <span
                    className={`w-14 shrink-0 text-right font-sans text-[10px] tabular-nums ${
                      tool.failed > 0 ? "text-warn" : "text-transparent"
                    }`}
                  >
                    {tool.failed > 0 ? `${tool.failed} err` : "·"}
                  </span>
                </Hint>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="rounded border border-line bg-chrome p-3">
        <h3 className="font-sans text-[11px] font-semibold tracking-wide text-fg-muted uppercase">
          models
        </h3>
        <div className="mt-2 flex flex-col gap-1.5">
          {activity.models.length === 0 ? (
            <p className="font-sans text-[11px] text-fg-dim">Nothing spent in this window.</p>
          ) : (
            activity.models.map((model, i) => (
              <div key={model.model} className="flex items-center gap-2">
                <span
                  className={`size-2 shrink-0 rounded-sm ${SERIES[i % SERIES.length]}`}
                  aria-hidden="true"
                />
                <Hint hint={model.model}>
                  <span className="flex-1 truncate font-sans text-[11px] text-fg-muted">
                    {/* The date suffix on a model id is noise in a list of three.
                        The full id is on the hint, for when it is not. */}
                    {model.model.replace(/-\d{8}$/, "")}
                  </span>
                </Hint>
                <span className="w-16 shrink-0 text-right font-sans text-[11px] tabular-nums text-fg-muted">
                  {columnMoney(model.costUsd)}
                </span>
                <span className="w-12 shrink-0 text-right font-sans text-[11px] tabular-nums text-fg-dim">
                  {compact(model.tokens)}
                </span>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  )
}

export function Dashboard({
  onOpenProject,
  onClose,
}: {
  onOpenProject: (projectId: string) => void
  onClose: () => void
}) {
  const [days, setDays] = useState<number>(30)
  const [activity, setActivity] = useState<Activity | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback((window: number) => {
    setLoading(true)
    return api
      .activity(window)
      .then((next) => {
        setActivity(next)
        setError(null)
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    let live = true
    setLoading(true)
    api
      .activity(days)
      .then((next) => {
        // Guards a window changed underneath a request: the 90-day answer is
        // slower than the 7-day one, so without this a quick 90→7 lands the 90
        // in the 7's chart.
        if (live) {
          setActivity(next)
          setError(null)
        }
      })
      .catch((err) => live && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [days])

  return (
    <main className="flex h-full flex-col bg-editor font-mono text-fg antialiased">
      <header className="flex h-9 shrink-0 items-center justify-between border-b border-line px-3">
        <h2 className="font-sans text-[11px] font-semibold tracking-wide text-fg-muted uppercase">
          activity
        </h2>
        <div className="flex items-center gap-1.5">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setDays(w)}
              className={`rounded-sm px-2 py-1 font-sans text-[11px] transition-colors ${
                days === w ? "bg-input text-fg" : "text-fg-dim hover:bg-hover hover:text-fg-muted"
              }`}
            >
              {w}d
            </button>
          ))}
          <Button onClick={() => void load(days)} disabled={loading} title="Re-read the run logs">
            <ArrowClockwise className="size-3 translate-y-[0.15em]" />
            {loading ? "reading…" : "refresh"}
          </Button>
          <Button onClick={onClose} title="Back to the projects">
            close
          </Button>
        </div>
      </header>

      <Scroller className="flex-1" contentClassName="p-3">
        {error ? (
          <p className="font-sans text-[11px] text-err">{error}</p>
        ) : !activity ? (
          <Empty>Reading the run logs…</Empty>
        ) : activity.lifetime.runs === 0 ? (
          <Empty>
            No runs yet. Once aide has taken a turn in a project, what it spent and where the time
            went appear here.
          </Empty>
        ) : (
          <div className="mx-auto flex max-w-5xl flex-col gap-3">
            <div className="grid grid-cols-4 gap-3">
              <Stat
                value={columnMoney(activity.costUsd)}
                label={`spent · ${activity.days}d`}
                tone="text-graph-2"
                hint="An ESTIMATE, from a price table bundled into the SDK at build time. Fine for a dashboard, never for billing."
              />
              <Stat
                value={duration(activity.activeMs)}
                label="agent time"
                // Says it SUMS, because the section below prints a smaller
                // number for what looks like the same thing: two projects
                // running at once is two turns' duration over one minute of
                // clock. Without this the page appears to disagree with itself.
                hint="The turns' own durations added up — not the hours between them, and turns in different projects that ran at the same time are counted twice. See 'where the time went' for the wall-clock reading."
              />
              <Stat value={`${activity.runs}`} label="turns" hint={`Over ${activity.chats} conversations.`} />
              <Stat
                value={`${activity.commits}`}
                label="commits"
                tone="text-ok"
                hint="Commits aide landed in this window, each one a gate you pressed."
              />
            </div>

            {/* Tokens and asks demoted from the headline row. Tokens is the
                least actionable of the five — you cannot spend fewer of them
                directly, and the dollar figure above already tracks it — and a
                fifth tile made the row too narrow to read. */}
            <div className="grid grid-cols-4 gap-3 rounded border border-line bg-chrome px-3 py-2.5">
              <Figure label="tokens" value={compact(activity.tokens)} />
              <Figure label="conversations" value={`${activity.chats}`} />
              <Figure label="turns blocked on you" value={`${activity.asks}`} />
              <Figure
                label="tools run"
                value={compact(activity.tools.reduce((n, t) => n + t.calls, 0))}
              />
            </div>

            {/* First, above everything. The page has a goal now, and the
                figure that tracks it outranks the totals it used to sit under
                — those say what happened, this says how far there is to go. */}
            <Score time={activity.time} />

            <ScoreByDay days={activity.time.activeDays} />

            <DailyBars days={activity.daily} />

            <Punchcard cells={activity.hours} />

            {activity.projects.length > 0 && (
              <Projects rows={activity.projects} onOpen={onOpenProject} />
            )}

            <div className="grid grid-cols-2 gap-3">
              <Outcomes activity={activity} />
              <Checks rows={activity.checks} />
            </div>

            <ToolsAndModels activity={activity} />

            {/* The estimate disclaimer, once, at the foot — the brief requires
                anything showing a cost figure to say so, and saying it on every
                tile would be four copies of one sentence. */}
            <footer className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-1 pb-1 font-sans text-[10px] leading-relaxed text-fg-dim">
              <span>
                All time from{" "}
                {activity.lifetime.since
                  ? new Date(activity.lifetime.since).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })
                  : "—"}
                : {activity.lifetime.runs} turns, {duration(activity.lifetime.activeMs)},{" "}
                {columnMoney(activity.lifetime.costUsd)}, {compact(activity.lifetime.tokens)}{" "}
                tokens.
              </span>
              <span>
                Costs are estimates from a price table bundled into the SDK, not billing figures.
              </span>
              {/* Shown only when non-zero: a count of nothing is noise. */}
              {activity.unattributed > 0 && (
                <Hint hint="Turns whose log never named a session — the daemon stopped between the first event and the model's reply. Their spend is not counted above.">
                  <span>
                    {activity.unattributed} turn{activity.unattributed === 1 ? "" : "s"} ended before
                    they were attributed.
                  </span>
                </Hint>
              )}
            </footer>
          </div>
        )}
      </Scroller>
    </main>
  )
}
