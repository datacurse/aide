import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  projectGates,
  type Attachment,
  type ChatMode,
  type ChatModel,
  type ContextUsage,
  type EffortLevel,
  type RunEvent,
} from "@aide/protocol"
import { api, type ConversationView, type LockHolder } from "../api.js"
import { useDoneChime } from "../chime.js"
import { Composer } from "../Composer.js"
import { draftKey, markDraftSent, saveDraft } from "../drafts.js"
import { ArrowDown } from "../icons.js"
import { ProfileOverlay } from "../Profile.js"
import { WorkingBar } from "../Working.js"
import { Button, Empty, heldBy, PaneHeader } from "../ui.js"
import { useKeyed } from "../useKeyed.js"
import { useRemembered } from "../useRemembered.js"
import { useRunStream } from "../useRunStream.js"
import { useStickToEnd } from "../useStickToEnd.js"
import { TYPING_KEY, useTyped } from "../typing.js"
import { isCommitRun } from "../liveCommit.js"
import { Transcript, type LiveText } from "./Transcript.js"

/**
 * The open conversation.
 *
 * Split from `Conversations.tsx`, which is the LIST. The two lived in one file
 * at two thousand lines and shared nothing but their imports: they hold separate
 * state, they are addressed by different halves of the URL, and they speak to
 * each other only through props `App.tsx` passes down. What made the file worth
 * splitting is not its length but that its two halves have different failure
 * modes — a bug in the list is a row in the wrong place, a bug in here is a turn
 * streaming into the wrong transcript — and reading one while looking for the
 * other cost a scroll past eight hundred lines that could not be involved.
 *
 * The formatters stayed with the list, because that is who uses them: a row
 * prints a date, a duration, a cost and a share, and nothing in here prints any
 * of them.
 */

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
  holder,
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
   * Who has the project's checkout right now, from the app's poll.
   *
   * The one fact about other chats this pane reads live, and it has to be: the
   * daemon refuses every send while anything holds the project, and what a run
   * is about to write is not knowable from the rail's file list, which can only
   * report files that already exist. Without this the box stayed lit beside a
   * turn in flight and answered a press with a red line.
   */
  holder: LockHolder | null
  /**
   * A run started somewhere else that belongs on this transcript.
   *
   * The commit is the only one that ever arrived this way, and a commit is no
   * longer watched live — see `isCommitRun` — so adopting one today subscribes
   * to it silently and shows its record when it ends.
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
  /**
   * The conversation as it is on disk, per chat — see `useKeyed`.
   *
   * Re-reading a session file is the slowest of the fetches a project switch
   * fires, and switching projects reopens the chat you left in the one you
   * arrived at, so this pane blanked to "Reading…" for the longest of the four —
   * including on the way back to a transcript that was on screen a second ago.
   * Keyed on the project as well as the session because that is what names a
   * conversation to the daemon, and neither half is unique on its own.
   */
  const chatKey = projectId && openSessionId ? `${projectId}:${openSessionId}` : null
  const [view, rememberView] = useKeyed<ConversationView>(chatKey)
  const [error, setError] = useState<string | null>(null)
  /** The profile is open over this conversation. */
  const [profileOpen, setProfileOpen] = useState(false)
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
    // as the profile you asked for.
    setProfileOpen(false)
    // Picking up the id of the chat you just started here is not switching — the
    // turn is streaming, and clearing `runId` unsubscribes from it mid-answer,
    // which is what left a new chat showing your message and nothing else while
    // the daemon carried on.
    //
    // The transcript is not among the things cleared here: it is addressed by
    // the chat it belongs to, so this render is already showing the one you
    // arrived at — and clearing would throw that away rather than what you left.
    if (openSessionId === null || openSessionId !== startedHere.current) {
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
        if (cancelled) return
        rememberView(chatKey, v)
        // Adopt a turn that was already running when this page loaded.
        //
        // `runId` lives in component state, so a reload loses it and the pane
        // goes quiet while the daemon carries on — the only way to find out
        // whether anything happened was to reload again. The daemon knows what
        // is running; this asks.
        //
        // Off the answer rather than off `view`, which is now remembered across
        // a switch: a run id read back out of that store belongs to a turn that
        // may have ended while you were in another project, and adopting a dead
        // run replays it into the transcript — put-it-back bar and all.
        const inFlight = v.summary.activeRunId
        if (inFlight) setRunId((prev) => prev ?? inFlight)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [projectId, openSessionId, chatKey, rememberView])

  // A run handed to us from outside. Unconditional, unlike the adoption above:
  // it has to win over the id of a turn that has already finished, which is
  // exactly the state the pane is in when you press commit.
  useEffect(() => {
    if (adoptRunId) setRunId(adoptRunId)
  }, [adoptRunId])

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

  /**
   * The run on screen is the auto-commit, not a conversation's turn.
   *
   * Committing is background work and is not watched — see `isCommitRun`. While
   * this is true and the run is in flight, the pane draws NOTHING about it: no
   * step rows, no streaming message box, no working bar, no chime when it ends,
   * and the composer stays open because a send under a commit queues rather
   * than waits. The record — the folded "committed abc1234" line, or a failed
   * check's output — appears in the transcript the moment the run is over,
   * which is where a commit explains itself.
   *
   * The holder as two primitives rather than the object, for the reason the
   * chat list extracts them: `holder` is parsed out of a fresh JSON body every
   * 1.5 seconds, and the fact it carries almost never changes.
   */
  const holderRunId = holder?.runId ?? null
  const holderHeld = holder?.held ?? false
  const commitRun = useMemo(
    () => isCommitRun(turnEvents, runId, holderRunId, holderHeld),
    [turnEvents, runId, holderRunId, holderHeld],
  )
  /** A turn worth watching is in flight — the commit is deliberately not one. */
  const watching = busy && !commitRun

  // The point of the whole conversation pane is that you leave it running and
  // come back. Something has to say when to come back. Never for a commit: a
  // chime for a run nothing on screen showed is an alarm with no visible cause.
  useDoneChime(watching, runId)

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

  /**
   * What the transcript draws: everything, minus the commit while it is
   * landing. The events keep accumulating underneath — `verifyRefused` and the
   * derivations above read the unfiltered log — so when the run finishes this
   * filter stands down and the closed record appears in one piece.
   */
  const shownEvents = useMemo(
    () => (busy && commitRun ? events.filter((e) => e.runId !== runId) : events),
    [events, busy, commitRun, runId],
  )

  const [showAll, setShowAll] = useState(false)
  const truncating = !showAll && shownEvents.length > VISIBLE_TAIL

  /**
   * The reply being typed, handed to the transcript rather than rendered after
   * it, so that the finished copy of it lands in the same element. See
   * `LiveText`. Never for a commit run: what it streams is a commit message,
   * and what a repair turn under it says is part of the commit too.
   */
  /**
   * Whether the reply is revealed at a pace or dumped as it arrives.
   *
   * Remembered, and read here rather than passed down from the composer: the
   * transcript is what it acts on, and threading it through the box that sends
   * the turn would tie a preference about reading to the thing that does the
   * writing. The switch lives in the composer's control row because that is
   * where the other two per-turn toggles are, and it writes the same key.
   */
  const [typewriter] = useRemembered<boolean>(
    TYPING_KEY,
    false,
    (v): v is boolean => typeof v === "boolean",
  )

  /**
   * Both blocks paced, and paced separately.
   *
   * One hook each rather than one over the pair, because they do not advance
   * together: thinking finishes and stands still while the reply is still being
   * written, and a shared clock would drag the finished one along behind the
   * live one. Called unconditionally — a hook cannot sit behind the `busy`
   * check below, and there is nothing to pace when the strings are empty
   * anyway.
   */
  const typedText = useTyped(draft.text, typewriter)
  const typedThinking = useTyped(draft.thinking, typewriter)
  /**
   * Gated on the RAW text, not the revealed prefix.
   *
   * `useTyped` starts at zero for a block it has not begun revealing, so gating
   * on its output would hold the whole live row back for the first frames of
   * every message — and, worse, tear it down again between blocks each time the
   * prefix passed back through empty. What has arrived decides whether there is
   * a live row; the pacing only decides how much of it is drawn.
   */
  const typing = useMemo<LiveText | null>(
    () =>
      watching && runId && (draft.text || draft.thinking || draft.tools.length)
        ? { runId, thinking: typedThinking, text: typedText, tools: draft.tools }
        : null,
    [watching, runId, draft.text, draft.thinking, draft.tools, typedText, typedThinking],
  )

  const scroller = useRef<HTMLDivElement>(null)
  /**
   * The transcript's own box inside the scrollport.
   *
   * Held as state rather than in a ref because it is not rendered at all while
   * the log is empty — which is every chat for the moment between opening it and
   * the session store answering — and an effect that found a null ref at mount
   * would never learn the rows had arrived.
   */
  const [body, setBody] = useState<HTMLDivElement | null>(null)
  /**
   * The follow, shared with the wall's columns — see `useStickToEnd`, which
   * holds the reasoning and the several failures designed out of it. Opening a
   * chat and starting a turn both put you back at the end; a poll picking up a
   * line deliberately does not.
   */
  const { atEnd, toBottom } = useStickToEnd(scroller, body, [sessionId, runId])

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
    effort: EffortLevel
    thinking: boolean
    model: ChatModel
  }): Promise<boolean> => {
    if (!projectId) return false
    setError(null)
    try {
      const { runId: id } = await api.chat(projectId, { sessionId, ...msg })
      setRunId(id)
      // A first turn, from a chat that has no name yet. Written on the unsent
      // record so that walking away from this pane in the seconds before the SDK
      // names the session does not lose the handoff — see `startedRunId`.
      //
      // With the message, because the box it came from was emptied by the press
      // that sent it and the row in the list has nothing else left to show for
      // those seconds — see `sentText`.
      if (!sessionId && draftId) markDraftSent(draftKey(projectId, draftId), id, msg.text)
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
        {/* What is left of the footer, in a bar that was already on screen. The
            rest of that row said things something else was already saying —
            "working…" beside the working bar, the kind beside the row in the
            list that carries the same label, and a path that is the project's
            root by definition and now lives once, in the projects rail. */}
        {view && (
          <span className="font-sans text-[11px] text-fg-dim">{view.totalMessages} messages</span>
        )}
        {/* Only for a conversation that has actually run. A chat with no
            session id has no event log to measure, and offering the button
            anyway would answer every press with the same empty document. */}
        {projectId && sessionId && (
          <Button
            onClick={() => setProfileOpen(true)}
            title="Where this conversation's time went, and what it cost"
          >
            profile
          </Button>
        )}
      </PaneHeader>

      {profileOpen && projectId && sessionId && (
        <ProfileOverlay
          projectId={projectId}
          sessionId={sessionId}
          onClose={() => setProfileOpen(false)}
        />
      )}

      {/* The transcript and the button that jumps it to the end, in one
          positioned box, because the button's whole job is to be in a corner of
          THIS box. It used to hang off the pane instead, at `bottom-32` — a
          guess at the height of the working bar plus the composer, and a guess
          is wrong in both directions: short, and the pill parks on top of a
          control, which is what it did to the working bar's right-hand end;
          long, and it floats in the middle of the transcript. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scroller}
          className="relative flex-1 overflow-x-hidden overflow-y-auto px-3 py-2 font-mono text-xs leading-relaxed"
        >
          {/* Only when there is nothing on screen to keep. `view` is addressed
              by session id, so a new chat's first turn arrives at a key that has
              never been fetched: `run.started` names the session a few seconds
              in, the pane follows it to that id, and the transcript you were
              already watching was replaced by "Reading…" until a session-store
              read came back — a full-pane wipe landing between the thinking and
              the first word of the answer, which reads as the page reloading
              under the turn. The live stream IS the conversation at that moment;
              there is nothing to wait for. */}
          {shownEvents.length === 0 && openSessionId && view === null && !error ? (
            <Empty>Reading…</Empty>
          ) : shownEvents.length === 0 ? (
            <Empty>
              {projectId
                ? "Say something. This runs in the project root and can edit it."
                : "Select a project."}
            </Empty>
          ) : (
            // The box the follower measures. A plain div wrapping the rows,
            // rather than the scrollport itself, because a scrollport's own
            // height does not change when what is inside it grows — and it is
            // not around the two empty states above because `Empty` centres
            // itself with `h-full`, which resolves against its parent and would
            // quietly become "as tall as the text" inside a wrapper.
            <div ref={setBody}>
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
                events={shownEvents}
                onPermission={busy ? answer : undefined}
                live={typing}
                busy={watching}
                tail={showAll ? undefined : VISIBLE_TAIL}
                // So the question you are under can pin itself to the top edge of
                // this box. It is the only thing in there that needs to know where
                // the box's edge is.
                scroller={scroller}
              />
            </div>
          )}
          {error && <p className="mt-2 font-sans text-[11px] text-err">{error}</p>}
        </div>

        {/* The way back into the follow, and the only thing that moves the pane
            while you are reading it. Shown exactly when the end is off screen —
            which, now that the pane follows, is exactly when you scrolled away
            from it. It used to show on `busy` as well, from when nothing
            followed at all; that would now be a pill sitting over a turn it has
            nothing left to do for. */}
        {!atEnd && (
          <button
            type="button"
            onClick={toBottom}
            className="absolute right-4 bottom-3 z-10 flex items-center gap-1.5 rounded-full border border-line bg-chrome px-3 py-1 font-sans text-[11px] text-fg-muted shadow-lg hover:text-fg"
          >
            <ArrowDown className="size-3" />
            jump to latest
          </button>
        )}
      </div>

      {watching && (
        <WorkingBar events={turnEvents} runId={runId} outputTokens={draft.outputTokens} />
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
          // `watching`, not `busy`: an adopted commit run must not put the box
          // into its working state — a send under a commit queues, and a stop
          // button for a run nothing on screen shows is a control with no
          // visible referent.
          busy={watching}
          usage={usage}
          sessionId={sessionId}
          // The open chat's box, whether it has a session yet or not: an
          // unstarted one is addressed by its draft id, and losing that would
          // hand every unstarted chat the same box.
          draftKey={draftKey(projectId, sessionId ?? draftId ?? "")}
          inheritedMode={summary?.lastMode ?? null}
          // Stated in `projectGates` rather than here — the wall's columns each
          // carry a box of their own and must refuse on the same terms this one
          // does. See that file for why the holder is compared by RUN ID.
          blocked={
            projectGates({
              holder,
              openRunId: runId,
              held: heldBy,
            }).send
          }
          autoSend={autoSend}
          onAutoSent={onAutoSent}
          onSend={send}
          onInterrupt={() => {
            if (runId) void api.interruptChat(runId).catch(() => {})
          }}
        />
      )}
    </section>
  )
}
