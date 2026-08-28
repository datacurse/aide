import { useEffect, useMemo, useRef, useState } from "react"
import type {
  Attachment,
  ChatMode,
  ChatStatus,
  ContextUsage,
  EffortLevel,
  RunEvent,
} from "@aide/protocol"
import { sortChats } from "@aide/protocol"
import { api, type ConversationRow, type ConversationView } from "../api.js"
import { useDoneChime } from "../chime.js"
import { Composer, MAX_ATTACHMENT_BYTES, readAsAttachment } from "../Composer.js"
import {
  addBacklogChat,
  discardDraft,
  draftKey,
  idFromKey,
  useUnstartedChats,
  type Draft,
} from "../drafts.js"
import { Markdown } from "../Markdown.js"
import { WorkingBar } from "../Working.js"
import { Empty, PaneHeader } from "../ui.js"
import { useRunStream } from "../useRunStream.js"
import { useAutoGrow } from "../useAutoGrow.js"
import { useStickToBottom } from "../useStickToBottom.js"
import { CommitMessageDraft, Transcript } from "./Transcript.js"

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
 * see and come back to, rather than a blank pane you can only be in. It is also
 * the whole of the backlog: something you want is a chat you have written and
 * not sent, so there is no second list and nothing to keep in step with one.
 *
 * Discardable because it is the one row nothing else will ever remove — a chat
 * that never gets a first message never gets a session, so it would otherwise
 * sit at the top of the list forever.
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
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
      >
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
 * Something you want, in one box.
 *
 * The same field the board used to have, moved to the top of the only list there
 * is. What it makes is not a row that a chat is later attached to — it IS the
 * chat, unsent. That is what let the board go: there was never anything in a
 * backlog line that a conversation with no messages could not hold, and keeping
 * both meant keeping them in step with each other forever.
 */
function CaptureBox({ projectId, onAdded }: { projectId: string; onAdded: (id: string) => void }) {
  const [text, setText] = useState("")
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [note, setNote] = useState<string | null>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  useAutoGrow(box, text, { minRows: 1, maxRows: 8 })

  const submit = () => {
    if (!text.trim() && attachments.length === 0) return
    // Not flattened to one line the way a todo had to be: this goes into a
    // message box rather than a line-based file, so a request that wants three
    // paragraphs keeps them.
    onAdded(addBacklogChat(projectId, { text: text.trim(), attachments }))
    setText("")
    setAttachments([])
    setNote(null)
  }

  const takeFiles = async (files: FileList | File[]) => {
    const images = [...files].filter((f) => f.type.startsWith("image/"))
    if (images.length === 0) return
    const tooBig = images.filter((f) => f.size > MAX_ATTACHMENT_BYTES)
    if (tooBig.length) setNote(`${tooBig.length} image(s) too large, skipped`)
    const read = await Promise.all(
      images.filter((f) => f.size <= MAX_ATTACHMENT_BYTES).map(readAsAttachment),
    )
    const added = read.filter((a): a is Attachment => a !== null)
    if (added.length) setAttachments((prev) => [...prev, ...added])
  }

  return (
    <div className="shrink-0 border-b border-line bg-editor p-2">
      {attachments.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {attachments.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
              title="Remove this image"
              className="rounded border border-line-soft px-1.5 py-0.5 font-sans text-[10px] text-fg-dim hover:border-err hover:text-err"
            >
              image ✕
            </button>
          ))}
        </div>
      )}
      {/* A textarea, not an input. An input scrolls sideways once the text passes
          the width of the box, so the sentence you are in the middle of writing
          slides off the left edge as you type it. */}
      <textarea
        ref={box}
        value={text}
        onChange={(e) => setText(e.target.value)}
        // Enter rather than a button as the primary path. Capturing an idea has
        // to cost one line typed, or it loses to saying the thing in a chat and
        // the list stops being true.
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            submit()
          }
        }}
        onPaste={(e) => {
          const files = [...e.clipboardData.files]
          if (files.some((f) => f.type.startsWith("image/"))) {
            e.preventDefault()
            void takeFiles(files)
          }
        }}
        rows={1}
        placeholder="Something you want. Enter to park it."
        className="w-full resize-none rounded border border-line-soft bg-input px-2 py-1 font-sans text-xs leading-relaxed outline-none placeholder:text-fg-dim focus:border-accent"
      />
      {note && <p className="mt-1 font-sans text-[10px] text-warn">{note}</p>}
    </div>
  )
}

