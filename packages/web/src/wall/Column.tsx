import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
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
  carryDraft,
  discardDraft,
  draftKey,
  draftSubject,
  forgetDraftRun,
  idFromKey,
  markDraftSent,
  openNewChat,
  useUnstartedChats,
  type Draft,
} from "../drafts.js"
import { CaretRight, Check, EyeSlash, GitCommit, Lock, X } from "../icons.js"
import { draftName } from "../naming.js"
import { Transcript, type LiveText } from "../panes/Transcript.js"
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
 * ## The transcript, tailed
 *
 * A column draws the panes' own transcript rather than a reduction of it. There
 * was one — a card per turn, four model-written fields over a strip of facts —
 * and it was removed because compressing a turn to a fixed handful of lines lost
 * more than the narrow column saved: you ended up reading less, from a summary
 * that could be wrong, with the thing you wanted a click away. What a column
 * gives up to width is HISTORY, not detail, so it is `tail`ed hard instead. The
 * panes are still where a long chat is read, and the header still goes there.
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
 * How often a sent-but-unnamed chat asks what it became.
 *
 * The pane's own interval, deliberately the same number: both are waiting on the
 * same two-second window between a turn starting and the SDK naming its session,
 * and two different rates would be two different answers to how long a row may
 * sit reading `not sent` after you pressed send.
 *
 * NOT gated on `onScreen` like the polls above are. A column that was scrolled
 * away from is exactly the one whose handoff got stranded — gating this would
 * switch off the repair in the only case it exists for. It is bounded by having
 * something to repair rather than by visibility: the effect does not run at all
 * unless a draft in this project is mid-handoff, which is a second or two per
 * chat you send.
 */
const HANDOFF_MS = 1500

/**
 * How long a `forget` stays armed before it gives up.
 *
 * Long enough to read the project's name on the button and mean it; short enough
 * that an armed red control is never still sitting there when you come back to
 * the page having thought about something else.
 */
const CONFIRM_MS = 4000

/**
 * How many transcript lines a column draws.
 *
 * Far shorter than the pane's 250. A column is a fifth of the width, so the same
 * events are several times the scroll, and what a column answers is "what is
 * this project doing" about the turn in front of you — not "what happened in
 * this chat last week", which is what the panes are for and what the header still
 * opens.
 */
const WALL_TAIL = 60

