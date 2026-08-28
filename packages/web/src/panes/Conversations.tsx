import { useEffect, useMemo, useRef, useState } from "react"
import type {
  Attachment,
  ChatMode,
  ChatStatus,
  ChatVerdict,
  ContextUsage,
  EffortLevel,
  RunEvent,
} from "@aide/protocol"
import { sortChats } from "@aide/protocol"
import { api, type ConversationRow, type ConversationView } from "../api.js"
import { useDoneChime } from "../chime.js"
import { Composer } from "../Composer.js"
import { discardDraft, draftKey, openNewChat, useDraft, type Draft } from "../drafts.js"
import { Markdown } from "../Markdown.js"
import { WorkingBar } from "../Working.js"
import { Confirm, Empty, PaneHeader } from "../ui.js"
import { useRunStream } from "../useRunStream.js"
import { useStickToBottom } from "../useStickToBottom.js"
import { ReviewPanel } from "./Review.js"
import { Transcript } from "./Transcript.js"

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

type Kinded = { kind: string; taskId: string | null }
const kindLabel = (c: Kinded) => (c.kind === "task" ? `task ${c.taskId}` : "chat")
const kindColor = (c: Kinded) => (c.kind === "task" ? "text-diff-add-fg" : "text-syn-var")

/**
 * A chat that exists but has not spoken yet.
 *
 * It is a row like any other so that pressing "new" produces something you can
 * see and come back to, rather than a blank pane you can only be in. Discardable
 * because it is the one row nothing else will ever remove: a chat that never
 * gets a first message never gets a session, so it would otherwise sit at the
 * top of the list forever.
 */
function UnstartedRow({
  draft,
  selected,
  onOpen,
  onDiscard,
}: {
  draft: Draft
  selected: boolean
  onOpen: () => void
  onDiscard: () => void
}) {
  const preview = draft.text.trim().split("\n", 1)[0] ?? ""
  return (
    <div
      className={`group flex w-full items-center gap-2 px-3 py-1.5 font-sans ${
        selected ? "bg-active text-white" : "text-fg-muted hover:bg-hover"
      }`}
    >
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
        <div className="flex items-baseline gap-2">
          <span className="shrink-0 text-[10px] text-syn-var">chat</span>
          <span className="flex-1 truncate text-[13px]">{preview || "New chat"}</span>
        </div>
        <div className="flex items-baseline gap-2 text-[10px] text-fg-dim">
          <span>not sent yet</span>
          {draft.attachments.length > 0 && (
            <span>
              {draft.attachments.length} image{draft.attachments.length > 1 ? "s" : ""}
            </span>
          )}
        </div>
      </button>
      <button
        type="button"
        onClick={onDiscard}
        title="Discard this chat"
        className="shrink-0 text-[11px] text-fg-dim opacity-0 group-hover:opacity-100 hover:text-err"
      >
        ✕
      </button>
    </div>
  )
}

/**
 * The list of a project's conversations.
 *
 * Both kinds are shown. A `chat` is a session whose cwd is the project root —
 * including ones started in the Claude Code CLI or the VS Code extension, since
 * aide reads the same store rather than keeping one of its own. A `task` is a
 * session that ran in one of aide's old worktrees, which means this list doubles as
 * run history: a task's earlier transcripts stay reachable here after a re-run,
 * where the run pane only ever shows the newest.
 */
/**
 * What a conversation wants from you, in one word.
 *
 * Nothing at all for an ordinary chat. Only work the board is tracking has a
 * lifecycle, and giving every conversation a badge would bury the two that
 * genuinely need something under thirty that do not.
 */
function StatusBadge({ status }: { status: ChatStatus }) {
  if (status.blocked && status.state !== "closed") {
    return <span className="shrink-0 text-[10px] text-err">blocked</span>
  }
  if (status.state === "working") {
    return <span className="shrink-0 text-[10px] text-info">working</span>
  }
  if (status.state === "needs-you") {
    return (
      <span className="shrink-0 text-[10px] text-warn">
        needs you{status.stale ? " · stale" : ""}
      </span>
    )
  }
  if (status.state === "closed") {
    const tone = status.verdict === "done" ? "text-ok" : "text-fg-dim"
    return <span className={`shrink-0 text-[10px] ${tone}`}>{status.verdict}</span>
  }
  return null
}