/**
 * What a conversation wants from you, in one word.
 *
 * Nothing at all for a chat that is simply sitting there. A badge on every row
 * would bury the two that genuinely need something under the thirty that do not.
 */
function StatusBadge({ status }: { status: ChatStatus }) {
  if (status.blocked && status.state !== "closed") {
    return <span className="shrink-0 text-[10px] text-err">blocked</span>
  }
  if (status.state === "working") {
    return <span className="shrink-0 text-[10px] text-info">working</span>
  }
  return null
}

/**
 * Done, or not.
 *
 * The one thing in aide an agent cannot reach. It may write the code and the
 * commit message; a "done" it awarded itself would make every other one
 * worthless. So this is a box a person ticks — and it is on every chat rather
 * than only on tracked work, because the question it answers is which of thirty
 * conversations still want something from you.
 *
 * A toggle, not a verdict. The two states are "this served its purpose" and "not
 * yet"; anything finer was a form to fill in, and the transcript already says
 * what happened.
 */
function DoneCheck({ done, onToggle }: { done: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={done ? "Served its purpose. Click to reopen it." : "Mark this chat done"}
      className={`mt-0.5 shrink-0 rounded-sm border px-1 text-[10px] leading-4 ${
        done
          ? "border-ok/60 text-ok"
          : "border-line text-transparent group-hover:text-fg-dim hover:border-fg-dim"
      }`}
    >
      ✓
    </button>
  )
}

/**
 * The list of a project's conversations, and the only list there is.
 *
 * Three kinds of row, in one column, because they are all the same thing at
 * different ages: a chat you have written and not sent, a chat that is running,
 * and a chat that is over. A separate backlog was the second copy of the first
 * of those.
 *
 * A `chat` is a session whose cwd is the project root — including ones started
 * in the Claude Code CLI or the VS Code extension, since aide reads the same
 * store rather than keeping one of its own. A `task` is a session that ran in
 * one of aide's old worktrees, which is why this doubles as run history.
 */
