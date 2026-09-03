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
