import { useCallback, useEffect, useMemo, useRef, useState } from "react"
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
  saveDraft,
  useUnstartedChats,
  type Draft,
} from "../drafts.js"
import { ReceiptOverlay } from "../Receipt.js"
import { WorkingBar } from "../Working.js"
import { Button, Empty, PaneHeader } from "../ui.js"
import { useRunStream } from "../useRunStream.js"
import { useAutoGrow } from "../useAutoGrow.js"
import { CommitMessageDraft, Transcript, type LiveText } from "./Transcript.js"

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

/** Token counts, short enough for a tooltip: 940, 12.4k, 3.20M. */
const compact = (n: number): string =>
  n < 1000
    ? String(n)
    : n < 1_000_000
      ? `${(n / 1000).toFixed(1)}k`
      : `${(n / 1_000_000).toFixed(2)}M`

/** Coarse on purpose: a row is read at a glance, and 4m 12s is two facts. */
function dur(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`
}

/**
 * Two decimals, and a floor rather than `$0.00`.
 *
 * Rounding a real spend down to nothing reads as "this was free", which is the
 * one thing a cost figure must never say — the same reason the whole line is
 * captioned as an estimate.
 */
const money = (usd: number) => (usd > 0 && usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`)

/** A share of everything aide has spent, as a percentage that never reads as zero. */
function share(fraction: number): string {
  const pct = fraction * 100
  if (pct > 0 && pct < 0.1) return "<0.1%"
  return `${pct.toFixed(pct < 10 ? 1 : 0)}%`
}

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
 * sit in the list forever.
 */