export function WallColumn({
  project,
  onOpen,
  onHide,
  onRemoved,
}: {
  project: ProjectView
  /** Leave the wall for the four panes, on this project and this chat. */
  onOpen: (loc: Partial<AppLocation>) => void
  /**
   * Stop drawing this column, without touching the project.
   *
   * Deliberately NOT guarded by the holder the way `onRemoved` is. Forgetting a
   * project under a live turn orphans that turn — the run keeps writing to a
   * checkout nothing on screen can name — whereas hiding is a view setting that
   * changes nothing about the run: it carries on, the daemon still owns it, and
   * unhiding shows it exactly where it got to. A lock here would be friction
   * bought for no failure.
   */
  onHide: () => void
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
  /** Bumped to refetch the chat list — a new chat has no id until it starts. */
  const [seq, setSeq] = useState(0)

  const unstarted = useUnstartedChats(project.id)
  const [open, setOpen] = useOpenChat(project.id)

  /**
   * This draft has become a real conversation.
   *
   * The unstarted record IS the chat, so it must not linger in the picker beside
   * the conversation it turned into — `carryDraft` moves anything still unsent in
   * its box across and drops the record. The column follows only when the chat
   * that started is the one it is pointing at, for the same reason the pane does:
   * healing a row further down the picker must not move what you are reading.
   */
  const adopt = useCallback(
    (fromDraftId: string | null, sessionId: string) => {
      if (fromDraftId) carryDraft(draftKey(project.id, fromDraftId), draftKey(project.id, sessionId))
      setOpen({ sessionId, draftId: null })
      setSeq((n) => n + 1)
    },
    [project.id, setOpen],
  )

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

  // The open chat's transcript, so a column with no chat selected has none.
  //
  // Going off screen does NOT blank it — only changing chat does. Blanking on
  // visibility is the obvious way to write this and it makes the scroll destroy
  // what it passes over: come back to a column and it is empty until a refetch
  // answers, so scrolling the wall left and right empties every column in turn.
  // Off screen means "stop asking", never "forget".
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
    // anything and the transcript would vanish when it finished.
    for (const e of live) {
      if (e.type === "run.started" && e.sessionId && !open.sessionId) {
        adopt(open.draftId, e.sessionId)
      }
    }
  }, [live, open.sessionId, open.draftId, adopt])

  /**
   * Chats whose first turn went out from this column and have no session id yet.
   *
   * The wall needs this MORE than the pane does, and shipped without it. A session
   * id is announced exactly once, on the live stream, a second or two into a new
   * chat's first turn — and a column only subscribes to that stream while it is on
   * screen. The wall is a horizontally scrolled page of columns, so scrolling away
   * from one you just sent from, or closing the tab, means the name arrives to
   * nobody: the record stays in the picker reading `not sent` beside the
   * conversation it became, and the box is empty because sending moved the words
   * to `sentText`. That reads as a message you lost, and the words were sitting in
   * IndexedDB the whole time with nothing on the page willing to show them.
   *
   * So the column asks the daemon, which wrote the name down.
   */
  const waiting = useMemo(() => unstarted.filter((d) => d.startedRunId), [unstarted])
  /** Runs already answered for, so two overlapping ticks hand off once. */
  const handedOff = useRef(new Set<string>())

  useEffect(() => {
    if (waiting.length === 0) return
    let cancelled = false
    const ask = () => {
      for (const draft of waiting) {
        const runId = draft.startedRunId
        if (!runId || handedOff.current.has(runId)) continue
        void api
          .runSession(runId)
          .then(({ sessionId, ended }) => {
            if (cancelled || handedOff.current.has(runId)) return
            if (sessionId) {
              handedOff.current.add(runId)
              const draftId = idFromKey(draft.key)
              // Only follow the chat this column is actually showing. Adopting a
              // row the reader is not looking at would move the column for a
              // reason nothing on screen explains — the objection the holder dot
              // answers by marking rather than switching.
              if (open.draftId === draftId) adopt(draftId, sessionId)
              else carryDraft(draft.key, draftKey(project.id, sessionId))
              setSeq((n) => n + 1)
            } else if (ended) {
              // The turn is over and never got a session, so there is no
              // conversation for this row to become and no name left to wait for.
              // It goes back to being an ordinary parked chat, with its words
              // returned to the box by `forgetDraftRun`.
              handedOff.current.add(runId)
              forgetDraftRun(draft.key)
            }
          })
          .catch(() => {
            // The daemon is down, or newer than this page. The row is unchanged
            // and the next tick asks again.
          })
      }
    }
    ask()
    const timer = setInterval(ask, HANDOFF_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [waiting, open.draftId, adopt, project.id])

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
   * The chat, oldest first, with the live turn folded in.
   *
   * The transcript on disk plus this sitting's events, exactly as the pane does
   * it — the daemon normalizes session messages into the same events a run emits,
   * so one reader draws both.
   */
  const events = useMemo(() => {
    const history = view?.events ?? []
    // Trimmed at the opening user message, NOT deduped on `runId:seq`. The two
    // sources do not share run ids: `sessions.ts` stamps everything it replays
    // out of the session store with `runId: sessionId`, while the live stream
    // carries the actual run's id — so the same turn appears under two different
    // ids, every key misses, and the turn is appended a second time. That draws
    // the turn TWICE, which is what a remote chat looked like the moment its
    // transcript had caught up: the same prompt, once from disk and once from
    // the stream.
    //
    // Matched on the text rather than assuming the last user message is the live
    // turn's: if the session file has not caught up there is no overlap to trim,
    // and cutting anyway would swallow the previous reply. The same rule
    // `Conversation.tsx` follows, for the same reason.
    const opening = turnEvents.find((e) => e.type === "user.message")
    if (opening?.type === "user.message") {
      const at = history.findLastIndex(
        (e) => e.type === "user.message" && e.text === opening.text,
      )
      if (at !== -1) return [...history.slice(0, at), ...turnEvents]
    }
    return [...history, ...turnEvents]
  }, [view, turnEvents])

  /**
   * The reply arriving right now.
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
   * Throw away an unsent chat.
   *
   * `discardDraft` alone is not enough, and the missing half is what the column
   * is POINTING at. The picker's store and the column's selection are two
   * different things — `useOpenChat` keeps a `draftId` that survives the record
   * going away — so discarding the row currently shown leaves the column aimed
   * at an id nothing answers to: the header falls back to "New chat", the
   * composer writes into a key with no record, and a send would start a chat
   * from a row the list no longer draws. So the selection moves off first, and
   * only then is the record dropped.
   *
   * It clears rather than picking a neighbour. Which chat to show next is a
   * choice the human just made by deleting one, and jumping the column onto some
   * other project's work would be the wall re-targeting itself — the same
   * objection the holder dot answers by MARKING rather than switching.
   */
  const discard = (key: string) => {
    if (open.draftId && draftKey(project.id, open.draftId) === key) {
      setOpen({ sessionId: null, draftId: null })
    }
    discardDraft(key)
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

  /**
   * What this column's draft has already sent, if the reply has not arrived.
   *
   * `sentText` only, never the box: what is still in `text` is drawn by the
   * composer, and showing it up here as well would be the same words twice with
   * one copy editable and one not.
   */
  const openDraft = unstarted.find((d) => open.draftId && d.key === draftKey(project.id, open.draftId))
  const pendingSubject = openDraft?.sentText?.trim() ?? ""

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
          // The way out, for the questions a column cannot answer: the files,
          // the history, the whole of a long transcript.
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
        {/* Take this column off the wall. One press and no confirmation: it
            changes nothing, the count in the wall's header names it immediately,
            and one press there brings it back. Arming this the way `forget` is
            armed would charge the price of a destructive act for a reversible
            one — and the two sit next to each other, so the difference in
            friction is itself what says they are different kinds of thing. */}
        <button
          type="button"
          onClick={onHide}
          title={`Hide ${project.name} from the wall. Nothing stops; any turn keeps running.`}
          className="shrink-0 rounded-sm p-1 text-fg-dim hover:bg-hover hover:text-fg"
        >
          <EyeSlash className="size-3" />
        </button>
        {/* Forget this project. Two presses, and the second one says what it
            does rather than asking a question — see `RemoveProject`. */}
        <RemoveProject
          name={project.name}
          blocked={holder ? heldBy(holder.title) : null}
          onRemove={forget}
        />
      </header>

      {/* Which chat this column is about. A dropdown rather than a list, because
          the column's height belongs to the chat. */}
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
            onDiscard={discard}
            onClose={() => setPicking(false)}
          />
        )}
      </div>

      {/* The chat itself. Newest at the BOTTOM, like a conversation — the column
          is a thing you talk into, and a box at the foot with the newest turn
          far away at the top reads as two unrelated halves. */}
      <div ref={body} className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {events.length === 0 ? (
          /*
           * An empty chat is not always an empty box, and conflating the two is
           * how a message goes missing. A draft that has been sent has had its
           * words moved out of `text` into `sentText` by the press itself, so
           * every surface reading `text` — this pane and the composer both —
           * showed nothing at all for a chat whose first turn was in flight or
           * whose handoff had stranded. The words were in IndexedDB the entire
           * time with nothing on the page willing to draw them, which is
           * indistinguishable from having lost them.
           *
           * So what was said is shown here whenever the record still holds it,
           * whether or not a turn is still running. The handoff above is what
           * normally retires this within a second or two; this is what makes the
           * seconds before that, and the case where it never lands, honest.
           */
          pendingSubject ? (
            <div className="px-2 py-4">
              <p className="mb-1.5 font-sans text-[10px] text-fg-dim">
                {busy ? "Sent, waiting for a reply…" : "Sent. No reply recorded yet."}
              </p>
              <p className="rounded border border-line bg-chrome px-2.5 py-2 font-sans text-[12px] leading-relaxed whitespace-pre-wrap text-fg-muted">
                {pendingSubject}
              </p>
            </div>
          ) : (
            <p className="px-2 py-6 text-center font-sans text-[11px] leading-relaxed text-fg-dim">
              {open.sessionId || open.draftId
                ? "Nothing yet. Say something below."
                : "No chat open. Pick one above, or press new."}
            </p>
          )
        ) : (
          // The panes' own transcript, deliberately not a narrower copy of it: a
          // second reader would drift, and the drift would show up as the wall
          // and the conversation disagreeing about one turn. It is `tail`ed
          // harder here than in the pane — a column is a fifth of the width, so
          // the same event count is several times the scroll, and what a column
          // is for is the last turn or two rather than the whole history.
          // Reading further back is what the panes are for, and the header still
          // goes there.
          <Transcript events={events} live={liveText} tail={WALL_TAIL} scroller={body} />
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
  // `key` as well as `id`, because discarding one addresses the STORE and the
  // store is keyed by `<projectId>:<id>`. Carried on the row rather than rebuilt
  // at the ✕ from a project id the picker would otherwise have no reason to
  // know: `draftKey(project.id, row.id)` is the same string right up until
  // something changes how a key is spelled, and then it is a discard that
  // silently removes nothing.
  | { kind: "draft"; id: string; key: string; title: string; starting: boolean }

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
    key: d.key,
    // The list's own rule, not a second one: the name if it still describes what
    // is in the box, and the first line otherwise. `draftSubject` rather than the
    // box itself, so the press that sends does not blank the row it came from.
    title: draftName(d) ?? draftSubject(d).trim().split("\n", 1)[0] ?? "New chat",
    // Sent, and a second or two from becoming a conversation. The row must not
    // say `not sent` about a turn that has plainly gone out — see the label.
    starting: d.startedRunId !== undefined,
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
  onDiscard,
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
  /** Throw away an unsent chat, addressed by its store key. */
  onDiscard: (key: string) => void
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
        // A `div` with the label as its own button, NOT one button around the
        // whole row: the ✕ is a second control and a button inside a button is
        // invalid markup that browsers resolve by dropping the inner one, so the
        // discard would be unclickable rather than visibly broken.
        <div
          key={`${row.kind}:${row.id}`}
          className={`group flex w-full items-center gap-2 pr-1 pl-3 ${
            row.id === selected ? "bg-active text-white" : "hover:bg-hover"
          }`}
        >
          <button
            type="button"
            onClick={() =>
              onPick(
                row.kind === "chat"
                  ? { sessionId: row.id, draftId: null }
                  : { sessionId: null, draftId: row.id },
              )
            }
            className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
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
            {/* `starting`, not a flat `not sent`. A chat whose first turn is in
                flight has obviously been sent, and labelling it unsent is the
                lie that made a stranded handoff read as a lost message: the row
                said `not sent` about a turn that had already run and cost money,
                so there was nothing on screen suggesting the words still
                existed. It says so until the handoff lands and this row becomes
                the conversation. */}
            {row.kind === "draft" && (
              <span className="shrink-0 font-sans text-[10px] text-fg-dim">
                {row.starting ? "starting…" : "not sent"}
              </span>
            )}
            {row.kind === "chat" && row.done && <Check className="size-3 shrink-0 text-ok" />}
          </button>
          {/*
            Discard an unsent chat. ONLY an unsent one, and that asymmetry is the
            design rather than an omission.

            A draft is held in this browser and has never happened — nothing was
            spent on it, nothing on disk records it, and `discardDraft` is a local
            delete. A started conversation is the opposite: its transcript is the
            SDK's own file, shared with the Claude CLI and the VS Code extension,
            so a ✕ here would delete a record aide does not own out of two other
            tools as well. The list's own tick is what closes a real chat, and the
            brief's second gate is a verdict rather than a deletion.

            Hover-only, like the same control in `Conversations.tsx`: tidying the
            list is not what the picker was opened to do. A 24px target rather
            than the 12px glyph, for the reason written down there — the pixels
            around a bare ✕ were a miss that discarded nothing.
          */}
          {row.kind === "draft" && (
            <button
              type="button"
              onClick={() => onDiscard(row.key)}
              title="Discard this unsent chat"
              className="flex size-6 shrink-0 items-center justify-center rounded-sm text-fg-dim opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-err"
            >
              <X className="size-3" />
            </button>
          )}
          {/* The started rows keep the ✕'s width, or the titles above and below
              a draft would sit at a different right edge and the list would look
              ragged as you hovered down it. */}
          {row.kind === "chat" && <span className="size-6 shrink-0" />}
        </div>
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
