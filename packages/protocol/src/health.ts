/**
 * What `/api/health` answers.
 *
 * This used to be declared in the web package alone, with the daemon returning a
 * matching object literal and nothing checking that the two agreed. That is
 * survivable for three constants and not for the fields below, which exist so
 * one process can decide whether to restart another: a field that silently
 * arrives as `undefined` here reads as "not stale, not busy", and the failure
 * mode of getting that wrong is restarting a daemon mid-run.
 */

/** What a restart would interrupt. All zero means restarting costs nothing. */
export interface DaemonBusy {
  /** Task runs in flight, queued ones included — shutdown cancels those too. */
  runs: number
  /** Chat turns mid-answer. */
  chats: number
  /** Mutating HTTP requests that have not answered yet. See below. */
  writes: number
}

export interface Health {
  ok: boolean
  taskModel: string
  maxConcurrentRuns: number
  maxBudgetUsd: number

  /**
   * Fingerprint of the source this process booted from, and of the source on
   * disk right now. Either is null when there is no source tree to read, which
   * is why `stale` is its own field rather than a comparison the caller makes:
   * unknown must not read as changed.
   */
  bootSourceId: string | null
  sourceId: string | null
  stale: boolean

  /**
   * Started by a dev server, and therefore restartable by one.
   *
   * Not the same question as "did I spawn it". Vite constructs a new plugin
   * instance whenever the config or any of its imports change, and the new
   * instance holds no child process for the daemon its predecessor started — so
   * ownership is lost on every edit to the dev-server plumbing, and without this
   * the automatic restart would quietly stop working exactly when someone is
   * working on it. A daemon started by hand with `pnpm daemon` reports false and
   * is never touched.
   */
  supervised: boolean

  busy: DaemonBusy
  /**
   * Milliseconds since the last mutating request finished.
   *
   * `busy.writes === 0` is not on its own a safe moment to restart. A land is
   * one request, but the browser follows it with a burst of others, and the gap
   * between two of them is a window where nothing is in flight and the work is
   * plainly not over. Requiring a quiet stretch turns that gap into a
   * non-answer.
   */
  idleMs: number
}

/**
 * Whether a daemon whose source has changed can be restarted right now.
 *
 * A pure function, deliberately, and not because purity is nice: this is the
 * rule whose previous version — chokidar firing on a file write — killed a
 * daemon three lines into a land, stranding the task at `committed` with an
 * orphaned worktree. That is not a rule to leave untested inside a closure that
 * also does HTTP.
 *
 * `previousSourceId` is the fingerprint seen on the last check. Requiring it to
 * match is what stops a restart per tick while a `git merge` is part way through
 * rewriting forty files: a tree that is still moving reports a different
 * fingerprint each time it is asked.
 */
export interface RestartDecision {
  restart: boolean
  /** Why — worth logging either way, since "not yet" is the interesting case. */
  reason: string
}

export function restartDecision(
  health: Health,
  previousSourceId: string | null,
  quietMs: number,
): RestartDecision {
  if (!health.stale) return { restart: false, reason: "up to date" }
  // Unknown is not changed. A daemon with no readable source tree must never be
  // restarted on suspicion.
  if (health.sourceId === null) return { restart: false, reason: "source cannot be read" }
  if (health.sourceId !== previousSourceId) {
    return { restart: false, reason: "source is still changing" }
  }

  const { runs, chats, writes } = health.busy
  if (runs + chats + writes > 0) {
    const parts = [
      runs > 0 ? `${runs} run${runs > 1 ? "s" : ""}` : null,
      chats > 0 ? `${chats} chat turn${chats > 1 ? "s" : ""}` : null,
      writes > 0 ? `${writes} request${writes > 1 ? "s" : ""}` : null,
    ].filter(Boolean)
    return { restart: false, reason: `${parts.join(", ")} in flight` }
  }
  if (health.idleMs < quietMs) {
    return { restart: false, reason: `only ${health.idleMs}ms since the last write` }
  }
  return { restart: true, reason: `source changed (${health.bootSourceId} to ${health.sourceId})` }
}
