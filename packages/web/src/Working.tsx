import { useEffect, useState } from "react"
import { currentActivity, type RunEvent } from "@aide/protocol"
import { Hint } from "./Hint.js"

/**
 * What the turn is doing right now, in one line.
 *
 * Without this a chat looks broken for its first few seconds: the SDK takes a
 * moment to start, then thinks before it writes, and a transcript that only
 * grows when text arrives shows nothing at all in the meantime. "I sent a
 * message and nothing happened" is the same picture as "it is working".
 */

/**
 * Derived from the tail of the stream, so it needs no extra state on the wire.
 *
 * Not exported, though it reads like it wants to be: a non-component export next
 * to a component makes Fast Refresh reload the whole page instead of swapping
 * the component, and nothing outside this file needs it.
 */
/**
 * The bar's line.
 *
 * `currentActivity` lives in `protocol/activity-line.ts` rather than here, so
 * `pnpm smoke` can assert the vocabulary — a React component cannot be. See
 * `assertNarrationIsExhaustive` below for the half a test cannot catch.
 */
function describeActivity(events: readonly RunEvent[], runId: string | null): string {
  if (!runId) return ""
  const mine = events.filter((e) => e.runId === runId)
  if (mine.length === 0) return "Sending"
  return currentActivity(mine)?.label ?? "Working"
}

/**
 * Every event type that contributes no narration of its own.
 *
 * Kept here, unused, purely for the compile error: `currentActivity` ends in a
 * fallback, so a new event type added to `RunEventBody` would silently be
 * narrated as "Thinking" forever. This list fails to compile until somebody has
 * decided which bucket the new one belongs in, which is the only thing that
 * keeps the vocabulary a statement rather than whatever was true when it was
 * written. `permission.*`, `verify.started` and `tool.start` are in here despite
 * being matched inside that function: it looks for an OPEN call across the whole
 * run, so a resolved permission, a finished check, or a `tool.start` whose
 * `tool.end` has already landed all fall through to its tail like anything else.
 */
function assertNarrationIsExhaustive(last: RunEvent): void {
  if (
    last.type === "commit.step" ||
    last.type === "commit.drafting" ||
    last.type === "verify.result" ||
    last.type === "commit.drafted" ||
    last.type === "user.message" ||
    last.type === "assistant.thinking" ||
    last.type === "assistant.text" ||
    last.type === "tool.end" ||
    last.type === "run.started" ||
    last.type === "run.retry"
  ) {
    return
  }
  const noNarration:
    | "assistant.start"
    | "checkpoint.taken"
    | "commit.landed"
    | "context.usage"
    | "permission.request"
    | "permission.resolved"
    | "push.landed"
    | "run.error"
    | "run.finished"
    | "tool.denied"
    | "tool.start"
    | "turn.checkpoint"
    | "turn.stale"
    // The closing block, which by construction is the last thing in the reply —
    // so a turn that has emitted one is a turn about to end, and narrating it
    // would put a status on the bar for the moment before it disappears.
    | "turn.summary"
    | "verify.skipped"
    | "verify.started" = last.type
  void noNarration
}

/**
 * Elapsed time, ticking. A second counter is the cheapest possible proof that
 * something is still happening, which is exactly what is missing during the
 * quiet stretch before the first token.
 *
 * No stop in here, deliberately. The composer directly below this row has one,
 * where every other action in the pane is; a second one at the far right of this
 * row asked the same question twice a few pixels away, and was also what the
 * "jump to latest" pill was covering.
 */
export function WorkingBar({
  events,
  runId,
  outputTokens,
}: {
  events: readonly RunEvent[]
  runId: string | null
  /** Cumulative output tokens for the message in flight, straight off the stream. */
  outputTokens: number
}) {
  const [startedAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [])

  const seconds = Math.max(0, Math.round((now - startedAt) / 1000))
  const activity = describeActivity(events, runId)
  const waiting = activity.startsWith("Waiting")

  return (
    <div
      className={`flex shrink-0 items-center gap-2 border-t px-3 py-1.5 font-sans text-[11px] ${
        waiting ? "border-warn bg-warn/5 text-warn" : "border-line bg-chrome text-fg-muted"
      }`}
    >
      {!waiting && (
        <span className="inline-block size-2.5 shrink-0 animate-spin rounded-full border border-info border-t-transparent" />
      )}
      <span className="min-w-0 truncate">{activity}</span>
      <span className="shrink-0 text-fg-dim">
        {seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`}
      </span>
      {outputTokens > 0 && (
        <Hint hint="Output tokens in the message being written">
          <span className="shrink-0 text-fg-dim">{outputTokens.toLocaleString()} tokens</span>
        </Hint>
      )}
    </div>
  )
}
