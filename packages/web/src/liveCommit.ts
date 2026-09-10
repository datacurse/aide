import type { RunEvent } from "@aide/protocol"

/**
 * Whether the run a surface is subscribed to is the auto-commit, not a
 * conversation's turn.
 *
 * A commit is a run — it holds the checkout, it has a run id, and a pane that
 * adopts a chat's `activeRunId` mid-commit is subscribed to it. It used to be
 * watched like a turn: step rows with spinners, the message streaming into a
 * box, the working bar narrating checks. That was inherited from when commit
 * was a button somebody pressed and waited on. Committing is background work
 * now — nobody asked for it, nothing waits on it, and a send is queued rather
 * than refused under it — so nothing about it is drawn while it is in flight.
 * The transcript's one-line record ("committed abc1234", or the failed check's
 * output) appears once it is OVER, which is where a commit explains itself.
 *
 * One function rather than the test written inline where it is wanted: anything
 * that adopts a run needs the same answer, and a rule implemented twice is the
 * two-readings wedge.
 *
 * Two tests, ORed. The holder is the daemon's own word (`held` means the hold
 * is a commit, not a turn) but it is polled and can be a beat behind the run
 * it names; the events are exact but empty for the moment between subscribing
 * and the backlog landing. Either alone leaves a frame of commit furniture on
 * screen; together they cover each other's gap. The event test is strict to
 * this run's id — history replayed from the session store carries past
 * commits' events under `runId: sessionId`, and matching those would hide a
 * finished chat turn.
 */
export function isCommitRun(
  events: RunEvent[],
  runId: string | null,
  holderRunId: string | null,
  holderHeld: boolean,
): boolean {
  if (!runId) return false
  if (holderHeld && holderRunId === runId) return true
  return events.some(
    (e) =>
      e.runId === runId &&
      (e.type === "commit.step" ||
        e.type === "commit.drafting" ||
        e.type === "commit.drafted" ||
        e.type === "commit.landed" ||
        e.type === "verify.started"),
  )
}
