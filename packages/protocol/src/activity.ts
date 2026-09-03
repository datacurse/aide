/**
 * Activity across every project at once.
 *
 * The four panes all answer questions about ONE project — what is running in it,
 * what it has left to commit, what its chats said. This is the other axis, and
 * it is the one the brief's opening sentence asks for: a bird's-eye view across
 * projects. Where the week's time and money went, which projects are actually
 * moving, and which have gone quiet.
 *
 * Every figure is derived on read from the run logs under `~/.aide/runs`, which
 * are append-only and already scanned and cached by `spend.ts`. Nothing here is
 * stored, so there is no counter to drift, no migration when the shape changes,
 * and deleting a log is a legitimate way to make aide forget a run.
 *
 * The cost figures are ESTIMATES, from a price table bundled into the SDK at
 * build time — the brief says anything showing one has to say so, and the page
 * does, once, rather than on every tile.
 */

/**
 * One day's activity, for the calendar and the bars.
 *
 * `day` is a local-time `YYYY-MM-DD` rather than an epoch, because that is the
 * key the reader thinks in: a turn taken at 1am belongs to the night before in
 * every sense except UTC's. It is computed daemon-side from the machine's own
 * timezone — the same machine the runs happened on — so the browser never has to
 * re-bucket and the two can never disagree about where a day boundary is.
 */
export interface ActivityDay {
  /** Local `YYYY-MM-DD`. */
  day: string
  runs: number
  /** The turns' own time, summed. Not wall-clock across the day. */
  activeMs: number
  costUsd: number
  tokens: number
}

/** What one project has been doing. One row of the dashboard's main table. */
export interface ProjectActivity {
  projectId: string
  /**
   * The project's name, or null when the registry no longer has it.
   *
   * Null is a real and interesting case rather than an error: run logs outlive
   * the project they were taken in, so a repository that has been removed from
   * aide still has history here. Dropping those rows would make the totals at
   * the top of the page disagree with the sum of the table under them, which is
   * the kind of arithmetic error that costs an hour to believe.
   */
  name: string | null
  /** Absent for a project on this machine, as everywhere else. */
  host: string | null
  runs: number
  /** Conversations aide ran at least one turn of. */
  chats: number
  activeMs: number
  costUsd: number
  tokens: number
  /** epoch ms of the most recent run. Null cannot happen with runs > 0. */
  lastRunAt: number | null
  /** This project's share of the window's tokens, 0-1. */
  share: number
}

/**
 * How the tools were used, across every project.
 *
 * Counted from `tool.start` events rather than from the model's own account of
 * what it did, so it is what actually ran. Interesting mostly as a shape: a week
 * that is nine-tenths `Read` looks very different from one that is nine-tenths
 * `Edit`, and neither is visible from inside a single conversation.
 */
export interface ToolUse {
  name: string
  calls: number
  /** Calls that came back an error. */
  failed: number
}

/** One model's share of the spend. */
export interface ModelUse {
  model: string
  costUsd: number
  tokens: number
}

/**
 * When work happens: one cell per weekday × hour.
 *
 * The punchcard. `runIndex` has always carried a full timestamp per run and the
 * first version of this page reduced it to a per-day count, which threw away the
 * two questions the shape actually answers — what time of day you work, and
 * whether the weekend is different from the week. On the machine this was built
 * for the answer is emphatic (Sat 110 and Sun 105 turns against Wed 14), and
 * none of it was visible in a row of daily bars.
 *
 * `weekday` is 0=Monday..6=Sunday rather than JS's 0=Sunday, because the grid is
 * drawn Mon-first: keeping the renderer's order and the data's order the same is
 * what stops an off-by-one that silently mislabels every row.
 */
export interface HourCell {
  /** 0=Monday .. 6=Sunday. */
  weekday: number
  /** 0..23, local time. */
  hour: number
  runs: number
}

/**
 * How turns ended, over the window.
 *
 * The most actionable count on the page and the one the first version had no
 * room for: it reported 386 turns as a single number, when 206 of the 656 in
 * this machine's history were CANCELLED. A dashboard that shows only the work
 * that succeeded cannot show you the third of it that did not.
 *
 * `cancelled` folds every subtype the SDK reports for a turn that was stopped —
 * queued, during bootstrap, interrupted — because the distinction is about where
 * it was killed rather than about what you did, and four near-synonyms in a
 * legend is a chart nobody reads.
 */
export interface Outcomes {
  success: number
  cancelled: number
  failed: number
}

/**
 * A commit gate check, and how it has been going.
 *
 * From `verify.result`, which carries the command, whether it passed and how
 * long it took. This is the one part of aide that already has a pass/fail
 * history and never showed it anywhere — a check that has started failing, or
 * one that has quietly become the slowest thing about committing, is invisible
 * from inside any single conversation.
 */
export interface CheckRun {
  command: string
  passed: number
  failed: number
  /** Median wall-clock, ms. The median rather than the mean: one 90s timeout
   *  drags a mean into meaninglessness for a check that usually takes 2s. */
  medianMs: number
}

/**
 * How long turns take, as a distribution rather than a total.
 *
 * Agent time was a single summed figure, which hides the thing worth knowing:
 * on this machine the median turn is 8.9s and the 90th percentile is 506s, a
 * 57× spread. A mean over that is a number describing no turn that ever ran.
 */
export interface Durations {
  p50Ms: number
  p90Ms: number
  maxMs: number
  /** Turns that finished, i.e. the population these percentiles describe. */
  counted: number
}

/**
 * Everything the dashboard draws, in one document.
 *
 * One request rather than six, because every figure on the page comes from a
 * single pass over the same run index — splitting it into routes would mean
 * re-reducing the same array once per tile, and would let the tiles disagree
 * with each other across a poll boundary.
 */
export interface Activity {
  /** How many days back this covers. The page picks it; the daemon obeys. */
  days: number
  /** epoch ms this reading was taken. */
  readAt: number

  /** Totals over the window. */
  runs: number
  chats: number
  activeMs: number
  costUsd: number
  tokens: number

  /**
   * Every day in the window, oldest first, INCLUDING the empty ones.
   *
   * The gaps are the signal — a bar chart that silently omits the days nothing
   * happened draws a week of solid work over a week that had two days in it.
   */
  daily: ActivityDay[]
  projects: ProjectActivity[]
  tools: ToolUse[]
  models: ModelUse[]
  /** Weekday × hour. Always 168 cells, including the empty ones — see `HourCell`. */
  hours: HourCell[]
  outcomes: Outcomes
  checks: CheckRun[]
  durations: Durations
  /** Commits aide landed in the window, from `commit.landed`. */
  commits: number
  /** Turns that stopped to ask a human, from `permission.request`. */
  asks: number

  /**
   * Turns that died before the SDK named a session, over ALL of history.
   *
   * Surfaced rather than swallowed: it is the one number on the page that says
   * how much the page itself is missing. Usually zero, and shown only when it is
   * not — a count of nothing is noise on a dashboard.
   *
   * Deliberately NOT "logs on disk minus logs indexed". That figure counts logs
   * written by aide versions whose event vocabulary is gone, which on the
   * machine this was built on is 266 of them and would report a 44% loss rate
   * that is not real. See `unattributedRuns`.
   */
  unattributed: number

  /** Totals over ALL of history, however far back the logs go. */
  lifetime: {
    runs: number
    activeMs: number
    costUsd: number
    tokens: number
    /** epoch ms of the oldest run log, or null when there are none. */
    since: number | null
  }
}
