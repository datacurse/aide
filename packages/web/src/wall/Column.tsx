import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  cardsForConversation,
  projectGates,
  sortChats,
  type Attachment,
  type ChatMode,
  type EffortLevel,
  type RunEvent,
} from "@aide/protocol"
import { api, type ConversationRow, type ConversationView, type GitPending, type ProjectView } from "../api.js"
import { Composer } from "../Composer.js"
import {
  draftKey,
  draftSubject,
  markDraftSent,
  openNewChat,
  useUnstartedChats,
  type Draft,
} from "../drafts.js"
import { CaretRight, Check, GitCommit, Lock, X } from "../icons.js"
import { draftName } from "../naming.js"
import { Transcript, type LiveText } from "../panes/Transcript.js"
import { TurnCardRow } from "../TurnCard.js"
import { Button, heldBy, LOCKED } from "../ui.js"
import { readOpenChat, rememberProjectChat, watchOpenChats, type AppLocation } from "../useAppLocation.js"
import { useOnScreen } from "../useOnScreen.js"
import { usePoll } from "../usePoll.js"
import { useRunStream } from "../useRunStream.js"

/**
 * One project, as a column of the wall.
 *
 * ## What a column is, and what it deliberately is not
 *
 * It is the ONE chat a project is currently about, plus everything you need to
 * steer it: what the last few turns did, what it is doing now, a box to say the
 * next thing, and the project's own commit gate. It is not a narrow copy of the
 * four panes — there is no file tree, no history, no git graph. Those answer
 * "where am I", which is a question you ask inside one project; the wall answers
 * "what is everything doing", which is the question none of the panes can.
 *
 * ## Cards, not the transcript, and that is the load-bearing choice
 *
 * At this width a transcript is unreadable — markdown, tool rows and code fences
 * all reflowing into a gutter. A card is already the fixed set of facts a turn
 * reduces to, already designed to be scanned, and already has its own surface.
 * `reduceCard` is what makes this page possible at all. Reading a turn in full
 * means clicking through to the panes, which is the escape hatch: the wall
 * steers, the panes read.
 *
 * ## Why the picker writes the shared store
 *
 * `rememberProjectChat` is the same per-project memory `useAppLocation` keeps for
 * the four panes. Pick a chat here, click into the panes, and you are in it. A
 * store of the wall's own would let the two views disagree about what a project
 * is currently about, which is the two-readings-of-one-thing failure this
 * codebase has written down more than once.
 */

/** The app's own beat. A column only pays it while it is on screen. */
const POLL_MS = 1500

/**
 * How long a `forget` stays armed before it gives up.
 *
 * Long enough to read the project's name on the button and mean it; short enough
 * that an armed red control is never still sitting there when you come back to
 * the page having thought about something else.
 */
const CONFIRM_MS = 4000

/**
 * How many transcript lines a flipped column draws.
 *
 * Far shorter than the pane's 250. A column is a fifth of the width, so the same
 * events are several times the scroll, and the flip answers "was that card
 * enough" about the turn you were just looking at — not "what happened in this
 * chat last week", which is what the panes are for and what the header still
 * opens.
 */
const WALL_TAIL = 60

