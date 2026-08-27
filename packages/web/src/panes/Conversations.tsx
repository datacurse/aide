import { useEffect, useState } from "react"
import { api, type ConversationSummary, type ConversationView } from "../api.js"
import { Empty, PaneHeader } from "../ui.js"
import { Transcript } from "./Run.js"

/** Past this, a transcript is slow to read and slower to render; ask first. */
const HEAVY_BYTES = 2 * 1024 * 1024

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
 * One conversation, replayed.
 *
 * Not streamed: this is a finished transcript read off disk, so there is nothing
 * to subscribe to. It renders through the same `Transcript` the live run pane
 * uses, because the daemon normalizes session messages into the same events a
 * run emits — so a chat from VS Code and a task aide ran itself read alike.
 */
export function ConversationPane({
  projectId,
  summary,
}: {
  projectId: string | null
  summary: ConversationSummary | null
}) {
  const [view, setView] = useState<ConversationView | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Set when the transcript is big enough that loading it needs a decision. */
  const [heavy, setHeavy] = useState(false)

  const sessionId = summary?.sessionId ?? null

  useEffect(() => {
    setView(null)
    setError(null)
    setHeavy(Boolean(summary && summary.bytes > HEAVY_BYTES))
  }, [sessionId, summary?.bytes])

  useEffect(() => {
    if (!projectId || !sessionId || heavy) return

    let cancelled = false
    void api
      .conversation(projectId, sessionId)
      .then((v) => {
        if (!cancelled) setView(v)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [projectId, sessionId, heavy])

  if (!summary) {
    return (
      <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-editor">
        <PaneHeader title="conversation" />
        <Empty>Select a conversation to read it.</Empty>
      </section>
    )
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-editor">
      <PaneHeader title={`conversation · ${summary.title}`} />
      <div className="flex-1 overflow-auto px-3 py-2 font-mono text-xs leading-relaxed">
        {error ? (
          <Empty>{error}</Empty>
        ) : heavy ? (
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
        ) : view === null ? (
          <Empty>Reading…</Empty>
        ) : (
          <>
            {view.truncated && (
              <p className="mb-2 border-b border-line pb-2 font-sans text-[11px] text-warn">
                Showing the first part of {view.totalMessages} messages.
              </p>
            )}
            <Transcript events={view.events} />
          </>
        )}
      </div>
      <footer className="flex h-[22px] shrink-0 items-center gap-4 border-t border-line bg-chrome px-3 font-sans text-[11px] text-fg-muted">
        <span className={kindColor(summary)}>{kindLabel(summary)}</span>
        {view && <span>{view.totalMessages} messages</span>}
        <span>{ago(summary.lastModified)}</span>
        <span className="ml-auto truncate text-fg-dim" title={summary.cwd}>
          {summary.cwd}
        </span>
      </footer>
    </section>
  )
}
