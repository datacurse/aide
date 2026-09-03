import { useCallback, useEffect, useState } from "react"
import type { ActivityDay, ProjectActivity } from "@aide/protocol"
import { api, type Activity } from "./api.js"
import { ArrowClockwise } from "./icons.js"
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

/** `2h 40m`, `18m`. Never `0.44 hours`, which nobody reads as anything. */
function duration(ms: number): string {
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
    <div className="flex flex-col gap-0.5 rounded border border-line bg-chrome px-3 py-2.5" title={hint}>
      <span className={`font-sans text-[19px] leading-none ${tone ?? "text-fg"}`}>{value}</span>
      <span className="font-sans text-[10px] tracking-wide text-fg-dim uppercase">{label}</span>
    </div>
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
            <div
              key={day.day}
              className="group relative flex h-full flex-1 flex-col justify-end"
              // The whole column is the hit target, not the bar — a 3px bar on a
              // quiet day is unhoverable, and those are the days you most want
              // to ask about.
              title={`${shortDay(day.day)} — ${day.runs} turn${day.runs === 1 ? "" : "s"}, ${duration(day.activeMs)}, ${money(day.costUsd)}`}
            >
              <div
                // rounded-t only: the data end is rounded, the baseline end is
                // square, so the bar reads as growing out of the axis.
                className={`w-full rounded-t-[2px] transition-colors ${
                  isToday(day.day) ? "bg-graph-2" : "bg-graph-1"
                } group-hover:brightness-125`}
                style={{ height: `${height}%` }}
              />
            </div>
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
            <button
              key={row.projectId}
              type="button"
              // A removed project has nothing to open — the registry entry it
              // would navigate to is gone, and the four panes would land on an
              // empty shell. It stays as a row because the totals above include
              // it, but it is not a link.
              disabled={!known}
              onClick={() => known && onOpen(row.projectId)}
              className="group flex flex-col gap-1 rounded-sm px-2 py-1.5 text-left enabled:hover:bg-hover disabled:cursor-default"
              title={
                known
                  ? `${row.runs} turn${row.runs === 1 ? "" : "s"} over ${row.chats} conversation${row.chats === 1 ? "" : "s"}. Open this project.`
                  : "This project has been removed from aide. Its history is still counted above."
              }
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
          )
        })}
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
                <span
                  className={`w-14 shrink-0 text-right font-sans text-[10px] tabular-nums ${
                    tool.failed > 0 ? "text-warn" : "text-transparent"
                  }`}
                  title={tool.failed > 0 ? `${tool.failed} came back an error` : undefined}
                >
                  {tool.failed > 0 ? `${tool.failed} err` : "·"}
                </span>
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
                <span className="flex-1 truncate font-sans text-[11px] text-fg-muted" title={model.model}>
                  {/* The date suffix on a model id is noise in a list of three.
                      The full id is on the title, for when it is not. */}
                  {model.model.replace(/-\d{8}$/, "")}
                </span>
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

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
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
                hint="The turns' own time added up — not the hours between them."
              />
              <Stat value={`${activity.runs}`} label="turns" hint={`Over ${activity.chats} conversations.`} />
              <Stat
                value={compact(activity.tokens)}
                label="tokens"
                hint="Input, output and cache together."
              />
            </div>

            <DailyBars days={activity.daily} />

            {activity.projects.length > 0 && (
              <Projects rows={activity.projects} onOpen={onOpenProject} />
            )}

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
                <span title="Turns whose log never named a session — the daemon stopped between the first event and the model's reply. Their spend is not counted above.">
                  {activity.unattributed} turn{activity.unattributed === 1 ? "" : "s"} ended before
                  they were attributed.
                </span>
              )}
            </footer>
          </div>
        )}
      </div>
    </main>
  )
}
