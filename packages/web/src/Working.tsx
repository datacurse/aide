import { useEffect, useState } from "react"
import type { RunEvent } from "@aide/protocol"

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
function describeActivity(events: readonly RunEvent[], runId: string | null): string {
  if (!runId) return ""
  const mine = events.filter((e) => e.runId === runId)
  if (mine.length === 0) return "Sending"

  // A tool call with no matching tool.end is the thing currently running, and a
  // check with no matching result is the same idea for a commit.
  const open = new Set<string>()
  let lastToolName = ""
  let openCheck = ""
  for (const e of mine) {
    if (e.type === "tool.start") {
      open.add(e.toolUseId)
      lastToolName = e.name
    } else if (e.type === "tool.end") {
      open.delete(e.toolUseId)
    } else if (e.type === "verify.started") {
      openCheck = e.command
    } else if (e.type === "verify.result") {
      openCheck = ""
    }
  }

  // A pending permission outranks everything: nothing moves until it is answered.
  const answered = new Set(
    mine.filter((e) => e.type === "permission.resolved").map((e) => e.requestId),
  )
  const waiting = mine.find(
    (e) => e.type === "permission.request" && !answered.has(e.requestId),
  )
  if (waiting && waiting.type === "permission.request") return `Waiting for you · ${waiting.name}`

  if (open.size > 0) return `Running ${lastToolName}`
  // Ahead of the tail below, which would otherwise still be reporting the step
  // BEFORE the checks — a commit spends most of its wall clock in here, and for
  // all of it the bar read "reading what is uncommitted".
  if (openCheck) return `Running ${openCheck}`

  const last = mine[mine.length - 1]
  if (!last) return "Working"
  // The commit narrates itself, and its own words are better than anything
  // derivable from the shape of its log.
  if (last.type === "commit.step") return last.label
  if (last.type === "commit.drafting") return `Writing the message · ${last.model}`
  // Between two checks, or just after the last one. Naming the check that just
  // finished would read as one still running.
  if (last.type === "verify.result") return "Checking"
  if (last.type === "commit.drafted") return "Committing"
  if (last.type === "user.message") return "Starting"
  if (last.type === "assistant.thinking") return "Thinking"
  if (last.type === "assistant.text") return "Writing"
  if (last.type === "tool.end") return "Thinking"
  if (last.type === "run.started") return "Thinking"
  if (last.type === "run.retry") return "Retrying"

  // "Working" is the right answer for everything left, and the annotation is
  // what keeps that a decision. This bar names what a turn is doing RIGHT NOW,
  // so most events are either terminal (the bar is gone by then), one-shot
  // bookkeeping nobody narrates, or already covered by the open-tool and
  // open-check passes above. A new event type will not compile here until it has
  // been sorted into one of those, which is the only way this list stays a
  // statement rather than whatever was true when it was written.
  // `permission.*`, `verify.started` and `tool.start` are in here despite being
  // matched above: that pass looks for an OPEN call across the whole run, so a
  // resolved permission, a finished check, or a `tool.start` whose `tool.end`
  // has already landed all fall through to this tail like anything else. The
  // last of those is the one worth knowing about — the compiler found it, not a
  // reading of the code.
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
    | "verify.skipped"
    | "verify.started" = last.type
  void noNarration
  return "Working"
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
        <span className="shrink-0 text-fg-dim" title="Output tokens in the message being written">
          {outputTokens.toLocaleString()} tokens
        </span>
      )}
    </div>
  )
}