export function ConversationList({
  projectId,
  selected,
  selectedDraft,
  onSelect,
  onSelectDraft,
  onChanged,
}: {
  projectId: string | null
  selected: string | null
  /** The unstarted chat that is open, when the open one is not a session. */
  selectedDraft: string | null
  onSelect: (sessionId: string) => void
  onSelectDraft: (draftId: string) => void
  /** Ticking a chat off changes the row the pane below is showing. */
  onChanged: () => void
}) {
  const [items, setItems] = useState<ConversationRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  /**
   * The chats that have not started. They have no session id and no file on
   * disk, so the daemon cannot know about them and they cannot arrive in
   * `items` — until a first turn, these records are the entire conversation.
   */
  const unstarted = useUnstartedChats(projectId)

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

  const toggleDone = (row: ConversationRow) => {
    if (!projectId) return
    const call =
      row.status.state === "closed"
        ? api.reopenChat(projectId, row.sessionId)
        : api.closeChat(projectId, row.sessionId)
    // No local refetch: `onChanged` remounts this list, which fetches. Doing
    // both would ask the daemon the same question twice per tick.
    void call
      .then(() => onChanged())
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }

  if (!projectId) return <Empty>Select a project.</Empty>

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <CaptureBox projectId={projectId} onAdded={onSelectDraft} />
      {error && (
        <p className="border-b border-line px-3 py-1.5 font-sans text-[11px] text-err">{error}</p>
      )}
      <div className="flex-1 overflow-auto py-1">
        {unstarted.map((d) => (
          <UnstartedRow
            key={d.key}
            draft={d}
            selected={selectedDraft === idFromKey(d.key)}
            onOpen={() => onSelectDraft(idFromKey(d.key))}
            onDiscard={() => discardDraft(d.key)}
          />
        ))}
        {items === null && <Empty>Reading the session store…</Empty>}
        {items?.length === 0 && unstarted.length === 0 && (
          <Empty>
            Nothing here yet. Type what you want above, or press new. Chats from Claude Code and
            the VS Code extension appear here too.
          </Empty>
        )}
        {items !== null &&
          sortChats(items).map((c) => (
            <div
              key={c.sessionId}
              className={`group flex w-full items-start gap-2 px-3 py-1.5 font-sans ${
                c.sessionId === selected ? "bg-active text-white" : "text-fg-muted hover:bg-hover"
              }`}
            >
              <button
                type="button"
                onClick={() => onSelect(c.sessionId)}
                className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
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
                  {c.bytes > 0 && <span>{mb(c.bytes)}</span>}
                  {c.gitBranch && <span className="min-w-0 truncate">{c.gitBranch}</span>}
                </div>
              </button>
              <DoneCheck done={c.status.state === "closed"} onToggle={() => toggleDone(c)} />
            </div>
          ))}
      </div>
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
  draftId,
  uncommitted,
  adoptRunId,
  onStarted,
  onChanged,
}: {
  projectId: string | null
  openSessionId: string | null
  /**
   * The open chat's draft id, when it has not started and so has no session.
   *
   * It names which box on screen belongs to it. A project may hold any number of
   * unstarted chats, and without this they would all share one.
   */
  draftId: string | null
  /**
   * How many files are uncommitted in the project, in the scope a commit would
   * take. Passed down rather than polled here: the git rail already asks on the
   * app's beat, and two pollers would let the box and the rail disagree about
   * whether a new chat is allowed.
   */
  uncommitted: number
  /**
   * A run started somewhere else that belongs on this transcript.
   *
   * The commit is the only one: it is pressed in the git rail, which is beside
   * this pane rather than inside it, and it is this conversation's work being
   * committed — so it streams here, where the work it is describing already is.
   */
  adoptRunId?: string | null
  /** A new chat learns its session id mid-turn; the URL needs to know. */
  onStarted?: (sessionId: string) => void
  /** Something happened that the list is showing a stale copy of. */
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

  // A run handed to us from outside. Unconditional, unlike the adoption below:
  // it has to win over the id of a turn that has already finished, which is
  // exactly the state the pane is in when you press commit.
  useEffect(() => {
    if (adoptRunId) setRunId(adoptRunId)
  }, [adoptRunId])

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

  /**
   * The commit run's model, while it is still writing the message.
   *
   * A commit is the one run that streams text without being a chat turn: it has
   * `commit.step` and never an assistant message, so what is arriving is the
   * commit message and it belongs in the box the finished one lands in. Null
   * once `commit.drafted` has landed, because that box is now the real one.
   */
  const draftingCommit = useMemo<string | null>(() => {
    if (!runId) return null
    const mine = turnEvents.filter((e) => e.runId === runId)
    if (!mine.some((e) => e.type === "commit.step")) return null
    if (mine.some((e) => e.type === "commit.drafted")) return null
    const started = mine.find((e) => e.type === "run.started")
    return started?.type === "run.started" ? started.model : ""
  }, [turnEvents, runId])

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
                  {draft.text &&
                    (draftingCommit !== null ? (
                      <CommitMessageDraft text={draft.text} model={draftingCommit} />
                    ) : (
                      <div className="px-1">
                        <Markdown text={draft.text} />
                      </div>
                    ))}
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

      {projectId && (
        <Composer
          busy={busy}
          usage={usage}
          sessionId={sessionId}
          // The open chat's box, whether it has a session yet or not: an
          // unstarted one is addressed by its draft id, and losing that would
          // hand every unstarted chat the same box.
          draftKey={draftKey(projectId, sessionId ?? draftId ?? "")}
          inheritedMode={summary?.lastMode ?? null}
          // Only a conversation that has not started is held back, and only by
          // uncommitted work. The way out of the block is to finish the chat
          // that caused it, so a follow-up is never refused — and neither is a
          // first turn already in flight, which for its first few seconds has no
          // session id yet while its own edits pile up in the tree.
          blocked={
            sessionId || busy || uncommitted === 0
              ? null
              : `${uncommitted} uncommitted file${uncommitted === 1 ? "" : "s"} in this project. Open the chat that made them and press commit in the rail on the right.`
          }
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
