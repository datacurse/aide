import { useEffect, useRef, useState } from "react"
import type { RunDelta, RunEvent, ServerMessage } from "@aide/protocol"

export type StreamState = "idle" | "connecting" | "live" | "reconnecting"

function applyDelta(prev: LiveDraft, delta: RunDelta): LiveDraft {
  if (delta.kind === "text") return { ...prev, text: prev.text + delta.text }
  if (delta.kind === "thinking") return { ...prev, thinking: prev.thinking + delta.text }
  if (delta.kind === "tool") {
    // Stamped on arrival rather than carried on the wire, which is the same
    // trick a tool row already plays with `tool.start`: aide is loopback-only,
    // so the browser's clock and the daemon's are the same clock.
    if (prev.tools.some((t) => t.toolUseId === delta.toolUseId)) return prev
    const started = { toolUseId: delta.toolUseId, name: delta.name, startedAt: Date.now() }
    return { ...prev, tools: [...prev.tools, started] }
  }
  return { ...prev, outputTokens: delta.outputTokens }
}

/**
 * Live event stream for one run, with reconnect.
 *
 * The `fromSeq` handshake is what makes a browser refresh mid-run repopulate and
 * keep streaming instead of showing a blank pane. It is also the path most likely
 * to be quietly broken, since it only matters on reconnect.
 */
/** A tool call the model has named but whose `tool.start` has not arrived yet. */
export interface LiveTool {
  toolUseId: string
  name: string
  /** By the browser's clock; see `applyDelta`. */
  startedAt: number
}

/** Text and thinking as they arrive, before the finished message replaces them. */
export interface LiveDraft {
  text: string
  thinking: string
  /**
   * Calls announced but not yet events. Each is dropped the moment its own
   * `tool.start` lands — matched on `toolUseId`, not cleared wholesale like
   * text is, because one assistant message can open several calls and the
   * events for them arrive together at the end of it. Clearing the list on the
   * first would blank the rows for its siblings a frame before they were
   * redrawn from the log.
   */
  tools: LiveTool[]
  /** Cumulative output tokens for the message in flight, 0 when unknown. */
  outputTokens: number
}

const EMPTY_DRAFT: LiveDraft = { text: "", thinking: "", tools: [], outputTokens: 0 }

export function useRunStream(runId: string | null): {
  events: RunEvent[]
  draft: LiveDraft
  state: StreamState
} {
  const [events, setEvents] = useState<RunEvent[]>([])
  const [draft, setDraft] = useState<LiveDraft>(EMPTY_DRAFT)
  const [state, setState] = useState<StreamState>("idle")
  const seq = useRef(0)

  useEffect(() => {
    setEvents([])
    setDraft(EMPTY_DRAFT)
    seq.current = 0

    if (!runId) {
      setState("idle")
      return
    }

    let disposed = false
    let socket: WebSocket | null = null
    let retry: ReturnType<typeof setTimeout> | undefined
    let attempt = 0

    const connect = () => {
      if (disposed) return
      setState(attempt === 0 ? "connecting" : "reconnecting")

      const url = new URL("/ws", window.location.href)
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
      socket = new WebSocket(url)

      socket.onopen = () => {
        attempt = 0
        setState("live")
        // Resume from the last seq we actually rendered, so nothing is missed and
        // nothing is duplicated across a reconnect.
        socket?.send(JSON.stringify({ type: "subscribe", runId, fromSeq: seq.current }))
      }

      socket.onmessage = (raw) => {
        let msg: ServerMessage
        try {
          msg = JSON.parse(String(raw.data)) as ServerMessage
        } catch {
          return
        }
        if (msg.type === "delta") {
          setDraft((prev) => applyDelta(prev, msg.delta))
          return
        }
        if (msg.type !== "events") return

        // Dedupe here rather than inside the state updater: StrictMode may invoke
        // an updater twice, which would make a ref bump inside it drop events.
        const fresh = msg.events.filter((e) => e.seq > seq.current)
        if (!fresh.length) return
        seq.current = fresh[fresh.length - 1]!.seq
        setEvents((prev) => [...prev, ...fresh])

        // A completed block supersedes whatever was being typed into it, so the
        // draft is cleared rather than left to render twice. `commit.drafted` is
        // the commit run's version of the same thing — it carries the finished
        // message, and without it here the message the model just streamed stays
        // on screen underneath its own final copy.
        if (fresh.some((e) => e.type === "assistant.text" || e.type === "commit.drafted")) {
          setDraft((prev) => ({ ...prev, text: "" }))
        }
        if (fresh.some((e) => e.type === "assistant.thinking")) {
          setDraft((prev) => ({ ...prev, thinking: "" }))
        }
        // A live tool row is superseded by its own event and no other, so this
        // retires them one id at a time. The event carries the arguments the
        // delta had none of, so the row it hands over to says more, not less.
        const started = new Set(
          fresh.flatMap((e) => (e.type === "tool.start" ? [e.toolUseId] : [])),
        )
        if (started.size) {
          setDraft((prev) =>
            prev.tools.some((t) => started.has(t.toolUseId))
              ? { ...prev, tools: prev.tools.filter((t) => !started.has(t.toolUseId)) }
              : prev,
          )
        }
        if (fresh.some((e) => e.type === "run.finished" || e.type === "run.error")) {
          setDraft(EMPTY_DRAFT)
        }
      }

      socket.onclose = () => {
        if (disposed) return
        attempt += 1
        setState("reconnecting")
        retry = setTimeout(connect, Math.min(1000 * attempt, 5000))
      }
    }

    connect()

    return () => {
      disposed = true
      if (retry) clearTimeout(retry)
      socket?.close()
    }
  }, [runId])

  return { events, draft, state }
}