/**
 * The verdict bar.
 *
 * The only place in aide where work is declared finished, and deliberately the
 * only thing here an agent cannot reach: it may write the code, the spec and the
 * backlog, but a "done" it awarded itself would make every other one worthless.
 *
 * Shown only for work the board is tracking. An ordinary question has nothing to
 * resolve, and offering to close it would turn every chat into paperwork.
 *
 * Two buttons, not three. "Failed" used to sit between them and asked to be told
 * something the next message already says: work that did not land is work you
 * reply to, and the row stays open on its own until somebody settles it.
 */
function VerdictBar({
  status,
  onClose,
  onReopen,
}: {
  status: ChatStatus
  onClose: (verdict: ChatVerdict) => void
  onReopen: () => void
}) {
  // Dropping deletes the row and gives the checkout back, and the button sits a
  // few pixels from "done" — the two endings a mis-click confuses are the two
  // that are hardest to tell apart afterwards.
  const [dropping, setDropping] = useState(false)
  if (status.state === "closed") {
    return (
      <div className="flex shrink-0 items-center gap-2 border-t border-line bg-chrome px-3 py-1.5 font-sans text-[11px]">
        <span className={status.verdict === "done" ? "text-ok" : "text-fg-muted"}>
          closed as {status.verdict}
        </span>
        <button type="button" onClick={onReopen} className="ml-auto text-fg-dim hover:text-fg">
          reopen
        </button>
      </div>
    )
  }
  if (!status.rowId) return null

  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-line bg-chrome px-3 py-1.5 font-sans text-[11px]">
      <span className="text-fg-dim">working #{status.rowId}</span>
      <div className="ml-auto flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => onClose("done")}
          title="Finished. Removes the row from the backlog."
          className="rounded-sm bg-ok/80 px-2 py-0.5 text-white hover:bg-ok"
        >
          done
        </button>
        <button
          type="button"
          onClick={() => setDropping(true)}
          title="Not wanted after all. Removes the row and gives the checkout back."
          className="text-fg-muted hover:text-err"
        >
          drop
        </button>
      </div>
      {dropping && (
        <Confirm
          title={`Drop row #${status.rowId}?`}
          detail="The backlog line goes and the conversation closes. Any commits stay, and so does the checkpoint taken before it started. Nothing here says the work was finished, so use done if it was."
          confirmLabel="drop"
          onConfirm={() => {
            setDropping(false)
            onClose("dropped")
          }}
          onCancel={() => setDropping(false)}
        />
      )}
    </div>
  )
}

