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
  /**
   * Wall-clock spent sitting at this project — its own sittings, clustered
   * independently of every other project's.
   *
   * Per-project rather than a slice of the machine's, because the sittings
   * genuinely differ: on this machine one project runs 62% busy over 39 hours
   * and another 79% over 8.5, and a single global ratio would report both as
   * the average of the two.
   */
  engagedMs: number
  /**
   * Of `engagedMs`, wall-clock a turn was running here — the union again.
   *
   * The numerator for this row's share, and NOT `activeMs` above, which sums.
   * One agent per project makes the two nearly equal, but not exactly: a commit
   * gate's repair turn runs inside the commit's own run, so a project's turns
   * can overlap by seconds. Dividing the sum by the span would mix definitions
   * and can exceed 1; this cannot.
   */
  busyMs: number
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
 * One unbroken stretch of working at the machine.
 *
 * The unit that makes "how much is aide actually working" answerable, and it
 * had to be invented because neither of the two obvious denominators is a real
 * one. Against the WINDOW, aide is busy 4.6% of the last 30 days on this
 * machine — a number that mostly measures sleep. Against the sum of the turns
 * themselves, it is 100% by construction. Neither says anything.
 *
 * A sitting is the middle: consecutive turns with no gap longer than
 * `IDLE_BREAK_MS` between them. Inside one, the clock is running on a piece of
 * work you are present for, so the split between agent time and your time is a
 * real ratio — 72% busy over this machine's 37 sittings. The hours between
 * sittings are not counted as anything, because "you were asleep" is not a
 * statistic about aide.
 *
 * Derived from `openedAt` and `activeMs`, which the index has always carried:
 * every figure here was reconstructible from the logs before this existed, and
 * nothing new is written to get it.
 */
export interface Sitting {
  /** epoch ms of the first turn's opening. */
  start: number
  /** epoch ms the last turn ended. */
  end: number
  /** Wall-clock from `start` to `end`. Agent time plus your time, exactly. */
  spanMs: number
  /**
   * Wall-clock inside the sitting during which at least one turn was running.
   *
   * The UNION of the turn intervals, not the sum of their durations, and the
   * difference is not pedantry: aide runs one agent per project but several
   * projects at once, so two turns overlap on the clock. Summed, this machine's
   * 30 days report 33.0h of agent time against a union of 30.2h — 2.8h counted
   * twice, and four sittings whose "agent time" exceeded their own span. The
   * sum is the right answer for `Activity.activeMs`, which asks how much work
   * was done; this is the right one for a share of wall-clock, which needs a
   * numerator that cannot exceed its denominator.
   */
  activeMs: number
  /**
   * Wall-clock inside the sitting that no turn was running.
   *
   * Your half: reading the diff, typing the next thing, deciding. Named for
   * what it is rather than "idle", because a sitting's gaps are the review the
   * brief's second gate is made of — calling that time wasted would be an
   * argument against the product.
   */
  humanMs: number
  turns: number
  /** Distinct projects worked in. Above one means the sitting jumped between them. */
  projects: number
}

/**
 * One day that had any work in it, measured end to end.
 *
 * The denominator the page actually scores against, and it exists because the
 * two totals either side of it are both unusable. The WINDOW includes the 21
 * days of the last 30 in which this machine ran nothing — you were not working,
 * and a product cannot recover a day you did not show up for. The SITTINGS
 * exclude every gap over half an hour, which is precisely the time the goal is
 * to reclaim. An active day is the middle: from your first turn to your last,
 * on a day you were demonstrably working.
 *
 * `idleMs` inside one of these is the target. Across this machine's 9 active
 * days it is 78.7h against 30.6h of aide actually running — so the honest score
 * is 28%, and the headroom is real rather than an artefact of counting sleep.
 */
export interface ActiveDay {
  /** Local `YYYY-MM-DD`. */
  day: string
  /** epoch ms of the first turn opened that day. */
  start: number
  /** epoch ms the last turn ended. */
  end: number
  /** `end - start`. The day's working span, not 24 hours. */
  spanMs: number
  /** Of that, wall-clock a turn was running. The union, per `Sitting.activeMs`. */
  activeMs: number
  /** `spanMs - activeMs`. The recoverable time — what the goal is to shrink. */
  idleMs: number
  turns: number
  /** Sittings that day. Above one means the day had a gap over the break in it. */
  sittings: number
}

/**
 * The three states the clock can be in, over the working time being scored.
 *
 * The net answer, and the reason the page does not just print one idle figure:
 * "idle" covers two things that want opposite responses. The short gaps between
 * turns are you reading a diff and typing the next thing — the brief calls that
 * the second gate, so it is the product working, not failing. The long ones are
 * aide sitting finished with nothing queued. On this machine the first is 15.6h
 * across 355 gaps and the second is 96.8h across twenty — same bucket, nothing
 * in common.
 *
 * Split at `Sitting`'s own break: a gap short enough to keep a sitting together
 * is review, and one long enough to end it is dead time. That is the same
 * threshold the clustering already uses, so there is one number to understand
 * rather than two.
 */