export function WallColumn({
  project,
  now,
  onOpen,
  onRemoved,
}: {
  project: ProjectView
  /**
   * The clock the ages are measured against, ticked by the wall rather than by
   * each column — the same reason `TurnCardRow` takes it rather than reading it:
   * a page of columns each running their own timer redraws at N times the rate
   * for one shared answer, and the ages drift apart between them.
   */
  now: number
  /** Leave the wall for the four panes, on this project and this chat. */
  onOpen: (loc: Partial<AppLocation>) => void
  /** This project was forgotten, so the wall should stop drawing it. */
  onRemoved: () => void
}) {
  const box = useRef<HTMLElement>(null)
  /**
   * The scrolling half of the column, which the transcript needs to measure the
   * pinned question against. The section itself does not scroll — the composer
   * and the commit foot are fixed to it — so this is a second ref rather than a
   * reuse of `box`.
   */
  const body = useRef<HTMLDivElement>(null)
  /**
   * Only a visible column polls. Not a nicety — it is what stops the request rate
   * being a function of how many projects you happen to have added. See
   * `useOnScreen`, which holds the measurements and the failure it prevents.
   */
  const onScreen = useOnScreen(box)

  const [pending, setPending] = useState<GitPending | null>(null)
  const [chats, setChats] = useState<ConversationRow[] | null>(null)
  const [view, setView] = useState<ConversationView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [runId, setRunId] = useState<string | null>(null)
  const [sent, setSent] = useState<Map<string, RunEvent>>(new Map())
  const [picking, setPicking] = useState(false)
  const [committing, setCommitting] = useState(false)
  /**
   * This column is showing the transcript rather than the cards.
   *
   * Per COLUMN, and deliberately not shared with the panes' own toggle or
   * remembered anywhere. Flipping one column to read a turn in full is a thing
   * you do for a few seconds and undo; making it a preference would mean opening
   * the wall tomorrow to five transcripts, which is the view the cards exist to
   * replace. It is not in the URL either — the wall's location is which project
   * and which chat, and a reload landing back on the scan is the right default.
   */
  const [full, setFull] = useState(false)
  /** Bumped to refetch the chat list — a new chat has no id until it starts. */
  const [seq, setSeq] = useState(0)

  const unstarted = useUnstartedChats(project.id)
  const [open, setOpen] = useOpenChat(project.id)

  const holder = project.holder
  const uncommitted = pending?.files.length ?? 0

  // Only the tree is on the beat. The chat list is fetched on arrival and when
  // something happened — the same rule the four panes follow, and for the same
  // reason: answering it reads the SDK's session store and every run log, which
  // is not a thing to do twice a second per project.
  usePoll(
    async () => {
      try {
        setPending(await api.gitPending(project.id))
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    POLL_MS,
    [project.id],
    onScreen,
  )

  useEffect(() => {
    if (!onScreen) return
    let cancelled = false
    void api
      .conversations(project.id)
      .then((rows) => {
        if (!cancelled) setChats(rows)
      })
      .catch(() => {
        // The tree's own error is the one worth showing — it is what decides
        // whether this column may start anything. A chat list that failed leaves
        // the picker empty, which says the same thing more quietly.
      })
    return () => {
      cancelled = true
    }
  }, [project.id, seq, onScreen])

  /**
   * A run let go of the checkout, so ask what the list says now.
   *
   * The same transition `App.tsx` watches, and for the same reason: a row's
   * figures are written by the end of a turn, and this is exactly that moment.
   */
  const heldRunId = holder?.runId ?? null
  const wasHeld = useRef<string | null>(null)
  useEffect(() => {
    const before = wasHeld.current
    wasHeld.current = heldRunId
    if (before !== null && heldRunId === null) setSeq((n) => n + 1)
  }, [heldRunId])

  // The open chat's transcript. Cards are reduced from it, so a column with no
  // chat selected simply has none.
  //
  // Going off screen does NOT blank it — only changing chat does. Blanking on
  // visibility is the obvious way to write this and it makes the scroll destroy
  // what it passes over: come back to a column and its cards are gone until a
  // refetch answers, so scrolling the wall left and right empties every column
  // in turn. Off screen means "stop asking", never "forget".
  useEffect(() => {
    if (!open.sessionId) {
      setView(null)
      return
    }
    if (!onScreen) return
    let cancelled = false
    void api
      .conversation(project.id, open.sessionId)
      .then((v) => {
        if (cancelled) return
        setView(v)
        // Adopt a turn that was already running — the column may have been
        // scrolled into view long after it started.
        if (v.summary.activeRunId) setRunId((prev) => prev ?? v.summary.activeRunId)
      })
      .catch(() => {
        if (!cancelled) setView(null)
      })
    return () => {
      cancelled = true
    }
  }, [project.id, open.sessionId, seq, onScreen])

  // Switching the chat this column shows throws away the previous one's turn.
  // During render rather than in an effect, for the reason `Conversation.tsx`
  // spells out: an effect leaves one commit in which the column points at the new
  // chat while the stream still belongs to the old one.
  //
  // Keyed on the STRING rather than on `open` itself, which matters more here
  // than it does in the pane: the pane's key comes from props and is stable,
  // this one comes from a store that rebuilds its object on every read. Compared
  // by identity, this branch would fire forever — and it assigns a fresh `Map`,
  // so "forever" is a render loop and a grey screen rather than a slow page.
  // `sameChat` in `useOpenChat` is the other half of that guard.
  const shown = open.sessionId ?? open.draftId
  const [shownKey, setShownKey] = useState<string | null>(shown)
  if (shown !== shownKey) {
    setShownKey(shown)
    setRunId(null)
    setSent(new Map())
    setError(null)
  }

  const { events: streamed, draft } = useRunStream(runId)
  const live = useMemo(() => streamed.filter((e) => e.runId === runId), [streamed, runId])

  useEffect(() => {
    if (live.length === 0) return
    setSent((prev) => {
      const next = new Map(prev)
      for (const e of live) next.set(`${e.runId}:${e.seq}`, e)
      return next
    })
    // A new chat learns its session id mid-turn. The column has to follow it, or
    // the turn it just started belongs to a draft that no longer stands for
    // anything and the cards would vanish when it finished.
    for (const e of live) {
      if (e.type === "run.started" && e.sessionId && !open.sessionId) {
        setOpen({ sessionId: e.sessionId, draftId: null })
        setSeq((n) => n + 1)
      }
    }
  }, [live, open.sessionId, setOpen])

  const turnEvents = useMemo(() => {
    const merged = new Map(sent)
    for (const e of live) merged.set(`${e.runId}:${e.seq}`, e)
    const runs = new Map<string, number>()
    for (const e of merged.values()) if (!runs.has(e.runId)) runs.set(e.runId, runs.size)
    return [...merged.values()].sort(
      (a, b) => runs.get(a.runId)! - runs.get(b.runId)! || a.seq - b.seq,
    )
  }, [sent, live])

  const finished = useMemo(
    () =>
      runId !== null &&
      turnEvents.some(
        (e) => e.runId === runId && (e.type === "run.finished" || e.type === "run.error"),
      ),
    [turnEvents, runId],
  )
  const busy = runId !== null && !finished

  /**
   * The cards, oldest first, with the live turn folded in.
   *
   * The transcript on disk plus this sitting's events, exactly as the pane does
   * it — the daemon normalizes session messages into the same events a run emits,
   * so one reducer reads both.
   */
  const cards = useMemo(() => {
    const history = view?.events ?? []
    const seen = new Set(history.map((e) => `${e.runId}:${e.seq}`))
    const extra = turnEvents.filter((e) => !seen.has(`${e.runId}:${e.seq}`))
    return cardsForConversation([...history, ...extra])
  }, [view, turnEvents])

  /**
   * The reply arriving right now, for the flipped view.
   *
   * Handed to the transcript rather than drawn after it, so the finished copy
   * lands in the same element — see `LiveText`. Raw, with no typewriter: that is
   * a reading preference the panes carry, and a column is a glance rather than a
   * sit-down. Nothing when a commit is drafting, which streams a message rather
   * than a reply.
   */
  const liveText = useMemo<LiveText | null>(
    () =>
      busy && runId && (draft.text || draft.thinking || draft.tools.length)
        ? { runId, thinking: draft.thinking, text: draft.text, tools: draft.tools }
        : null,
    [busy, runId, draft.text, draft.thinking, draft.tools],
  )

  const gates = projectGates({
    holder,
    uncommitted,
    openRunId: runId,
    started: open.sessionId !== null,
    busy,
    held: heldBy,
  })

  const send = async (msg: {
    text: string
    attachments: Attachment[]
    mode: ChatMode
    effort: EffortLevel
    thinking: boolean
  }): Promise<boolean> => {
    setError(null)
    try {
      const { runId: id } = await api.chat(project.id, { sessionId: open.sessionId, ...msg })
      setRunId(id)
      if (!open.sessionId && open.draftId) {
        markDraftSent(draftKey(project.id, open.draftId), id, msg.text)
      }
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return false
    }
  }

  /**
   * This column's own commit, on this column's own tree.
   *
   * One per column and no "commit all" anywhere on the page. Reviewing four
   * diffs is four acts; a button that collapsed them into one press would be the
   * brief's two-gates-into-one-button, which is not a simplification but the
   * removal of the review.
   */
  const commit = async (push: boolean) => {
    setCommitting(true)
    setError(null)
    try {
      const { runId: id } = await api.commitProject(project.id, open.sessionId, false, push)
      setRunId(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCommitting(false)
    }
  }

  /**
   * Forget this project — the registry entry, and nothing on disk.
   *
   * The wall is told rather than left to notice on the next poll: a column that
   * lingered for a beat after its own removal is one you can still type into,
   * and the send would land on a project the daemon no longer knows.
   */
  const forget = async () => {
    setError(null)
    try {
      await api.removeProject(project.id)
      onRemoved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const rows = useMemo(() => pickerRows(chats, unstarted), [chats, unstarted])
  const openTitle = titleOf(rows, open) ?? (open.draftId ? "New chat" : "no chat")

  return (
    <section
      ref={box}
      // A fixed width, not a fraction of the window. The whole point is that the
      // number of columns you can see is a property of your screen rather than of
      // how many projects exist — a responsive grid that fitted all of them would
      // undo both the readability and the request budget.
      className="flex h-full w-[24rem] shrink-0 flex-col border-r border-line bg-editor"
    >
      {/* Project, and whether anything has its checkout. The only project-level
          chrome there is: the wall is not a project switcher. */}
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-chrome px-3">
        <span
          className={`inline-block size-1.5 shrink-0 rounded-full ${
            holder ? "animate-pulse bg-info" : "bg-fg-dim"
          }`}
        />
        <button
          type="button"
          onClick={() => onOpen({ wall: false, projectId: project.id, ...open })}
          // Still the way out, but no longer the way to read one turn — `full`
          // does that without leaving. This is for the questions a column cannot
          // answer: the files, the history, the whole of a long transcript.
          title={`${project.root} — open the panes on this project`}
          className="min-w-0 flex-1 truncate text-left font-sans text-[12px] text-fg hover:underline"
        >
          {project.name}
        </button>
        {holder && (
          <span className="max-w-[7rem] truncate font-sans text-[10px] text-info" title={heldBy(holder.title)}>
            {holder.title}
          </span>
        )}
        {/* Forget this project. Two presses, and the second one says what it
            does rather than asking a question — see `RemoveProject`. */}
        <RemoveProject
          name={project.name}
          blocked={holder ? heldBy(holder.title) : null}
          onRemove={forget}
        />
      </header>

      {/* Which chat this column is about. A dropdown rather than a list, because
          the column's height belongs to the cards. */}
      <div className="relative flex shrink-0 items-center gap-1 border-b border-line bg-chrome px-2 py-1">
        <button
          type="button"
          onClick={() => setPicking((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 py-0.5 text-left hover:bg-hover"
          title="Which chat this column is showing"
        >
          <CaretRight className="size-3 shrink-0 rotate-90 text-fg-dim" />
          <span className={`min-w-0 truncate font-sans text-[12px] ${open.sessionId || open.draftId ? "text-fg" : "text-fg-dim italic"}`}>
            {openTitle}
          </span>
        </button>
        {/* The flip. Cards are the scan and the transcript is the detail, and
            both live HERE — reading one turn in full used to mean leaving for
            the panes, which threw away the whole page to answer a question about
            one card. Offered only once there is something to read, so it is
            never a button that switches to an empty view. */}
        {cards.length > 0 && (
          <Button
            onClick={() => setFull((v) => !v)}
            title={full ? "Back to one card per turn" : "Read this chat in full, here"}
          >
            {full ? "cards" : "full"}
          </Button>
        )}
        <Button
          locked={gates.start}
          onClick={() => setOpen({ sessionId: null, draftId: openNewChat(project.id) })}
          title="An empty chat in this project"
        >
          new
        </Button>

        {picking && (
          <ChatPicker
            rows={rows}
            open={open}
            holderSessionId={holder?.sessionId ?? null}
            onPick={(next) => {
              setOpen(next)
              setPicking(false)
            }}
            onClose={() => setPicking(false)}
          />
        )}
      </div>

      {/* The two readings of one chat, in the same column. Newest at the BOTTOM
          in both, like a conversation — the column is a thing you talk into, and
          a box at the foot with the newest turn far away at the top reads as two
          unrelated halves. */}
      <div ref={body} className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {cards.length === 0 ? (
          <p className="px-2 py-6 text-center font-sans text-[11px] leading-relaxed text-fg-dim">
            {open.sessionId || open.draftId
              ? "Nothing yet. Say something below."
              : "No chat open. Pick one above, or press new."}
          </p>
        ) : full ? (
          // The panes' own transcript, not a narrower copy — same argument as the
          // card below. It is `tail`ed harder here than in the pane: a column is
          // a fifth of the width, so the same event count is several times the
          // scroll, and what the flip is for is the last turn or two rather than
          // the whole history. Reading further back is what the panes are for,
          // and the header still goes there.
          <Transcript
            events={turnEvents.length > 0 ? turnEvents : (view?.events ?? [])}
            live={liveText}
            tail={WALL_TAIL}
            scroller={body}
          />
        ) : (
          // The same component the panes draw, deliberately not a narrow copy of
          // it. A second card would drift from `reduceCard`'s contract, and the
          // drift would show up as the wall and the conversation disagreeing
          // about one turn. It has a `max-w` rather than a width, so it shrinks
          // to the column on its own.
          cards.map((card) => (
            <TurnCardRow
              key={`${card.runId}:${card.startedAt}`}
              card={card}
              now={now}
              // Flips this column rather than leaving the page. Going to the
              // panes to answer "was that card enough" spent the whole wall on
              // one turn and put you somewhere you then had to navigate back
              // from — the question is small and local, so the answer is too.
              onOpen={() => setFull(true)}
            />
          ))
        )}
      </div>

      {error && (
        <p className="shrink-0 border-t border-line px-3 py-1.5 font-sans text-[11px] break-words text-err">
          {error}
        </p>
      )}

      <Composer
        busy={busy}
        // Not drawn on a column. The meter is a per-conversation reading and this
        // is a strip a few hundred pixels wide whose every row has to earn its
        // place; the panes have it, one click away.
        usage={null}
        sessionId={open.sessionId}
        draftKey={draftKey(project.id, open.sessionId ?? open.draftId ?? "")}
        inheritedMode={view?.summary.lastMode ?? null}
        blocked={gates.send}
        autoSend={false}
        onAutoSent={() => {}}
        onSend={send}
        onInterrupt={() => {
          if (runId) void api.interruptChat(runId).catch(() => {})
        }}
      />

      <CommitFoot
        uncommitted={uncommitted}
        ahead={pending?.ahead ?? null}
        blocked={gates.commit}
        busy={committing || (runId !== null && !finished && holder?.runId === runId)}
        onCommit={commit}
      />
    </section>
  )
}

/**
 * The chat this column shows, backed by the store the four panes use.
 *
 * `useSyncExternalStore` is deliberately not used here despite the store being
 * subscribable: the column also needs to WRITE it, and a hook that only read it
 * would have to be paired with a setter that notified, which is what
 * `rememberProjectChat` already is. State plus a subscription keeps both halves
 * in one place and re-renders this column when another one writes — which cannot
 * happen today, since each column owns a different project, but would be a
 * silent staleness bug the moment anything else touched the store.
 */
function useOpenChat(
  projectId: string,
): [OpenChat, (next: OpenChat) => void] {
  const [chat, setChat] = useState<OpenChat>(() => readOpenChat(projectId))

  useEffect(() => {
    // Kept BY VALUE, not by identity. `readOpenChat` parses the store on every
    // call and so hands back a new object each time even when nothing moved —
    // and this fires on mount and again for every write any column makes. Taking
    // the new object unconditionally replaces `open` with an equal-but-distinct
    // one, which changes `shown` in the caller, which resets `sent` to a fresh
    // Map, which renders, which re-reads… a loop that paints once and then turns
    // the page grey about half a second later. Same shape as the `listCache` in
    // `drafts.ts` and for the same reason.
    const take = () => {
      const next = readOpenChat(projectId)
      setChat((prev) => (sameChat(prev, next) ? prev : next))
    }
    take()
    return watchOpenChats(take)
  }, [projectId])

  // Stable across renders, because an effect depends on it. Unmemoized this is a
  // new function every render, so the effect that adopts a new chat's session id
  // re-runs on every render — harmless by luck rather than by design, since it
  // redoes the event merge each time and its guards are the only thing between
  // that and a loop.
  const set = useCallback(
    (next: OpenChat) => {
      setChat(next)
      rememberProjectChat(projectId, next)
    },
    [projectId],
  )
  return [chat, set]
}

type OpenChat = { sessionId: string | null; draftId: string | null }

/**
 * Two readings of "which chat" that mean the same thing.
 *
 * The store hands back a fresh object on every read, so identity says nothing
 * about whether anything moved — and this column resets a Map when it thinks the
 * chat changed, which makes a false positive here an infinite render rather than
 * a wasted one.
 */
const sameChat = (a: OpenChat, b: OpenChat): boolean =>
  a.sessionId === b.sessionId && a.draftId === b.draftId

/** The row a picker draws: a real conversation, or one that has not been sent. */
type PickerRow =
  | { kind: "chat"; id: string; title: string; done: boolean }
  | { kind: "draft"; id: string; title: string }

/**
 * Everything in this project you could point the column at, most recent first.
 *
 * Unsent chats FIRST as their own group — that is the backlog, and the list is
 * ordered by urgency the way the chat list is. Ticked-off ones sink to the
 * bottom, because a column pointed at finished work is the least likely thing
 * you meant.
 */
function pickerRows(chats: ConversationRow[] | null, drafts: readonly Draft[]): PickerRow[] {
  const parked: PickerRow[] = drafts.map((d) => ({
    kind: "draft",
    id: idOf(d.key),
    // The list's own rule, not a second one: the name if it still describes what
    // is in the box, and the first line otherwise. `draftSubject` rather than the
    // box itself, so the press that sends does not blank the row it came from.
    title: draftName(d) ?? draftSubject(d).trim().split("\n", 1)[0] ?? "New chat",
  }))
  // `sortChats` rather than a second ordering — newest first, which is the one
  // the list already uses and the one the row dates would confirm.
  const started: PickerRow[] = sortChats(chats ?? []).map((c) => ({
    kind: "chat",
    id: c.sessionId,
    title: c.title,
    done: c.status.done,
  }))
  const live = started.filter((r) => r.kind === "chat" && !r.done)
  const closed = started.filter((r) => r.kind === "chat" && r.done)
  return [...parked, ...live, ...closed]
}

const idOf = (key: string): string => key.slice(key.indexOf(":") + 1)

function titleOf(
  rows: PickerRow[],
  open: { sessionId: string | null; draftId: string | null },
): string | null {
  const id = open.sessionId ?? open.draftId
  if (!id) return null
  return rows.find((r) => r.id === id)?.title ?? null
}

function ChatPicker({
  rows,
  open,
  holderSessionId,
  onPick,
  onClose,
}: {
  rows: PickerRow[]
  open: { sessionId: string | null; draftId: string | null }
  /**
   * The chat currently holding the checkout, which may not be the one shown.
   *
   * Marked rather than switched to. A column that re-targeted itself the moment a
   * turn started somewhere else would move under the reader for a reason nothing
   * on screen explains — the same objection as a list that reorders itself. One
   * click is the right cost for going to look.
   */
  holderSessionId: string | null
  onPick: (next: { sessionId: string | null; draftId: string | null }) => void
  onClose: () => void
}) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener("mousedown", away)
    return () => document.removeEventListener("mousedown", away)
  }, [onClose])

  const selected = open.sessionId ?? open.draftId

  return (
    <div
      ref={box}
      className="absolute top-8 left-2 z-30 max-h-80 w-[21rem] overflow-y-auto rounded border border-line bg-chrome py-1 shadow-lg"
    >
      {rows.length === 0 && (
        <p className="px-3 py-2 font-sans text-[11px] text-fg-dim">No chats in this project yet.</p>
      )}
      {rows.map((row) => (
        <button
          key={`${row.kind}:${row.id}`}
          type="button"
          onClick={() =>
            onPick(
              row.kind === "chat"
                ? { sessionId: row.id, draftId: null }
                : { sessionId: null, draftId: row.id },
            )
          }
          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${
            row.id === selected ? "bg-active text-white" : "hover:bg-hover"
          }`}
        >
          {/* The one that has the checkout, wherever it is in the list. */}
          {row.kind === "chat" && row.id === holderSessionId ? (
            <span className="inline-block size-1.5 shrink-0 animate-pulse rounded-full bg-info" />
          ) : row.kind === "draft" ? (
            <span className="inline-block size-1.5 shrink-0 rounded-full border border-fg-dim" />
          ) : (
            <span className="inline-block size-1.5 shrink-0" />
          )}
          <span
            className={`min-w-0 flex-1 truncate font-sans text-[12px] ${
              row.kind === "chat" && row.done ? "text-fg-dim line-through" : ""
            }`}
          >
            {row.title}
          </span>
          {row.kind === "draft" && (
            <span className="shrink-0 font-sans text-[10px] text-fg-dim">not sent</span>
          )}
          {row.kind === "chat" && row.done && <Check className="size-3 shrink-0 text-ok" />}
        </button>
      ))}
    </div>
  )
}

/**
 * The project's own gate, at the foot of its own column.
 *
 * Everything the rail's top half says, in one line: what is left to commit, the
 * button that takes it, and the checkbox that chains a push. `and push` is read
 * at the moment of the press and stored nowhere — a habit rather than a setting,
 * which is the distinction the rail already draws.
 */
function CommitFoot({
  uncommitted,
  ahead,
  blocked,
  busy,
  onCommit,
}: {
  uncommitted: number
  /** null means no upstream, which is `publish branch` rather than nothing to do. */
  ahead: number | null
  blocked: string | null
  busy: boolean
  onCommit: (push: boolean) => void
}) {
  const [push, setPush] = useState(false)
  if (uncommitted === 0) {
    return (
      <div className="flex h-8 shrink-0 items-center gap-2 border-t border-line bg-chrome px-3 font-sans text-[11px] text-fg-dim">
        <Check className="size-3 text-ok" />
        nothing to commit
        {ahead !== null && ahead > 0 && <span className="ml-auto">{ahead} to push</span>}
      </div>
    )
  }
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-t border-line bg-chrome px-3">
      <GitCommit className="size-3 shrink-0 text-fg-dim" />
      <span className="min-w-0 flex-1 truncate font-sans text-[11px] text-fg-muted">
        {uncommitted} {uncommitted === 1 ? "file" : "files"}
      </span>
      <label
        className="flex shrink-0 items-center gap-1 font-sans text-[10px] text-fg-dim"
        title="Push the branch after this commit lands"
      >
        <input
          type="checkbox"
          checked={push}
          onChange={(e) => setPush(e.target.checked)}
          className="size-3 accent-accent"
        />
        push
      </label>
      <button
        type="button"
        aria-disabled={blocked ? true : undefined}
        onClick={blocked ? undefined : () => onCommit(push)}
        disabled={blocked ? undefined : busy}
        title={blocked ?? "Read the diff in the panes; this takes the whole tree"}
        className={`inline-flex shrink-0 items-center gap-1 rounded-sm px-2 py-0.5 font-sans text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
          blocked ? LOCKED : "bg-accent text-white hover:bg-accent-hover"
        }`}
      >
        {blocked && <Lock className="size-3 shrink-0" />}
        {busy ? "committing…" : "commit"}
      </button>
    </div>
  )
}

/**
 * Forget a project, in two presses.
 *
 * ## Why it is a confirm and not a dialog
 *
 * This is the only control in aide that takes something away, and the thing it
 * takes is cheap to restore — `add` and the same path — so a modal asking you to
 * type the project's name would be charging dialog prices for a mistake that
 * costs one folder-picker. Two presses is the proportionate amount of friction:
 * enough that a stray click on a 12px glyph cannot do it, not so much that
 * removing three stale projects is a chore.
 *
 * The second press SAYS WHAT IT DOES rather than asking whether you are sure.
 * "forget aide?" is a question whose only answer is the button you already
 * pressed; "forget" beside a project's name is the act, named. It also arms only
 * this column — the state is local — so two columns cannot be armed at once and
 * the confirmation cannot be spent on the wrong one.
 *
 * It disarms on a timer as well as on the second press. An armed red button left
 * on screen while you scrolled away is a trap for the next click that lands
 * anywhere near it, and there is no cancel button because clicking elsewhere,
 * or waiting, is the cancel.
 *
 * ## What it does not do
 *
 * It says `forget`, never `delete`, because the repository, its `.aide/` and
 * every conversation in it stay exactly where they are — the daemon drops one
 * line from `registry.json`. Calling it delete would be a promise aide does not
 * keep in either direction: nothing is destroyed, and somebody reading `delete`
 * would reasonably not press it when they meant to tidy the list.
 */
function RemoveProject({
  name,
  blocked,
  onRemove,
}: {
  name: string
  /** Why this cannot be forgotten right now — a run has the checkout. */
  blocked: string | null
  onRemove: () => void
}) {
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => setArmed(false), CONFIRM_MS)
    return () => clearTimeout(timer)
  }, [armed])

  if (blocked) {
    return (
      <span className={`inline-flex shrink-0 items-center rounded-sm p-1 ${LOCKED}`} title={blocked}>
        <Lock className="size-3" />
      </span>
    )
  }

  if (armed) {
    return (
      <button
        type="button"
        onClick={onRemove}
        title={`Drop ${name} from aide's list. The repository and its files are untouched.`}
        className="shrink-0 rounded-sm bg-diff-del-fg/85 px-1.5 py-0.5 font-sans text-[10px] text-white hover:bg-diff-del-fg"
      >
        forget {name}
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={() => setArmed(true)}
      title="Remove this project from aide. Nothing on disk is deleted."
      className="shrink-0 rounded-sm p-1 text-fg-dim hover:bg-hover hover:text-err"
    >
      <X className="size-3" />
    </button>
  )
}
