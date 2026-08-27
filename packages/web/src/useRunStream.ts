import { useEffect, useRef, useState } from "react"
import type { RunDelta, RunEvent, ServerMessage } from "@aide/protocol"

export type StreamState = "idle" | "connecting" | "live" | "reconnecting"

function applyDelta(prev: LiveDraft, delta: RunDelta): LiveDraft {
  if (delta.kind === "text") return { ...prev, text: prev.text + delta.text }
  if (delta.kind === "thinking") return { ...prev, thinking: prev.thinking + delta.text }
  return { ...prev, outputTokens: delta.outputTokens }
}

/**
 * Live event stream for one run, with reconnect.
 *
 * The `fromSeq` handshake is what makes a browser refresh mid-run repopulate and
 * keep streaming instead of showing a blank pane. It is also the path most likely
 * to be quietly broken, since it only matters on reconnect.
 */
/** Text and thinking as they arrive, before the finished message replaces them. */
export interface LiveDraft {
  text: string
  thinking: string
  /** Cumulative output tokens for the message in flight, 0 when unknown. */
  outputTokens: number
}

const EMPTY_DRAFT: LiveDraft = { text: "", thinking: "", outputTokens: 0 }

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
        // draft is cleared rather than left to render twice.
        if (fresh.some((e) => e.type === "assistant.text")) {
          setDraft((prev) => ({ ...prev, text: "" }))
        }
        if (fresh.some((e) => e.type === "assistant.thinking")) {
          setDraft((prev) => ({ ...prev, thinking: "" }))
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