export interface WorkSplit {
  /** Wall-clock a turn was running. The union, never the sum. */
  activeMs: number
  /**
   * Idle inside a sitting: reading, typing, deciding.
   *
   * Counted against the goal but named separately, because driving it to zero
   * is not the aim — it is the review, and a version of aide you never paused
   * to read would be worse. It is here to be recognised rather than removed.
   */
  reviewMs: number
  /**
   * Idle between sittings: aide finished, nothing queued, you elsewhere.
   *
   * The number the goal is actually about. Nights and days off are already out
   * of it, so what is left is time that could have had a turn in it.
   */
  deadMs: number
}

/**
 * A stretch of the clock with nothing running, long enough to be worth naming.
 *
 * The page's worklist. A total says how much there is to recover; only the
 * individual stretches say WHERE, and the shape differs enormously — this
 * machine's 30 days hold twenty-one gaps under two hours (20.1h between them)
 * and two absences over thirty hours (74.0h between just those two). Those need
 * completely different answers, and a single "180h away" tile cannot tell you
 * which you have.
 */
export interface IdleStretch {
  /** epoch ms the last turn before it ended. */
  from: number
  /** epoch ms the next turn opened. */
  to: number
  ms: number
  /**
   * Whether this stretch stayed among days that had work in them.
   *
   * The recoverable/not line, and it tests ONLY for a day off: a gap between two
   * sittings on a working Tuesday is aide sitting finished while you were
   * elsewhere, and a 43-hour absence across a weekend is not a product problem.
   *
   * It does NOT also exclude sleep, and must not start doing so. Night is taken
   * out by overlap wherever this is consumed, which removes the sleeping part
   * and keeps the rest; a whole-stretch "mostly night" verdict on top of that
   * discarded a 00:40 → 09:30 gap along with its 110 waking minutes.
   */
  withinDay: boolean
}

/**
 * Where the wall-clock went, and how much of it is winnable.
 *
 * This page's scoreboard. The first version of it treated away time as context
 * and explicitly refused to use it as a denominator — correct for the question
 * "is aide efficient while I watch it" and wrong for the one that matters, which
 * is that away time is the thing to drive down. So the framing is inverted here:
 * `idleWithinDaysMs` is the number with a target on it, and everything else is
 * present to stop that number being gamed or misread.
 *
 * What is deliberately NOT counted against the goal: whole days with no work,
 * and the nights inside a working day's span. Neither is something aide can fix,
 * and a scoreboard that includes them can only ever be lost.
 */
export interface TimeSplit {
  /** Sittings in the window, newest first. */
  sittings: Sitting[]
  /** Days with any work, oldest first. The scoreboard's denominator. */
  activeDays: ActiveDay[]

  /** Wall-clock inside sittings. */
  engagedMs: number
  /**
   * Of that, wall-clock a turn was running — the union, per `Sitting.activeMs`.
   *
   * DELIBERATELY not equal to `Activity.activeMs`, which sums turn durations and
   * is therefore larger whenever two projects ran at once (33.0h against 30.2h
   * over this machine's last 30 days). Two questions, two right answers: that
   * one is how much work aide did, this one is how much of the clock it held.
   * They are shown on the same page, so the page says which is which.
   */
  activeMs: number
  /** Of that, time you were the one holding it. `engagedMs - activeMs`, exactly. */
  humanMs: number

  /**
   * Total span of the active days — first turn to last, summed over them.
   *
   * The goal's denominator. `activeMs / activeDaySpanMs` is the score, and it is
   * 28% on this machine against the 66% the sitting-only reading gave, because
   * that reading discarded exactly the gaps the goal is about.
   */
  activeDaySpanMs: number
  /**
   * The recoverable total: time inside a working day with nothing running.
   *
   * `activeDaySpanMs - activeMs`. The one number on the page with a target on
   * it, and the reason the rest of this interface exists.
   */
  idleWithinDaysMs: number
  /**
   * Wall-clock in the window outside every active day — days you did not work.
   *
   * Reported and kept OUT of the score. Not because it does not matter, but
   * because nothing aide does can change it: a day you never opened the laptop
   * cannot be made more productive by a better dashboard, and a score that
   * counts it is one you can only lose. It is on the page as context, in its
   * own row, saying what it is.
   */
  awayMs: number
  /** Days in the window that had any work at all, and the window's own length. */
  activeDayCount: number
  windowDays: number

  /**
   * The net split: running, reviewing, dead. Sums to `activeDaySpanMs`.
   *
   * The page's main reading. `idleWithinDaysMs` above is `reviewMs + deadMs`
   * and is kept because the bar draws two segments, but the three-way version
   * is what answers "working versus idle" without conflating the review with
   * the dead time — see `WorkSplit`.
   */
  split: WorkSplit
  /** The idle stretches, longest first. See `IdleStretch`. */
  idleStretches: IdleStretch[]
  /** Median sitting span, ms. Zero when there are none. */
  medianSpanMs: number
  /**
   * The longest single gap inside any sitting, and where it was.
   *
   * The one figure here that names a specific moment rather than a total: it is
   * how the "aide sat finished while I was elsewhere" case shows itself, which
   * a median over 350 gaps cannot.
   */
  longestGapMs: number
  longestGapAt: number | null
  /** The gap threshold that ends a sitting, so the page can say what it assumed. */
  breakMs: number
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
  /** Where the wall-clock went: agent time, your time, and away. See `TimeSplit`. */
  time: TimeSplit
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
