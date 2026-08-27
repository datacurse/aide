import { useEffect, useMemo, useRef, useState } from "react"
import type { Attachment, ChatMode, ContextUsage, EffortLevel, RunEvent } from "@aide/protocol"
import { api, type ConversationSummary, type ConversationView } from "../api.js"
import { Composer } from "../Composer.js"
import { WorkingBar } from "../Working.js"
import { Empty, PaneHeader } from "../ui.js"
import { useRunStream } from "../useRunStream.js"
import { Transcript } from "./Run.js"

/** Past this, a transcript is slow to read and slower to render; ask first. */
const HEAVY_BYTES = 2 * 1024 * 1024

/**
 * How many events to render without being asked.
 *
 * A long conversation is thousands of events, every assistant turn of which goes
 * through a markdown parser. Rendering all of it makes the pane janky enough
 * that a reply arriving looks like nothing happening — the same symptom as a
 * broken stream, from a completely different cause. The tail is what anyone
 * actually wants to see on open.
 */
const VISIBLE_TAIL = 250

function ago(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86_400)}d ago`
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

const kindLabel = (c: ConversationSummary) => (c.kind === "task" ? `task ${c.taskId}` : "chat")
const kindColor = (c: ConversationSummary) =>
  c.kind === "task" ? "text-diff-add-fg" : "text-syn-var"

/**
 * The list of a project's conversations.
 *
 * Both kinds are shown. A `chat` is a session whose cwd is the project root —
 * including ones started in the Claude Code CLI or the VS Code extension, since
 * aide reads the same store rather than keeping one of its own. A `task` is a
 * session that ran in one of aide's worktrees, which means this list doubles as
 * run history: a task's earlier transcripts stay reachable here after a re-run,
 * where the run pane only ever shows the newest.
 */
export function ConversationList({
  projectId,
  selected,
  onSelect,
}: {
  projectId: string | null
  selected: string | null
  onSelect: (c: ConversationSummary) => void
}) {
  const [items, setItems] = useState<ConversationSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setItems(null)
    setError(null)
    if (!projectId) return

    let cancelled = false
    void api
      .conversations(projectId)
      .then((r) => {
        if (!cancelled) setItems(r)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [projectId])

  if (!projectId) return <Empty>Select a project.</Empty>
  if (error) return <Empty>{error}</Empty>
  if (items === null) return <Empty>Reading the session store…</Empty>
  if (items.length === 0) {
    return (
      <Empty>
        No conversations yet. Chats from Claude Code and the VS Code extension appear here too.
      </Empty>
    )
  }

  return (
    <div className="flex-1 overflow-auto py-1">
      {items.map((c) => (
        <button
          key={c.sessionId}
          type="button"
          onClick={() => onSelect(c)}
          className={`flex w-full flex-col gap-0.5 px-3 py-1.5 text-left font-sans ${
            c.sessionId === selected ? "bg-active text-white" : "text-fg-muted hover:bg-hover"
          }`}
        >
          <div className="flex items-baseline gap-2">
            <span className={`shrink-0 text-[10px] ${kindColor(c)}`} title={c.cwd}>
              {kindLabel(c)}
            </span>
            <span className="flex-1 truncate text-[13px]">{c.title}</span>
          </div>
          <div className="flex items-baseline gap-2 text-[10px] text-fg-dim">
            <span>{ago(c.lastModified)}</span>
            {c.bytes > 0 && <span>{mb(c.bytes)}</span>}
            {c.gitBranch && <span className="truncate">{c.gitBranch}</span>}
          </div>
        </button>
      ))}
    </div>
  )
}

/**
 * One conversation: what was said before, plus whatever is being said now.
 *
 * Two sources feed one transcript. The history is read off disk — a finished
 * file, so there is nothing to subscribe to. The turn in flight arrives on the
 * same live event stream a task run uses. They render through the same
 * `Transcript` because the daemon normalizes session messages into the same
 * events a run emits.
 *
 * `summary` being null is not an error state: it is a NEW conversation, which
 * has no id until the SDK assigns one on the first turn.
 */
export function ConversationPane({
  projectId,
  summary,
  onStarted,
}: {
  projectId: string | null
  summary: ConversationSummary | null
  /** A new chat learns its session id mid-turn; the list needs to know. */
  onStarted?: (sessionId: string) => void
}) {
  const [view, setView] = useState<ConversationView | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Set when the transcript is big enough that loading it needs a decision. */
  const [heavy, setHeavy] = useState(false)
  /** The turn in flight, if any. */
  const [runId, setRunId] = useState<string | null>(null)
  /**
   * Events from every turn sent in this sitting, keyed so a re-subscribe that
   * replays the log does not duplicate them. Kept separate from `view` because
   * the session file on disk is only rewritten when the turn ends.
   */
  const [sent, setSent] = useState<Map<string, RunEvent>>(new Map())
  /** Known once a new conversation's first turn starts. */
  const [liveSessionId, setLiveSessionId] = useState<string | null>(null)

  const sessionId = summary?.sessionId ?? liveSessionId
  const { events: live } = useRunStream(runId)

  useEffect(() => {
    setView(null)
    setError(null)
    setRunId(null)
    setSent(new Map())
    setLiveSessionId(null)
    setHeavy(Boolean(summary && summary.bytes > HEAVY_BYTES))
  }, [summary?.sessionId, summary?.bytes])

  useEffect(() => {
    if (!projectId || !summary || heavy) return

    let cancelled = false
    void api
      .conversation(projectId, summary.sessionId)
      .then((v) => {
        if (!cancelled) setView(v)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [projectId, summary?.sessionId, heavy])

  // Fold the live stream into the accumulator. Keyed by runId+seq so the replay
  // a reconnect delivers lands on top of what is already there.
  useEffect(() => {
    if (live.length === 0) return
    setSent((prev) => {
      const next = new Map(prev)
      for (const e of live) next.set(`${e.runId}:${e.seq}`, e)
      return next
    })
    // Only a NEW conversation needs this: it has no id until the SDK assigns one,
    // and the list has no row for it yet. An existing one already knows its id,
    // and telling the list to refetch mid-turn just churns it.
    if (summary) return
    for (const e of live) {
      if (e.type === "run.started" && e.sessionId && !liveSessionId) {
        setLiveSessionId(e.sessionId)
        onStarted?.(e.sessionId)
      }
    }
  }, [live, liveSessionId, onStarted, summary])

  const turnEvents = useMemo(
    () => [...sent.values()].sort((a, b) => (a.runId === b.runId ? a.seq - b.seq : 0)),
    [sent],
  )

  // The turn is over when its log has a terminal event — the same invariant the
  // run pane relies on.
  const finished = useMemo(
    () =>
      runId !== null &&
      turnEvents.some(
        (e) => e.runId === runId && (e.type === "run.finished" || e.type === "run.error"),
      ),
    [turnEvents, runId],
  )
  const busy = runId !== null && !finished

  const usage = useMemo<ContextUsage | null>(() => {
    for (let i = turnEvents.length - 1; i >= 0; i -= 1) {
      const e = turnEvents[i]
      if (e?.type === "context.usage") {
        return { totalTokens: e.totalTokens, maxTokens: e.maxTokens, percentage: e.percentage }
      }
    }
    return null
  }, [turnEvents])

  const events = useMemo(
    () => [...(view?.events ?? []), ...turnEvents],
    [view?.events, turnEvents],
  )

  const [showAll, setShowAll] = useState(false)
  const hidden = showAll ? 0 : Math.max(0, events.length - VISIBLE_TAIL)
  const shown = hidden > 0 ? events.slice(hidden) : events

  // Follow the tail, but stop fighting the user the moment they scroll up. Same
  // rule as the run pane; without it a reply lands hundreds of messages below
  // the fold and reads as nothing having happened at all.
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  useEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [shown.length])

  // A newly opened conversation starts at the end, where the recent messages are.
  useEffect(() => {
    pinned.current = true
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [sessionId, view?.events.length])

  const send = async (msg: {
    text: string
    attachments: Attachment[]
    mode: ChatMode
    effort: EffortLevel
  }) => {
    if (!projectId) return
    setError(null)
    try {
      const { runId: id } = await api.chat(projectId, { sessionId, ...msg })
      setRunId(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const answer = (requestId: string, allowed: boolean) => {
    if (!runId) return
    void api.answerPermission(runId, requestId, allowed).catch((err) => {
      setError(err instanceof Error ? err.message : String(err))
    })
  }

  const title = summary ? `conversation · ${summary.title}` : "new chat"

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-editor">
      <PaneHeader title={title} />

      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
        }}
        className="flex-1 overflow-auto px-3 py-2 font-mono text-xs leading-relaxed"
      >
        {heavy && summary ? (
          <Empty>
            This transcript is {mb(summary.bytes)} on disk.{" "}
            <button
              type="button"
              onClick={() => setHeavy(false)}
              className="text-accent underline underline-offset-2"
            >
              Load it anyway
            </button>
          </Empty>
        ) : summary && view === null && !error ? (
          <Empty>Reading…</Empty>
        ) : events.length === 0 ? (
          <Empty>
            {projectId
              ? "Say something. This runs in the project root and can edit it."
              : "Select a project."}
          </Empty>
        ) : (
          <>
            {view?.truncated && (
              <p className="mb-2 border-b border-line pb-2 font-sans text-[11px] text-warn">
                Showing the first part of {view.totalMessages} messages.
              </p>
            )}
            {hidden > 0 && (
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="mb-2 w-full border-b border-line pb-2 font-sans text-[11px] text-fg-dim hover:text-fg"
              >
                {hidden} earlier events hidden — show all
              </button>
            )}
            <Transcript events={shown} onPermission={busy ? answer : undefined} />
          </>
        )}
        {error && <p className="mt-2 font-sans text-[11px] text-err">{error}</p>}
      </div>

      {busy && (
        <WorkingBar
          events={turnEvents}
          runId={runId}
          onInterrupt={() => {
            if (runId) void api.interruptChat(runId).catch(() => {})
          }}
        />
      )}

      {projectId && (
        <Composer
          busy={busy}
          usage={usage}
          onSend={(msg) => void send(msg)}
          onInterrupt={() => {
            if (runId) void api.interruptChat(runId).catch(() => {})
          }}
        />
      )}

      <footer className="flex h-[22px] shrink-0 items-center gap-4 border-t border-line bg-chrome px-3 font-sans text-[11px] text-fg-muted">
        {summary && <span className={kindColor(summary)}>{kindLabel(summary)}</span>}
        {view && <span>{view.totalMessages} messages</span>}
        {busy && <span className="text-info">working…</span>}
        <span className="ml-auto truncate text-fg-dim" title={summary?.cwd}>
          {summary?.cwd ?? "runs in the project root"}
        </span>
      </footer>
    </section>
  )
}