function UnstartedRow({
  draft,
  selected,
  blocked,
  onOpen,
  onStart,
  onDiscard,
}: {
  draft: Draft
  selected: boolean
  /** Why this cannot be started right now, or null. */
  blocked: string | null
  onOpen: () => void
  /** Open it AND send it, in one press. See the ▶ below. */
  onStart: () => void
  onDiscard: () => void
}) {
  const preview = draft.text.trim().split("\n", 1)[0] ?? ""
  const written = draft.text.trim() !== "" || draft.attachments.length > 0
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
      {/*
        Start it, in one press.

        This is the slot the ✓ sits in on a chat that has run, and it asks the
        opposite question: a parked chat has nothing to tick off, it has
        something to begin. Starting one used to cost two presses and a hunt for
        the box — open the row, scroll to the composer, send — which is two too
        many for the one thing a backlog is for.

        Last in the row, so it takes the column a started chat puts its ✓ in —
        the two are the same slot asked at two ages. And always drawn rather than
        appearing on hover, unlike the ✕ beside it: starting the next piece of
        work is what you came to the list to do, and discarding one is not.

        Nothing to start on an empty row, so nothing is drawn there — a ▶ that
        would do nothing is worse than a gap.
      */}
      {written && (
        <button
          type="button"
          onClick={onStart}
          disabled={blocked !== null}
          title={blocked ?? "Start this chat — opens it and sends it"}
          className={`shrink-0 rounded-sm border px-1 text-[10px] leading-4 ${
            blocked
              ? "cursor-not-allowed border-line text-fg-dim opacity-40"
              : "border-line text-fg-dim hover:border-ok hover:text-ok"
          }`}
        >
          ▶
        </button>
      )}
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
 *
 * It parks and stays out of the way: the chat it makes is not opened, and the
 * pane you were reading does not move. Capturing an idea is the one thing you
 * do while something else is in front of you, and a box that took over the pane
 * left your idea sitting in a composer, one Enter away from being sent at a
 * conversation it had nothing to do with. The row in the list is the whole of
 * what this does — and the ▶ on that row is what starts it, without ever opening
 * the box.
 */
function CaptureBox({ projectId }: { projectId: string }) {
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
    addBacklogChat(projectId, { text: text.trim(), attachments })
    // The box keeps the focus it already has, so a second idea is a second
    // Enter rather than a click back up here.
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
 * The line between what still wants something from you and what does not.
 *
 * Drawn only when there is something on both sides of it. With one side empty a
 * heading is not telling two groups apart, it is a label on the only list there
 * is — and a 320px column has no room for a word that says nothing.
 */
function GroupLabel({ label, count, ruled }: { label: string; count: number; ruled?: boolean }) {
  return (
    <div
      className={`flex items-baseline gap-1.5 px-3 pt-2 pb-1 font-sans text-[10px] font-semibold tracking-wide text-fg-dim uppercase ${
        ruled ? "mt-1 border-t border-line" : ""
      }`}
    >
      <span>{label}</span>
      <span className="font-normal normal-case tracking-normal tabular-nums">{count}</span>
    </div>
  )
}

/**
 * One conversation, as a row.
 *
 * Two lines: what it was about, and what it took. Nothing else fits in 320px
 * without becoming a wall, so what went was the part that never varied — every
 * row said "chat" on the left, and every row said "main" underneath, and neither
 * of them told you anything you did not already know from the list you were
 * looking at. The kind is printed only when it is NOT a chat, which is the case
 * that is genuinely surprising: an old task run in a worktree that no longer
 * exists.
 *
 * The branch and the directory moved into the row's hover title rather than
 * being deleted, because they are still the only place a conversation from
 * before the worktrees went says so.
 */
function ChatRow({
  chat,
  selected,
  onOpen,
  onToggleDone,
}: {
  chat: ConversationRow
  selected: boolean
  onOpen: () => void
  onToggleDone: () => void
}) {
  const closed = chat.status.state === "closed"
  const spend = chat.spend
  // Dim enough to stay behind the title, but not on the row you have selected:
  // fg-dim on the selection blue is the one place it stops being readable.
  const meta = selected ? "text-white/70" : "text-fg-dim"
  return (
    <div
      className={`group flex w-full items-start gap-2 px-3 py-1.5 font-sans ${
        selected ? "bg-active text-white" : "text-fg-muted hover:bg-hover"
      }`}
    >
      <button
        type="button"
        onClick={onOpen}
        title={chat.gitBranch ? `${chat.cwd} · ${chat.gitBranch}` : chat.cwd}
        className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
      >
        <div className="flex items-baseline gap-2">
          {chat.kind !== "chat" && (
            <span className={`shrink-0 text-[10px] ${kindColor(chat)}`}>{kindLabel(chat)}</span>
          )}
          <span
            className={`flex-1 truncate text-[13px] ${
              closed ? "line-through decoration-1 opacity-60" : ""
            }`}
          >
            {chat.title}
          </span>
          <StatusBadge status={chat.status} />
        </div>
        {/* Tabular figures, so the money column does not shuffle sideways as you
            read down a list of costs that differ only in the cents. */}
        <div className={`flex items-baseline gap-1.5 text-[10px] tabular-nums ${meta}`}>
          <span>{ago(chat.lastModified)}</span>
          {spend && spend.activeMs > 0 && (
            <>
              <Dot />
              <span title={WORKING_TIME(spend.turns)}>{dur(spend.activeMs)}</span>
            </>
          )}
          {spend && spend.costUsd > 0 && (
            <>
              <Dot />
              <span title={COST_IS_AN_ESTIMATE}>{money(spend.costUsd)}</span>
            </>
          )}
          {spend && spend.usageShare > 0 && (
            <>
              <Dot />
              <span title={USAGE_SHARE(spend.tokens)}>{share(spend.usageShare)}</span>
            </>
          )}
        </div>
      </button>
      <DoneCheck done={closed} onToggle={onToggleDone} />
    </div>
  )
}

/** Dimmer than what it separates, or the eye reads the list as dots. */
const Dot = () => <span className="text-line-soft">·</span>

/**
 * What the three figures mean, on hover.
 *
 * Out here because each of them is a sentence with a caveat in it, and a caveat
 * is the one thing a two-line row has no space for. The cost one is not
 * optional: the brief says anything that shows a cost figure has to say what
 * kind of number it is.
 */
const WORKING_TIME = (turns: number) =>
  `Time the turns were actually running, over ${turns} turn${turns === 1 ? "" : "s"} — not the hours you were somewhere else.`

const COST_IS_AN_ESTIMATE =
  "An estimate, from a price table bundled into the SDK at build time. Fine for a list, never for billing."

const USAGE_SHARE = (tokens: number) =>
  `${compact(tokens)} tokens, as a share of every token aide has spent on this machine. Not your plan's usage — that window counts every client at once.`

/**
 * How a parked chat looks to the ordering the started ones use.
 *
 * It has no status and no session, but it has a date, and a date is all the
 * order needs — so it sorts AMONG the conversations rather than in a block above
 * them. Two ideas parked either side of a chat you actually had keep the order
 * you had them in, which is the whole point of ordering by when a thing came to
 * exist.
 *
 * One object for every parked row, because none of them differ.
 */
const PARKED: ChatStatus = { state: null, blocked: false, done: false }

/**
 * A row in the list, whichever kind it is.
 *
 * Flattened to the three fields `sortChats` reads, so both kinds go through one
 * ordering. Two sorts stitched together was the alternative, and it can only
 * ever produce a list whose two halves disagree about what "first" means.
 */
type ListRow = { status: ChatStatus; createdAt: number | null; lastModified: number } & (
  | { kind: "draft"; draft: Draft }
  | { kind: "chat"; chat: ConversationRow }
)

/**
 * The list of a project's conversations, and the only list there is.
 *
 * Three kinds of row, in one column, because they are all the same thing at
 * different ages: a chat you have written and not sent, a chat that is running,
 * and a chat that is over. A separate backlog was the second copy of the first
 * of those.
 *
 * In two groups, though, and the split is the one that matters: what still wants
 * something from you, and what is archived. A chat you have ticked off is a
 * record — worth keeping, worth reading, and not worth scrolling past to reach
 * the thing you were going to do next.
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
  reloadSeq,
  startBlocked,
  onSelect,
  onSelectDraft,
  onStartDraft,
  onChanged,
}: {
  projectId: string | null
  selected: string | null
  /** The unstarted chat that is open, when the open one is not a session. */
  selectedDraft: string | null
  /** Bumped by the app to ask for a refetch — see App.tsx for why it is not a key. */
  reloadSeq: number
  /**
   * Why a parked chat cannot be started right now, or null. Computed by the app,
   * which is the only place that knows both what is uncommitted and who holds
   * the checkout — and the ▶ has to be dark BEFORE it is pressed, because the
   * send it would fail at clears the box it was sending.
   */
  startBlocked: string | null
  onSelect: (sessionId: string) => void
  onSelectDraft: (draftId: string) => void
  /** Open a parked chat and send it, from its ▶. */
  onStartDraft: (draftId: string) => void
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
  /** Which project `items` belongs to, so a refetch can tell itself from a switch. */
  const shown = useRef<string | null>(null)

  useEffect(() => {
    // Blank the list only when the project changed. Blanking on every refetch
    // swaps the rows for "Reading the session store…" and back, which collapses
    // the scroller to nothing and loses your place in a long list — the tick you
    // just clicked would scroll you to the top.
    if (shown.current !== projectId) {
      shown.current = projectId
      setItems(null)
    }
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
  }, [projectId, reloadSeq])

  const toggleDone = (row: ConversationRow) => {
    if (!projectId) return
    const closing = row.status.state !== "closed"
    // Move the row now rather than when the daemon answers. A round trip is long
    // enough that ticking off three chats in a row means clicking, waiting,
    // finding where the list has settled, clicking again. `onChanged` refetches
    // and overwrites this with the truth a moment later.
    setItems(
      (prev) =>
        prev?.map((c) =>
          c.sessionId === row.sessionId
            ? {
                ...c,
                status: {
                  ...c.status,
                  // Working outranks done, the same rule chatStatuses applies —
                  // guess it the daemon's way or the row jumps twice, once to
                  // where the tick put it and once to where the refetch does.
                  state:
                    c.status.state === "working"
                      ? ("working" as const)
                      : closing
                        ? ("closed" as const)
                        : null,
                  done: closing,
                },
              }
            : c,
        ) ?? null,
    )
    const call = closing
      ? api.closeChat(projectId, row.sessionId)
      : api.reopenChat(projectId, row.sessionId)
    void call
      .then(() => onChanged())
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err))
        onChanged()
      })
  }

  /**
   * Every row this project has, in one order.
   *
   * Memoized because `sortChats` copies, and this list is re-rendered on the
   * app's poll: a fresh array every 1.5 seconds is a fresh identity for every
   * row's props, which is enough to make a 200-chat list stutter while you
   * scroll it.
   */
  const rows = useMemo<ListRow[]>(
    () =>
      sortChats([
        ...unstarted.map(
          (d): ListRow => ({
            kind: "draft",
            draft: d,
            status: PARKED,
            createdAt: d.createdAt,
            // Only ever the fallback, and a parked chat always has a createdAt.
            lastModified: d.updatedAt,
          }),
        ),
        ...(items ?? []).map(
          (c): ListRow => ({
            kind: "chat",
            chat: c,
            status: c.status,
            createdAt: c.createdAt,
            lastModified: c.lastModified,
          }),
        ),
      ]),
    [unstarted, items],
  )

  /**
   * The two groups, split on the tick — the one thing in this list a human sets
   * and an agent cannot. "Open" is the daemon's own word for it: untick a chat
   * and the route is called `reopen`. So archiving is the gesture it always was,
   * and the row leaving the way clear is what the tick now buys you.
   */
  const stillOpen = rows.filter((r) => r.status.state !== "closed")
  const archived = rows.filter((r) => r.status.state === "closed")
  /** A heading earns its line only when there is something on both sides of it. */
  const split = stillOpen.length > 0 && archived.length > 0

  const render = (row: ListRow) =>
    row.kind === "draft" ? (
      <UnstartedRow
        key={row.draft.key}
        draft={row.draft}
        selected={selectedDraft === idFromKey(row.draft.key)}
        blocked={startBlocked}
        onOpen={() => onSelectDraft(idFromKey(row.draft.key))}
        onStart={() => onStartDraft(idFromKey(row.draft.key))}
        onDiscard={() => discardDraft(row.draft.key)}
      />
    ) : (
      <ChatRow
        key={row.chat.sessionId}
        chat={row.chat}
        selected={row.chat.sessionId === selected}
        onOpen={() => onSelect(row.chat.sessionId)}
        onToggleDone={() => toggleDone(row.chat)}
      />
    )

  if (!projectId) return <Empty>Select a project.</Empty>

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <CaptureBox projectId={projectId} />
      {error && (
        <p className="border-b border-line px-3 py-1.5 font-sans text-[11px] text-err">{error}</p>
      )}
      <div className="flex-1 overflow-auto py-1">
        {items === null && rows.length === 0 && <Empty>Reading the session store…</Empty>}
        {items !== null && rows.length === 0 && (
          <Empty>
            Nothing here yet. Type what you want above, or press new. Chats from Claude Code and
            the VS Code extension appear here too.
          </Empty>
        )}
        {split && <GroupLabel label="open" count={stillOpen.length} />}
        {stillOpen.map(render)}
        {split && <GroupLabel label="archived" count={archived.length} ruled />}
        {archived.map(render)}
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
  autoSend,
  onAutoSent,
  onVerifyRefused,
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
   * How many files are uncommitted in the project, which is exactly the scope a
   * commit takes. Passed down rather than polled here: the git rail already asks
   * on the app's beat, and two pollers would let the box and the rail disagree
   * about whether a new chat is allowed.
   */
  uncommitted: number
  /**
   * A run started somewhere else that belongs on this transcript.
   *
   * The commit is the only one: it is pressed in the git rail, which is beside
   * this pane rather than inside it, so it streams here — the only pane wide
   * enough to read a commit message being written and a failed check's output.
   *
   * It arrives whatever is open, including an unstarted chat and nothing at all,
   * because a commit no longer needs a conversation. That is not a mismatch: the
   * pane is where runs are watched, and this is a run.
   */
  adoptRunId?: string | null
  /**
   * This chat was opened by a ▶ rather than by a click, so send it.
   *
   * Passed straight through to the composer, which is where the mode and the
   * effort a turn goes out under are remembered.
   */
  autoSend: boolean
  /** The ▶ has been acted on, whether or not the box could send. */
  onAutoSent: () => void
  /**
   * The commit run in this pane refused because a check failed, or stopped
   * doing so. Lifted because the button that can answer it lives in the rail.
   */
  onVerifyRefused?: (refused: boolean) => void
  /** A new chat learns its session id mid-turn; the URL needs to know. */
  onStarted?: (sessionId: string) => void
  /** Something happened that the list is showing a stale copy of. */
  onChanged?: () => void
}) {
  const [view, setView] = useState<ConversationView | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** The receipt is open over this conversation. */
  const [receiptOpen, setReceiptOpen] = useState(false)
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
  const { events: streamed, draft } = useRunStream(runId)

  /**
   * This run's events, and nothing else's.
   *
   * `useRunStream` empties itself in an effect keyed on the run id, so for one
   * commit after the open chat changes it is still holding the turn belonging to
   * the chat you just left. Everything below reads this as "what the open chat
   * is doing now", and unfiltered that one commit put the previous
   * conversation's turn into this chat's transcript.
   */
  const live = useMemo(() => streamed.filter((e) => e.runId === runId), [streamed, runId])

  /**
   * Which chat is on screen: a session id, or a draft id for one that has not
   * started. Both halves count. Watching the session alone, moving between two
   * chats that had never spoken was not a change at all, so the second one
   * opened holding the first one's turn.
   */
  const openKey = openSessionId ?? draftId
  const [shownKey, setShownKey] = useState<string | null>(openKey)

  /**
   * The session this pane started itself, so adopting its id from the URL is not
   * mistaken for switching conversations.
   *
   * A ref rather than state: the reset below must be able to read it without
   * taking it as a dependency, which would make the reset run again.
   */
  const startedHere = useRef<string | null>(null)

  // Switching conversations clears the pane — during this render, not in an
  // effect after it. An effect leaves one commit in which the pane is already
  // pointed at the new chat while `runId` and the stream still belong to the old
  // one, and every effect that reads both fires inside it. That commit is the
  // whole of the bug where clicking a chat you had parked in the list threw you
  // into the conversation you were last in: the adoption below saw a chat with
  // no session id, took the session id off the previous conversation's
  // `run.started`, and carried your unsent message across to it.
  if (openKey !== shownKey) {
    setShownKey(openKey)
    // Unconditionally, including across the handoff below: the overlay is about
    // one named conversation, and left open across a switch it would refetch
    // and silently redraw itself for the chat you moved to while still reading
    // as the receipt you asked for.
    setReceiptOpen(false)
    // Picking up the id of the chat you just started here is not switching — the
    // turn is streaming, and clearing `runId` unsubscribes from it mid-answer,
    // which is what left a new chat showing your message and nothing else while
    // the daemon carried on.
    if (openSessionId === null || openSessionId !== startedHere.current) {
      setView(null)
      setError(null)
      setRunId(null)
      setSent(new Map())
      setLiveSessionId(null)
      // Only that one handoff is exempt, so the exemption ends with it —
      // otherwise coming back to the chat later skips the reset too, and it
      // opens on top of whatever the chat in between left behind.
      startedHere.current = null
    }
  }

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
        // Set before navigating: the reset above reads it on the very next
        // render, and a state update would not have landed by then.
        startedHere.current = e.sessionId
        setLiveSessionId(e.sessionId)
        onStarted?.(e.sessionId)
      }
    }
  }, [live, liveSessionId, onStarted, openSessionId])

  /**
   * Everything this sitting has produced — the accumulator, plus whatever the
   * socket has delivered that the effect above has not folded in yet.
   *
   * Merged here rather than waiting for the fold, because the fold lands a
   * render late and the draft does not: the socket clears the streamed text in
   * the same batch that delivers the finished `assistant.text`, so for one
   * commit the reply existed in neither place and React tore its DOM down. That
   * cost a frame of flicker at every tool call, and it destroyed any selection
   * the reader had inside the message.
   *
   * Keyed by runId+seq, same as the accumulator, so an event present in both is
   * one entry and keeps the position it was first folded at.
   *
   * Runs are ordered by when the first of their events arrived, and events by
   * seq within their run. The obvious `a.runId === b.runId ? a.seq - b.seq : 0`
   * is not a total order — it calls every cross-run pair equal — and a sort given
   * one is not obliged to return the same arrangement when the input grows by an
   * entry. Reordering keyed rows makes React move live DOM, which collapses a
   * selection that spans what moved.
   */
  const turnEvents = useMemo(() => {
    const merged = new Map(sent)
    for (const e of live) merged.set(`${e.runId}:${e.seq}`, e)
    const runs = new Map<string, number>()
    for (const e of merged.values()) if (!runs.has(e.runId)) runs.set(e.runId, runs.size)
    return [...merged.values()].sort(
      (a, b) => runs.get(a.runId)! - runs.get(b.runId)! || a.seq - b.seq,
    )
  }, [sent, live])

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

  /**
   * A commit that stopped because the project's checks failed.
   *
   * Derived here rather than reported by the daemon as a flag, because this pane
   * is the only thing already holding the commit run's events — the rail that
   * has to offer "commit anyway" is a sibling three panes over and subscribes to
   * nothing.
   *
   * Both halves are required. A failing check on its own is a commit that was
   * forced through and landed anyway, and offering to force a commit that has
   * already happened would be offering to commit nothing.
   */
  const verifyRefused = useMemo(() => {
    if (!runId) return false
    const mine = turnEvents.filter((e) => e.runId === runId)
    return (
      mine.some((e) => e.type === "verify.result" && !e.ok) &&
      mine.some((e) => e.type === "run.error")
    )
  }, [turnEvents, runId])

  useEffect(() => {
    onVerifyRefused?.(verifyRefused)
  }, [verifyRefused, onVerifyRefused])

  /**
   * The turn on screen failed, and this is what it was asked to do.
   *
   * Null unless there is something to offer: a turn that succeeded, one still
   * running, one the human stopped on purpose, and a commit — which was a button
   * rather than a message and has no prompt to put back.
   *
   * It exists because of what the logs show happening instead. Nine turns here
   * ended in a failure carrying no reason, one of them after thirteen minutes
   * and $9.59, and what follows five of them is the same message typed again
   * from memory — twice into a fresh conversation, which pays for a new context
   * to re-learn what the failed one already knew.
   */
  const failedTurn = useMemo(() => {
    if (busy || !runId) return null
    const mine = turnEvents.filter((e) => e.runId === runId)
    if (mine.some((e) => e.type === "commit.step")) return null
    const ended = [...mine]
      .reverse()
      .find((e) => e.type === "run.finished" || e.type === "run.error")
    if (!ended) return null
    // Cancelled is deliberate. Offering to send again what somebody just pressed
    // stop on is arguing with them.
    if (ended.type === "run.finished" && ended.status !== "failed") return null
    const asked = mine.find((e) => e.type === "user.message")
    if (asked?.type !== "user.message" || !asked.text.trim()) return null
    return { text: asked.text, images: asked.images ?? [] }
  }, [busy, runId, turnEvents])

  /**
   * Put the failed message back in the box, with its screenshots.
   *
   * The box rather than straight back to the daemon: a turn that failed may need
   * a word changed, and one press that respends what just went wrong is how you
   * lose ten dollars twice. The composer reads this store directly, so writing
   * it is the whole of the wiring.
   */
  const putBack = () => {
    if (!projectId || !failedTurn) return
    saveDraft(draftKey(projectId, sessionId ?? draftId ?? ""), {
      text: failedTurn.text,
      // Rebuilt rather than carried: the log keeps what the API needs
      // (`mediaType`, `data`) and the composer additionally wants a key to
      // remove one by and a size to show. Dropping them instead would silently
      // resend a message that was half a sentence and a picture as half a
      // sentence.
      attachments: failedTurn.images.map((img, i) => ({
        id: `resend-${i}`,
        mediaType: img.mediaType,
        data: img.data,
        bytes: Math.floor((img.data.length * 3) / 4),
      })),
    })
  }

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
  const truncating = !showAll && events.length > VISIBLE_TAIL

  /**
   * The reply being typed, handed to the transcript rather than rendered after
   * it, so that the finished copy of it lands in the same element. See
   * `LiveText`. A commit run is the exception: it streams a commit message, not
   * a reply, and that has its own box below.
   */
  const typing = useMemo<LiveText | null>(
    () =>
      busy && runId && draftingCommit === null && (draft.text || draft.thinking)
        ? { runId, thinking: draft.thinking, text: draft.text }
        : null,
    [busy, runId, draftingCommit, draft.text, draft.thinking],
  )

  const scroller = useRef<HTMLDivElement>(null)
  const toBottom = useCallback(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  /**
   * The pane scrolls when you open it, and never again on its own.
   *
   * There used to be a follower: a ResizeObserver that pinned the view to the
   * bottom while a reply streamed. It is gone because reading is what this pane
   * is for, and a transcript that moves while you are dragging a cursor across
   * it cannot be read — the text goes out from under the pointer and the
   * highlight lands somewhere else. The button below is the whole of what
   * replaced it, and it only moves the pane when you ask it to.
   *
   * A turn starting counts as asking: you pressed send, or pressed commit, and
   * the thing you pressed it for is about to appear at the end.
   */
  useEffect(() => {
    toBottom()
  }, [sessionId, runId, view?.events.length, toBottom])

  /**
   * Answers whether the turn actually started.
   *
   * The composer clears the box the moment it hands the message over, which is
   * right when the turn starts and wrong when the daemon refuses it — and it
   * refuses whenever another chat has the repo. False is how the box knows to
   * put back what it was carrying.
   */
  const send = async (msg: {
    text: string
    attachments: Attachment[]
    mode: ChatMode
    autoAfterPlan: boolean
    effort: EffortLevel
  }): Promise<boolean> => {
    if (!projectId) return false
    setError(null)
    try {
      const { runId: id } = await api.chat(projectId, { sessionId, ...msg })
      setRunId(id)
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return false
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
      <PaneHeader title={title}>
        {/* Only for a conversation that has actually run. A chat with no
            session id has no event log to bill, and offering the button anyway
            would answer every press with the same empty document. */}
        {projectId && sessionId && (
          <Button
            onClick={() => setReceiptOpen(true)}
            title="What this conversation cost, and where its time went"
          >
            receipt
          </Button>
        )}
      </PaneHeader>

      {receiptOpen && projectId && sessionId && (
        <ReceiptOverlay
          projectId={projectId}
          sessionId={sessionId}
          onClose={() => setReceiptOpen(false)}
        />
      )}

      <div
        ref={scroller}
        className="relative flex-1 overflow-x-hidden overflow-y-auto px-3 py-2 font-mono text-xs leading-relaxed"
      >
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
            {(truncating || view?.truncated) && (
              <div className="mb-2 border-b border-line pb-2 text-center font-sans text-[11px] text-fg-dim">
                {view?.truncated
                  ? `showing the most recent of ${view.totalMessages} messages`
                  : "earlier lines hidden"}
                {truncating && (
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
            <Transcript
              events={events}
              onPermission={busy ? answer : undefined}
              live={typing}
              tail={showAll ? undefined : VISIBLE_TAIL}
            >
              {busy && draftingCommit !== null && draft.text ? (
                <CommitMessageDraft text={draft.text} model={draftingCommit} />
              ) : null}
            </Transcript>
          </>
        )}
        {error && <p className="mt-2 font-sans text-[11px] text-err">{error}</p>}
      </div>

      {/* The only thing that moves the pane now, and only while there is
          something arriving to move it to. */}
      {busy && (
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

      {/* Between the transcript and the box, which is the order the decision is
          made in: you read what went wrong, then you decide whether to send it
          again. */}
      {failedTurn && projectId && (
        <div className="flex shrink-0 items-center gap-2 border-t border-line bg-chrome px-3 py-1.5 font-sans text-[11px] text-fg-muted">
          <span className="min-w-0 flex-1">
            That turn did not finish. Your message is still here — put it back in the box to try
            again, or say something different.
          </span>
          <Button onClick={putBack} title="Copy that message, and anything pasted with it, back into the composer">
            put it back
          </Button>
        </div>
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
              : `${uncommitted} uncommitted file${uncommitted === 1 ? "" : "s"} in this project. Press commit in the rail on the right — it takes all of them, whether or not a chat made them.`
          }
          autoSend={autoSend}
          onAutoSent={onAutoSent}
          onSend={send}
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
