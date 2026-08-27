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

/** Derived from the tail of the stream, so it needs no extra state on the wire. */
export function describeActivity(events: readonly RunEvent[], runId: string | null): string {
  if (!runId) return ""
  const mine = events.filter((e) => e.runId === runId)
  if (mine.length === 0) return "Sending"

  // A tool call with no matching tool.end is the thing currently running.
  const open = new Set<string>()
  let lastToolName = ""
  for (const e of mine) {
    if (e.type === "tool.start") {
      open.add(e.toolUseId)
      lastToolName = e.name
    } else if (e.type === "tool.end") {
      open.delete(e.toolUseId)
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

  const last = mine[mine.length - 1]
  if (!last) return "Working"
  if (last.type === "user.message") return "Starting"
  if (last.type === "assistant.thinking") return "Thinking"
  if (last.type === "assistant.text") return "Writing"
  if (last.type === "tool.end") return "Thinking"
  if (last.type === "run.started") return "Thinking"
  if (last.type === "run.retry") return "Retrying"
  return "Working"
}

/**
 * Elapsed time, ticking. A second counter is the cheapest possible proof that
 * something is still happening, which is exactly what is missing during the
 * quiet stretch before the first token.
 */
export function WorkingBar({
  events,
  runId,
  onInterrupt,
}: {
  events: readonly RunEvent[]
  runId: string | null
  onInterrupt: () => void
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
      <span>{activity}</span>
      <span className="text-fg-dim">
        {seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`}
      </span>
      <button
        type="button"
        onClick={onInterrupt}
        className="ml-auto text-fg-dim underline-offset-2 hover:text-err hover:underline"
      >
        stop
      </button>
    </div>
  )
}