export function ConversationList({
  projectId,
  selected,
  onSelect,
}: {
  projectId: string | null
  selected: string | null
  /** null selects the chat that has not started yet — the draft row. */
  onSelect: (sessionId: string | null) => void
}) {
  const [items, setItems] = useState<ConversationRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  /**
   * The chat you pressed "new" for. It has no session id and no file on disk, so
   * the daemon cannot know about it and it cannot come back in `items` — until
   * its first turn, this record is the entire conversation.
   */
  const unstarted = useDraft(projectId ? draftKey(projectId, null) : null)

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
  if (items.length === 0 && !unstarted) {
    return (
      <Empty>
        No conversations yet. Chats from Claude Code and the VS Code extension appear here too.
      </Empty>
    )
  }

  return (
    <div className="flex-1 overflow-auto py-1">
      {unstarted && (
        <UnstartedRow
          draft={unstarted}
          selected={selected === null}
          onOpen={() => onSelect(null)}
          onDiscard={() => discardDraft(unstarted.key)}
        />
      )}
      {sortChats(items).map((c) => (
        <button
          key={c.sessionId}
          type="button"
          onClick={() => onSelect(c.sessionId)}
          className={`flex w-full flex-col gap-0.5 px-3 py-1.5 text-left font-sans ${
            c.sessionId === selected ? "bg-active text-white" : "text-fg-muted hover:bg-hover"
          }`}
        >
          <div className="flex items-baseline gap-2">
            <span className={`shrink-0 text-[10px] ${kindColor(c)}`} title={c.cwd}>
              {kindLabel(c)}
            </span>
            <span
              className={`flex-1 truncate text-[13px] ${
                c.status.state === "closed" ? "line-through decoration-1 opacity-60" : ""
              }`}
            >
              {c.title}
            </span>
            <StatusBadge status={c.status} />
          </div>
          <div className="flex items-baseline gap-2 text-[10px] text-fg-dim">
            <span>{ago(c.lastModified)}</span>
            {c.status.rowId && <span className="text-fg-dim">#{c.status.rowId}</span>}
            {c.bytes > 0 && <span>{mb(c.bytes)}</span>}
            {c.gitBranch && <span className="min-w-0 truncate">{c.gitBranch}</span>}
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
 * Keyed by session id rather than by a summary object, so the whole of what the
 * app is showing is a handful of strings — which is what lets it live in the URL
 * and survive a reload. Everything else about the conversation (its title, its
 * cwd, whether a turn is running) arrives with the transcript anyway.
 *
 * A null `openSessionId` is not an error state: it is a NEW conversation, which
 * has no id until the SDK assigns one on the first turn.
 */
export function ConversationPane({
  projectId,
  openSessionId,
  pendingTodoId,
  onStarted,
  onChanged,
}: {
  projectId: string | null
  openSessionId: string | null
  /**
   * The board row this new chat was started from, if any. Sent with the first
   * message because the row and the session are paired the moment the SDK names
   * the session, and there is no second chance to do it.
   */
  pendingTodoId?: string | null
  /** A new chat learns its session id mid-turn; the URL needs to know. */
  onStarted?: (sessionId: string) => void
  /** A verdict rewrote the backlog, so the board and the list are both stale. */
  onChanged?: () => void
}) {
  const [view, setView] = useState<ConversationView | null>(null)
  const [error, setError] = useState<string | null>(null)
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
  /**
   * Whether a NEW conversation gets a backlog row.
   *
   * Defaults off: most chats are questions, and a row for "where does this
   * function live" is noise on the board. A chat started from a row is already
   * tracked by definition.
   */
  const [tracked, setTracked] = useState(false)

  const summary = view?.summary ?? null
  const sessionId = openSessionId ?? liveSessionId
  const { events: live, draft } = useRunStream(runId)

  /**
   * The session this pane started itself, so adopting its id from the URL is not
   * mistaken for switching conversations.
   *
   * A ref rather than state: the reset below must be able to read it without
   * taking it as a dependency, which would make the reset run again.
   */
  const startedHere = useRef<string | null>(null)

  useEffect(() => {
    // Switching conversations clears the pane. Picking up the id of the chat you
    // just started here is not switching — the turn is streaming, and clearing
    // `runId` unsubscribes from it mid-answer, which is what left a new chat
    // showing your message and nothing else while the daemon carried on.
    if (openSessionId !== null && openSessionId === startedHere.current) return
    setView(null)
    setError(null)
    setRunId(null)
    setSent(new Map())
    setLiveSessionId(null)
  }, [openSessionId])

  useEffect(() => {
    if (!projectId || !openSessionId) return

    let cancelled = false
    void api
      .conversation(projectId, openSessionId)
      .then((v) => {
        if (!cancelled) setView(v)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [projectId, openSessionId])

  // Adopt a turn that was already running when this page loaded.
  //
  // `runId` lives in component state, so a reload loses it and the pane goes
  // quiet while the daemon carries on — the only way to find out whether
  // anything happened was to reload again. The daemon knows what is running;
  // this asks.
  useEffect(() => {
    const inFlight = view?.summary.activeRunId ?? null
    if (inFlight && !runId) setRunId(inFlight)
  }, [view?.summary.activeRunId, runId])

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
    if (openSessionId) return
    for (const e of live) {
      if (e.type === "run.started" && e.sessionId && !liveSessionId) {
        // Set before navigating: the reset effect reads it on the very next
        // render, and a state update would not have landed by then.
        startedHere.current = e.sessionId
        setLiveSessionId(e.sessionId)
        onStarted?.(e.sessionId)
      }
    }
  }, [live, liveSessionId, onStarted, openSessionId])

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

  // The point of the whole conversation pane is that you leave it running and
  // come back. Something has to say when to come back.
  useDoneChime(busy, runId)

  const usage = useMemo<ContextUsage | null>(() => {
    for (let i = turnEvents.length - 1; i >= 0; i -= 1) {
      const e = turnEvents[i]
      if (e?.type === "context.usage") {
        return { totalTokens: e.totalTokens, maxTokens: e.maxTokens, percentage: e.percentage }
      }
    }
    return null
  }, [turnEvents])

  const events = useMemo(() => {
    const history = view?.events ?? []
    // The session file is written as the turn goes, so an adopted turn can
    // already be partly present in the history we just read — and the event log
    // replays the same turn in full. Trim the history at the user message this
    // turn started with, and let the event log own everything from there.
    //
    // Matched on the text rather than assuming the last user message belongs to
    // the live turn: if the session file has not caught up yet there is no
    // overlap to trim, and cutting anyway would swallow the previous reply.
    const opening = turnEvents.find((e) => e.type === "user.message")
    if (opening?.type === "user.message") {
      const at = history.findLastIndex(
        (e) => e.type === "user.message" && e.text === opening.text,
      )
      if (at !== -1) return [...history.slice(0, at), ...turnEvents]
    }
    return [...history, ...turnEvents]
  }, [view?.events, turnEvents])

  const [showAll, setShowAll] = useState(false)
  const hidden = showAll ? 0 : Math.max(0, events.length - VISIBLE_TAIL)
  const shown = hidden > 0 ? events.slice(hidden) : events

  // Follow the tail while the reader is at the tail, and leave them alone the
  // moment they scroll up. See useStickToBottom for why this watches the content
  // rather than a dependency array.
  const { scroller, content, toBottom, onScroll, following } = useStickToBottom()

  // A newly opened conversation starts at the end, where the recent messages are.
  useEffect(() => {
    toBottom()
  }, [sessionId, view?.events.length, toBottom])

  const send = async (msg: {
    text: string
    attachments: Attachment[]
    mode: ChatMode
    effort: EffortLevel
  }) => {
    if (!projectId) return
    setError(null)
    // A first message is sent before the conversation has an id, so for the next
    // second or two the list has nothing to show for the thing now running —
    // unless the draft row is there to stand in for it. Usually it already is;
    // this covers arriving at a new chat without having pressed "new".
    if (!sessionId) openNewChat(projectId)
    try {
      // Both only mean anything on a first message — after that the daemon reads
      // the conversation's row off the board, so a reload cannot land a
      // follow-up in the wrong working directory.
      const opening = sessionId
        ? {}
        : pendingTodoId
          ? { todoId: pendingTodoId }
          : tracked
            ? { track: true }
            : {}
      const { runId: id } = await api.chat(projectId, { sessionId, ...msg, ...opening })
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

  const title = summary ? `conversation · ${summary.title}` : openSessionId ? "conversation" : "new chat"

  return (
    <section className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-editor">
      <PaneHeader title={title} />

      <div
        ref={scroller}
        onScroll={onScroll}
        className="relative flex-1 overflow-x-hidden overflow-y-auto px-3 py-2 font-mono text-xs leading-relaxed"
      >
        <div ref={content}>
        {openSessionId && view === null && !error ? (
          <Empty>Reading…</Empty>
        ) : events.length === 0 ? (
          <Empty>
            {projectId
              ? "Say something. This runs in the project root and can edit it."
              : "Select a project."}
          </Empty>
        ) : (
          <>
            {(hidden > 0 || view?.truncated) && (
              <div className="mb-2 border-b border-line pb-2 text-center font-sans text-[11px] text-fg-dim">
                {view?.truncated
                  ? `showing the most recent of ${view.totalMessages} messages`
                  : `${hidden} earlier events hidden`}
                {hidden > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowAll(true)}
                    className="ml-2 text-accent underline underline-offset-2"
                  >
                    show all
                  </button>
                )}
              </div>
            )}
            <Transcript events={shown} onPermission={busy ? answer : undefined}>
              {busy && (draft.thinking || draft.text) ? (
                <>
                  {draft.thinking && (
                    <p className="px-1 text-syn-comment italic">{draft.thinking}</p>
                  )}
                  {draft.text && (
                    <div className="px-1">
                      <Markdown text={draft.text} />
                    </div>
                  )}
                </>
              ) : null}
            </Transcript>
          </>
        )}
        {error && <p className="mt-2 font-sans text-[11px] text-err">{error}</p>}
        </div>
      </div>

      {/* Only while something is arriving: a button offering to jump to content
          that is not moving would be noise. */}
      {!following && busy && (
        <button
          type="button"
          onClick={toBottom}
          className="absolute right-6 bottom-32 z-10 rounded-full border border-line bg-chrome px-3 py-1 font-sans text-[11px] text-fg-muted shadow-lg hover:text-fg"
        >
          ↓ jump to latest
        </button>
      )}

      {busy && (
        <WorkingBar
          events={turnEvents}
          runId={runId}
          outputTokens={draft.outputTokens}
          onInterrupt={() => {
            if (runId) void api.interruptChat(runId).catch(() => {})
          }}
        />
      )}

      {/* Every conversation can produce a diff now — they all edit the project
          directly — so this is gated on the conversation being open rather than
          on it having a checkout of its own. A question simply shows an empty
          diff, which is the honest answer to "what did this change". */}
      {projectId && sessionId && summary && summary.status.state !== "closed" && (
        <ReviewPanel
          projectId={projectId}
          sessionId={sessionId}
          onCommitted={() => onChanged?.()}
        />
      )}

      {projectId && summary?.status && (
        <VerdictBar
          status={summary.status}
          onClose={(verdict) => {
            if (!sessionId) return
            void api
              .closeChat(projectId, sessionId, verdict)
              .then((r) => {
                // The verdict landed either way; a checkout that could not be
                // reclaimed is untidy, not a failure, so it is reported rather
                // than thrown.
                if (r.warning) setError(r.warning)
                onChanged?.()
              })
              .catch((err) => setError(err instanceof Error ? err.message : String(err)))
          }}
          onReopen={() => {
            if (!sessionId) return
            void api
              .reopenChat(projectId, sessionId)
              .then(() => onChanged?.())
              .catch((err) => setError(err instanceof Error ? err.message : String(err)))
          }}
        />
      )}

      {projectId && (
        <Composer
          busy={busy}
          usage={usage}
          sessionId={sessionId}
          draftKey={draftKey(projectId, sessionId)}
          inheritedMode={summary?.lastMode ?? null}
          // For a live conversation the board is the only thing that knows.
          tracked={sessionId ? summary?.status.rowId != null : tracked || pendingTodoId != null}
          onTracked={setTracked}
          onSend={(msg) => void send(msg)}
          onInterrupt={() => {
            if (runId) void api.interruptChat(runId).catch(() => {})
          }}
        />
      )}

      <footer className="flex h-[22px] shrink-0 items-center gap-4 border-t border-line bg-chrome px-3 font-sans text-[11px] text-fg-muted">
        {summary && <span className={`shrink-0 ${kindColor(summary)}`}>{kindLabel(summary)}</span>}
        {view && <span>{view.totalMessages} messages</span>}
        {busy && <span className="text-info">working…</span>}
        <span className="ml-auto min-w-0 truncate text-fg-dim" title={summary?.cwd}>
          {summary?.cwd ?? "runs in the project root"}
        </span>
      </footer>
    </section>
  )
}
