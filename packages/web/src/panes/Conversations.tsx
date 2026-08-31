import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type {
  Attachment,
  ChatMode,
  ChatStatus,
  ContextUsage,
  EffortLevel,
  RunEvent,
} from "@aide/protocol"
import { born, sortChats } from "@aide/protocol"
import { api, type ConversationRow, type ConversationView, type LockHolder } from "../api.js"
import { useDoneChime } from "../chime.js"
import { MAX_ATTACHMENT_BYTES, readAsAttachment } from "../attachments.js"
import { Composer } from "../Composer.js"
import {
  addBacklogChat,
  captureKey,
  discardDraft,
  draftKey,
  draftSubject,
  forgetDraftRun,
  idFromKey,
  markDraftSent,
  readDraft,
  saveDraft,
  useDraft,
  useUnstartedChats,
  type Draft,
} from "../drafts.js"
import { ArrowDown, Check, Lock, Play, X } from "../icons.js"
import { draftName, useAutoNames } from "../naming.js"
import { ProfileOverlay } from "../Profile.js"
import { WorkingBar } from "../Working.js"
import { Button, Empty, heldBy, LOCKED, PaneHeader, SELECTED } from "../ui.js"
import { useKeyed } from "../useKeyed.js"
import { useRemembered } from "../useRemembered.js"
import { useRunStream } from "../useRunStream.js"
import { useAutoGrow } from "../useAutoGrow.js"
import { TYPING_KEY, useTyped } from "../typing.js"
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

/**
 * How often to ask the daemon what a sent-but-unnamed chat became.
 *
 * The app's own beat, because the answer takes about as long to exist: the SDK
 * names a session a second or two after a first turn starts. There is at most
 * one handoff outstanding at a time — one agent per project — and the asking
 * stops the moment it lands, so this is not a poll the app carries, it is the
 * tail of one press.
 */
const HANDOFF_MS = 1500

/**
 * Midnights crossed between then and now, in local time.
 *
 * Rounded rather than floored: the two DST changeovers make a local day 23 or
 * 25 hours long, and a floor over the short one dates every row on that Sunday
 * to the day before.
 */
function daysAgo(then: Date): number {
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  return Math.round((midnight(new Date()) - midnight(then)) / 86_400_000)
}

/**
 * When a chat started: the clock time if that was today, days if it was not.
 *
 * "3h ago" cannot tell you which of this morning's conversations came before
 * which meeting; 11:09 can, and that is the whole of what a date on a row is
 * for. Past yesterday nobody places a chat by the hour, so days do from there.
 *
 * The boundary is midnight, not 24 hours. On elapsed seconds a chat from 11:09
 * yesterday still prints "11:09" at 09:00 this morning, and a clock time with
 * no date beside it reads as today.
 *
 * Written out rather than `toLocaleTimeString`, whose width moves with the
 * locale — "9:05 AM" and "11:09" in one column undoes the tabular figures the
 * rest of the line is aligned by.
 */
function when(ms: number): string {
  const then = new Date(ms)
  const days = daysAgo(then)
  if (days <= 0) {
    return `${String(then.getHours()).padStart(2, "0")}:${String(then.getMinutes()).padStart(2, "0")}`
  }
  if (days === 1) return "yesterday"
  return `${days}d ago`
}

/**
 * The same moment in full, for a hover. Locale-formatted, unlike the row: a
 * tooltip has no column to keep straight, so the reader's own format wins.
 */
const fullDate = (ms: number) => new Date(ms).toLocaleString()

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
  // What the row is about, which is the box until sending empties it and the
  // message that went out after that — see `draftSubject`. Reading `draft.text`
  // here is what made a chat you had just started read "New chat" for the two or
  // three seconds before the SDK named it: you pressed send on a request you had
  // written, and the row for it went blank in front of you.
  const said = draftSubject(draft)
  const firstLine = said.trim().split("\n", 1)[0] ?? ""
  // The name if it has one and it still describes what was written, and the
  // first line otherwise — which is what this row showed before naming existed,
  // and what it falls back to the moment a parked request is edited.
  const preview = draftName(draft) ?? firstLine
  const written = draft.text.trim() !== "" || draft.attachments.length > 0
  /** Sent, and a second or two from becoming a conversation — see `startedRunId`. */
  const starting = draft.startedRunId !== undefined
  return (
    <div
      // Matches `ChatRow`: no gap at the edges, `pr-2` — see the argument there.
      // The two row types sit in one list and their buttons have to line up.
      className={`group flex w-full items-center border py-1.5 pr-2 pl-3 font-sans hover:bg-hover ${
        selected ? `${SELECTED} text-fg` : "border-transparent text-fg-muted"
      }`}
    >
      <button
        type="button"
        onClick={onOpen}
        // What was actually parked, in full. The line above is a name a model
        // wrote once the request outgrew the column, so without this there is no
        // way to check it against your own words short of opening the chat.
        title={said || undefined}
        className="flex min-w-0 flex-1 flex-col gap-0.5 pr-1.5 text-left"
      >
        <span className="truncate text-[13px]">{preview || "New chat"}</span>
        <div className="flex items-baseline gap-2 text-[10px] tabular-nums text-fg-dim">
          {/* First in the line, the column a started chat puts its own time in —
              a parked chat is the same list at an earlier age, and a date that
              moves between the two would be a date you have to hunt for. */}
          <span title={`Parked ${fullDate(draft.createdAt)}`}>{when(draft.createdAt)}</span>
          {/* The same lie as the blank title, in the line underneath: a chat
              whose first turn is in flight has plainly been sent. It says so
              until the handoff lands and this row becomes the conversation,
              which is where the run mark takes over. */}
          <span>{starting ? "starting…" : "not sent yet"}</span>
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
        // Still hover-only, and still unfilled — discarding a row is not what
        // you came to the list to do — but a real target rather than the size
        // of the glyph: the ✕ was 12px, and the pixels either side of it were a
        // miss that discarded nothing and cost a second to notice.
        //
        // `mr-1` now that the row itself has no gap: this one is a bare glyph
        // rather than a plate, so without it the ✕ sits flush against the ▶'s
        // border and the two read as one control.
        className="mr-1 flex size-7 shrink-0 items-center justify-center text-fg-dim opacity-0 group-hover:opacity-100 hover:text-err"
      >
        <X className="size-4" />
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

        Held back, it becomes a padlock rather than a faded ▶. The list is where
        this matters most: a project mid-run draws a column of six or seven of
        them, and six faded triangles read as a list that has not loaded. Six
        padlocks read as one run holding everything, which is the truth — and the
        row a few lines up whose own square is spinning instead of locked is the
        one holding it. That pairing is why the run is drawn IN this slot rather
        than in a column of its own: locked and holding are the same fact from
        two ends, so they belong at the same x.

        A 36px square, filled, with a 20px glyph in it — the row's own height, so
        the slot is a square and not a tall slot with a small triangle rattling
        around in it. It was a hairline box 16px high, in fg-dim on a background
        eight percent lighter than it, which made the one control that starts
        work the hardest thing in the column both to see and to hit, and put it
        a few pixels from the ✕ that throws the same row away.
      */}
      {written && (
        <button
          type="button"
          // Not `disabled`: the title is the only place this row can say WHY,
          // and a disabled button never opens one. See `Button` in ui.tsx.
          aria-disabled={blocked ? true : undefined}
          onClick={blocked ? undefined : onStart}
          title={blocked ?? "Start this chat — opens it and sends it"}
          className={`flex size-9 shrink-0 items-center justify-center rounded-sm border ${
            blocked
              ? `border-diff-del-fg/40 ${LOCKED}`
              : "border-line-soft bg-input text-fg-muted hover:border-ok hover:bg-raised hover:text-ok"
          }`}
        >
          {blocked ? <Lock className="size-5" /> : <Play className="size-5" />}
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
  /**
   * The box reads straight out of the draft store, exactly as the composer does
   * and for the same reason: component state is what evaporated a half-written
   * idea on every reload, and this pane is reloaded by the dev server whenever
   * a run finishes rewriting the modules it is running.
   *
   * Under a key of its own — see `captureKey`. Nothing here has been parked yet,
   * so it must not become a row; keeping the words is not the same as saying
   * you meant them.
   */
  const key = captureKey(projectId)
  const draft = useDraft(key)
  const text = draft?.text ?? ""
  const attachments = draft?.attachments ?? NOTHING_TYPED
  const edit = (patch: { text?: string; attachments?: Attachment[] }) =>
    saveDraft(key, { text, attachments, ...patch })
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
    edit({ text: "", attachments: [] })
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
    if (added.length === 0) return
    // Re-read the box rather than trusting what this closure captured: decoding
    // is async, so anything typed — or a second image pasted — while it ran
    // would be overwritten by the stale copy.
    const now = readDraft(key)
    saveDraft(key, { text: now.text, attachments: [...now.attachments, ...added] })
  }

  return (
    <div className="shrink-0 border-b border-line bg-editor p-2">
      {attachments.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {attachments.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => edit({ attachments: attachments.filter((x) => x.id !== a.id) })}
              title="Remove this image"
              className="inline-flex items-center gap-1 rounded border border-line-soft px-1.5 py-0.5 font-sans text-[10px] text-fg-dim hover:border-err hover:text-err"
            >
              image
              <X className="size-2.5" />
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
        onChange={(e) => edit({ text: e.target.value })}
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
 * A run in flight: a sweeping ring with its own elapsed time inside it.
 *
 * This is drawn IN the row's one button slot, in place of the padlock. Every
 * earlier version of this gave the state its own furniture — a sentence in the
 * title line, then a spinner and a clock beside the button, then a whole
 * indicator column on the left — and each of them cost width on a row that is
 * already truncating its title at 320px. The column was the worst of the three
 * because it was mostly EMPTY: one project runs one agent, so on a list of forty
 * rows it reserved 32px on every one of them to say something about one.
 *
 * The button slot is already the status column and always was. It is the fixed
 * x the eye reads down, it is 36px on every row whatever is in it, and what it
 * draws is already exactly this fact: ▶ to start, ✓ once it has run, and a
 * padlock when the project is held. The padlock is the redundant one — the whole
 * list wears it when anything is running, which says "held" forty times and
 * "held BY THIS ROW" nowhere. So the row holding it spins instead, and the
 * padlock keeps meaning what it always meant on the other thirty-nine.
 *
 * The time goes inside the ring rather than on the meta line beside the cost:
 * it is the one number on the row that is CHANGING, and the rest of that line is
 * a record of what the chat has already spent. Inside the ring the two halves of
 * one fact are one object — the ring says a run is happening, the number says
 * for how long.
 *
 * Two of the four sides are transparent rather than one, so this reads as a
 * sweeping arc rather than a wheel with a nick out of it.
 *
 * `blocked` is not drawn here. A tool call waiting on a human still holds the
 * checkout, so the ring is still true, and it is a state you meet in the chat
 * you have OPEN — the composer says it, in a sentence, which is where an
 * instruction belongs. A second glyph for it in this slot would be a state that
 * looks different in the list from what it is.
 *
 * `uncommitted` is not drawn here either, though it was asked for. What is
 * uncommitted is a fact about the PROJECT — the commit takes the working tree,
 * not a conversation's diff, which the brief is emphatic about — so a mark per
 * chat would be the same mark on every row, drawn from one number. It is already
 * on the project row and on the rail, which is where a project fact belongs.
 */
function RunDial({ since }: { since: number | null }) {
  return (
    <>
      {/* Concentric with the 36px square, inset by a pixel so the arc reads as
          the button's own edge lit up rather than a hoop dropped over it. */}
      <span className="pointer-events-none absolute -inset-px animate-spin rounded-sm border-2 border-info/70 border-t-transparent border-r-transparent" />
      <Held since={since} />
    </>
  )
}

/**
 * How long the run has been holding, ticking, in the middle of the dial.
 *
 * Its own second timer rather than the app's 1.5s poll. The poll does re-render
 * this row often enough to keep a coarse number roughly right, but it is a
 * network round trip: pause it, throttle the tab, or lose the daemon for a
 * moment and the one thing on screen claiming to be live silently freezes —
 * which is the exact failure the number is here to rule out. A local interval
 * cannot be wrong about the clock.
 *
 * Not `dur`, which is the row's formatter for figures you SCAN: it rounds to
 * whole minutes above 60s, so a live counter built on it sits on `4m` for sixty
 * seconds at a stretch, and a clock that visibly stalls is the same picture as a
 * wedged run — the one thing this number exists to disprove. Under a minute it
 * counts seconds; over one it counts minutes, because `12m 04s` does not fit
 * inside a 36px square and the seconds stop being the interesting digit long
 * before the square runs out of room.
 *
 * Only mounted while a run is in flight, so the timer exists for exactly as long
 * as there is something to count.
 */
function Held({ since }: { since: number | null }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (since === null) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [since])
  // A holder the list has not matched to a row yet — a brand new chat in its
  // first seconds. The ring alone is the whole truth available; a `0s` that then
  // jumped would be a worse one.
  if (since === null) return null
  const s = Math.max(0, Math.round((now - since) / 1000))
  return (
    // 11px, not the 9px this started at. 9px inside a 36px square is a speck
    // with a wide moat around it — the arc reads and the number does not, which
    // wastes the whole reason the count sits in the middle rather than out on
    // the meta line. `12m` is the widest string it can hold and it clears the
    // square's inner width at this size; the next step up does not.
    <span className="text-[11px] leading-none font-semibold tabular-nums text-info">
      {s < 60 ? s : `${Math.floor(s / 60)}m`}
    </span>
  )
}

/**
 * Why the mark matters, on hover — and how long it has mattered for.
 *
 * The age is the whole of it. "One agent at a time" without it is a dead end:
 * the question in the moment is always whether the thing in your way is nearly
 * done or wedged, which is why the daemon's own refusal prints the same number.
 *
 * Still worded as the refusals are, now that the row itself no longer is: this
 * is where a chat that was just turned away comes to confirm it found the right
 * row.
 */
const HAS_THE_REPO = (heldSince: number | null) =>
  `${heldSince === null ? "A run is in flight here" : `A run has been in flight here for ${dur(Date.now() - heldSince)}`}. One agent has a project's checkout at a time, so nothing else in this project can start until it finishes.`

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
function DoneCheck({
  done,
  working,
  heldSince,
  ranLast,
  onToggle,
}: {
  done: boolean
  /** A run is in flight in this chat — the square becomes the dial. */
  working: boolean
  /** When that run started, for the number inside the dial. */
  heldSince: number | null
  /** The project's most recent run happened here — the square wears gold. */
  ranLast: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={
        working
          ? HAS_THE_REPO(heldSince)
          : ranLast
            ? `The most recent run in this project happened here — the row you probably want next.\n\n${done ? "Served its purpose. Click to reopen it." : "Click to mark this chat done."}`
            : done
              ? "Served its purpose. Click to reopen it."
              : "Mark this chat done"
      }
      // The same 36px filled square the ▶ on a parked chat wears, because the
      // two are the same slot at two ages — see `UnstartedRow`, which is also
      // where the size is argued.
      //
      // `relative`, because the run dial is drawn on this square rather than
      // beside it.
      className={`relative flex size-9 shrink-0 items-center justify-center rounded-sm border bg-input ${
        // Gold outline, and it outranks the two below. Where the last run
        // happened is the row you most often want next, and a green tick or a
        // grey plate is what that row looks like the rest of the time — so the
        // mark has to survive being on either. It is the border alone: this
        // square is a control with three other things to say, and a fill would
        // leave it saying one.
        ranLast && !working
          ? `border-found ${done ? "text-ok/45" : "text-transparent group-hover:text-fg-muted"}`
          : done
            ? // Dimmer than it was. A project with seventy archived chats draws
              // a solid column of these, and at full strength that wall of green
              // was the loudest thing in the pane — shouting the one fact you
              // have already dealt with, over the two rows that still want
              // something. A tick you have to be looking at to see is right for
              // a state whose whole meaning is "no longer your problem".
              "border-ok/25 text-ok/45 hover:border-ok/60 hover:text-ok"
            : // `text-transparent` rather than `invisible`: the tick is still
              // there to be hovered, and `currentColor` on the icon means it
              // vanishes with the text colour it inherits.
              "border-line-soft text-transparent group-hover:text-fg-muted hover:border-fg-muted"
      }`}
    >
      {/* Hidden under the dial rather than unmounted: a run ends and the tick
          has to be in the same place it was, at the same size, or the column
          twitches every time a turn finishes. */}
      <Check className={`size-5 ${working ? "opacity-0" : ""}`} />
      {working && <RunDial since={heldSince} />}
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
  status,
  heldSince,
  ranLast,
  selected,
  onOpen,
  onToggleDone,
}: {
  chat: ConversationRow
  /**
   * The row's status as of NOW, which is not `chat.status` — see `withLock`.
   * Passed in rather than read off the chat so that the badge and the group the
   * row is drawn in cannot be looking at two different answers.
   */
  status: ChatStatus
  /** When the run holding the repo started, if this row is the one holding it. */
  heldSince: number | null
  /** This is where the project's most recent run happened — see `newest`. */
  ranLast: boolean
  selected: boolean
  onOpen: () => void
  onToggleDone: () => void
}) {
  const closed = status.state === "closed"
  const spend = chat.spend
  const working = status.state === "working"
  /**
   * Ran-last is a gold outline on the row's own button, not a wash across it.
   *
   * The wash was a gold gradient over the whole row, and it was the loudest
   * thing in the pane — for the mildest fact on it. "This is where the last run
   * happened" is a signpost; it was drawn like an alarm, it fought the selection
   * frame on the row you were usually also IN, and it tinted the text of the one
   * row you were most likely to be reading. The button already sits at a fixed x
   * down the list, so outlining it says the same thing in a border, on the
   * control you would press next anyway.
   *
   * Suppressed for the length of a run, because `newest` returns the holder
   * while one is in flight — so both facts land on the SAME row and the same
   * square, and the run is the one worth drawing. `DoneCheck` ranks them.
   */
  const lit = ranLast && !working
  // Dim enough to stay behind the title, but not on the row you have selected:
  // fg-dim on the selection blue is the one place it stops being readable.
  const meta = selected ? "text-fg-muted" : "text-fg-dim"
  return (
    <div
      // `pr-2` and no gap, against `px-3` and `gap-2`. The square is a bordered
      // plate with its own inset, so the gap was padding stacked on padding —
      // about twenty pixels of nothing between a title that is truncating and a
      // button that is not moving. The title gets them.
      className={`group flex w-full items-center border py-1.5 pr-2 pl-3 font-sans hover:bg-hover ${
        selected ? SELECTED : "border-transparent"
      } ${selected || working ? "text-fg" : "text-fg-muted"}`}
    >
      <button
        type="button"
        onClick={onOpen}
        title={chat.gitBranch ? `${chat.cwd} · ${chat.gitBranch}` : chat.cwd}
        // Just enough that a truncating title's ellipsis does not touch the
        // plate beside it. The row's own gap used to be doing this, at four
        // times the width.
        className="flex min-w-0 flex-1 flex-col gap-0.5 pr-1.5 text-left"
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
        </div>
        {/* Tabular figures, so the money column does not shuffle sideways as you
            read down a list of costs that differ only in the cents. */}
        <div className={`flex items-baseline gap-1.5 text-[10px] tabular-nums ${meta}`}>
          {/* First, and only while a run is in flight: it is the one figure on
              the line that is CHANGING, and the rest of the line is a record of
              what the chat has already cost. It reads as the same kind of thing
              as the numbers beside it — which it is — rather than as a badge
              needing its own furniture. */}
          <span title={dateTitle(chat)}>{when(born(chat))}</span>
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
      {/* On `done`, not on `closed`. They differ in one case and it is a real
          one: a chat you ticked off and then asked one more thing of reports
          `working` so that it sorts as work, which drew an EMPTY box on a
          conversation you had plainly ticked — and then took a press to say the
          thing the box was already showing. */}
      <DoneCheck
        done={status.done}
        working={working}
        heldSince={heldSince}
        ranLast={lit}
        onToggle={onToggleDone}
      />
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

/**
 * What the date on a row means, on hover.
 *
 * The row prints when the chat STARTED, because that is what it is ordered by.
 * When it was last spoken to is the fact that used to be printed there, so it
 * moved here rather than being dropped — it is the one that answers "did my
 * question go through", and it is a second line rather than a second column
 * because 320px was already full.
 *
 * A session whose first entry carried no timestamp has only its file's mtime.
 * Labelling that "started" would date a month-old conversation to the last
 * thing said in it, so that case says what it actually knows.
 */
const dateTitle = (chat: ConversationRow) =>
  chat.createdAt === null
    ? `Last active ${fullDate(chat.lastModified)}. This session's first entry carried no date, so when it started is not recorded.`
    : `Started ${fullDate(chat.createdAt)}\nLast active ${fullDate(chat.lastModified)}`

const USAGE_SHARE = (tokens: number) =>
  `${compact(tokens)} tokens, as a share of every token aide has spent on this machine. Not your plan's usage — that window counts every client at once.`

/**
 * How a parked chat looks to the ordering the started ones use.
 *
 * It has no status and no session, but it has a date, and a date is the whole of
 * what the order reads — so it sorts AMONG the conversations rather than in a
 * block above them. Two ideas parked either side of a chat you actually had keep
 * the order you had them in, which is the whole point of ordering by when a
 * thing came to exist.
 *
 * One object for every parked row, because none of them differ.
 */
const PARKED: ChatStatus = { state: null, blocked: false, done: false }

/** One array for every empty box, so the identity is stable across renders. */
const NOTHING_TYPED: Attachment[] = []

/**
 * A fetched status, brought up to date from the lock.
 *
 * The rows arrive with a `status` the daemon computed, and it is exactly as old
 * as the last time anything asked for the list — which is when you arrived at the
 * project and when you ticked something off, and NOT on the app's beat. So a
 * chat that was running when the list was read went on saying so afterwards: the
 * badge sat on a conversation that had finished seven minutes earlier and was
 * waiting on a reply, and the sort kept it pinned to the top of the list while it
 * did. The other direction was worse and completely silent — a permission prompt
 * arrives mid-turn, and nothing refetches during a turn, so the badge that means
 * "an agent is stopped on your click" could essentially never appear.
 *
 * The lock IS polled, with the projects, and one agent per project makes it a
 * complete answer rather than a hint: if this session is not the holder then
 * nothing is running in it, whatever the row was told earlier. `done` is the
 * other half and it is the half that does not move on its own — a human sets it,
 * and setting it refetches — so it is taken from the row as fetched.
 *
 * The reconstruction is `chatStatuses`' own rule, in the same order: running
 * outranks done, because a chat you ticked off and then asked one more thing of
 * is running whatever the tick says — and that is what keeps it out of the
 * archived group while the turn is in flight.
 */
function withLock(
  status: ChatStatus,
  sessionId: string,
  holdingSession: string | null,
  holderBlocked: boolean,
): ChatStatus {
  const running = sessionId === holdingSession
  return {
    state: running ? "working" : status.done ? "closed" : null,
    // Only ever true of the run in flight, so a row that is not the holder
    // cannot be left wearing a prompt that was answered while you were away.
    blocked: running && holderBlocked,
    done: status.done,
  }
}

/**
 * A row in the list, whichever kind it is.
 *
 * Flattened to the two dates the order reads and the status the groups are split
 * on, so both kinds go through one sort. Two sorts stitched together was the
 * alternative, and it can only ever produce a list whose two halves disagree
 * about what "first" means.
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
  holder,
  startBlocked,
  onSelect,
  onSelectDraft,
  onStartDraft,
  onDraftStarted,
  onChanged,
}: {
  projectId: string | null
  selected: string | null
  /** The unstarted chat that is open, when the open one is not a session. */
  selectedDraft: string | null
  /** Bumped by the app to ask for a refetch — see App.tsx for why it is not a key. */
  reloadSeq: number
  /**
   * Which conversation has this project's checkout right now, from the app's
   * poll. The rows below are not polled; this is what keeps their badges from
   * describing a turn that ended minutes ago. See `withLock`.
   */
  holder: LockHolder | null
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
  /**
   * An unstarted chat turned out to have a session after all — see `waiting`.
   * Must be stable, or the handoff below restarts on every poll.
   */
  onDraftStarted: (draftId: string, sessionId: string) => void
  /** Ticking a chat off changes the row the pane below is showing. */
  onChanged: () => void
}) {
  /**
   * The rows, per project — see `useKeyed`.
   *
   * A refetch has never blanked this: swapping the rows for "Reading the session
   * store…" and back collapses the scroller and loses your place, so the tick you
   * just clicked would scroll you to the top. A project switch used to be the one
   * exception, on the grounds that another project's chats must not appear under
   * this one's name. Filing the rows under the project they were read from says
   * the same thing without the flash.
   */
  const [items, rememberItems] = useKeyed<ConversationRow[]>(projectId)
  const [error, rememberError] = useKeyed<string>(projectId)
  /**
   * The chats that have not started. They have no session id and no file on
   * disk, so the daemon cannot know about them and they cannot arrive in
   * `items` — until a first turn, these records are the entire conversation.
   */
  const unstarted = useUnstartedChats(projectId)
  /**
   * Anything parked and left gets a name, before it has ever run.
   *
   * Here rather than where a chat is parked, because the two ways one appears —
   * the capture box above, and a "new" chat you typed into and walked away from
   * — are the same fact seen twice, and it is a fact about the LIST: nobody is
   * typing in this row. Which is also why the open chat is handed over; see
   * `useAutoNames`.
   */
  useAutoNames(unstarted, selectedDraft)

  useEffect(() => {
    if (!projectId) return

    // Still cancelled on the way out, even though a late answer would now be
    // filed correctly: ticking a chat off refetches, and an earlier fetch
    // landing after a later one would put the row back where it was.
    let cancelled = false
    void api
      .conversations(projectId)
      .then((r) => {
        if (cancelled) return
        rememberItems(projectId, r)
        rememberError(projectId, null)
      })
      .catch((err) => {
        if (!cancelled) rememberError(projectId, err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [projectId, reloadSeq, rememberItems, rememberError])

  /**
   * Chats whose first turn has gone out and which have no session id here yet.
   *
   * Every new chat spends a second or two in this state: the conversation
   * exists, the SDK has not named it, and the name will be announced exactly
   * once — on that run's live stream, to whoever is watching it. The pane
   * watching the turn picks it up, and until this it was the ONLY thing that
   * could. Switch project, or click another chat, inside those two seconds and
   * the name arrived to nobody: the record that WAS the chat stayed in this list
   * reading "not sent yet", beside the conversation it had turned into, and the
   * project's remembered chat went on pointing at it — so coming back to the
   * project opened an empty box instead of the work you had just started.
   *
   * So the list asks the daemon, which wrote the name down. Here rather than in
   * the pane because the stranded row is here, and it is stranded exactly when
   * nobody is looking at it.
   */
  const waiting = useMemo(() => unstarted.filter((d) => d.startedRunId), [unstarted])
  /** Runs already answered for, so two overlapping ticks hand off once. */
  const handedOff = useRef(new Set<string>())

  useEffect(() => {
    if (!projectId || waiting.length === 0) return
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
              onDraftStarted(idFromKey(draft.key), sessionId)
            } else if (ended) {
              // The turn is over and never got a session, so there is no
              // conversation for this row to become and no name left to wait
              // for. It goes back to being an ordinary parked chat.
              handedOff.current.add(runId)
              forgetDraftRun(draft.key)
            }
          })
          .catch(() => {
            // The daemon is down, or newer than this page. Either way the row is
            // unchanged and the next tick asks again.
          })
      }
    }
    ask()
    const timer = setInterval(ask, HANDOFF_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [projectId, waiting, onDraftStarted])

  const toggleDone = (row: ConversationRow) => {
    if (!projectId || !items) return
    // On `done` rather than on `state`, because `done` is the bit this button
    // owns and `state` is a derivation that outranks it: a chat you ticked off
    // and then asked one more thing of reports `working`, and reading the
    // direction off that sent the tick to close a conversation that was already
    // closed — so the one press that should have reopened it did nothing.
    const closing = !row.status.done
    // Move the row now rather than when the daemon answers. A round trip is long
    // enough that ticking off three chats in a row means clicking, waiting,
    // finding where the list has settled, clicking again. `onChanged` refetches
    // and overwrites this with the truth a moment later.
    //
    // Only `done` is guessed at. It is the only half of a status a tick can
    // change, and `withLock` derives the rest from it on the way into the list —
    // so the rule that running outranks done is applied in one place instead of
    // being re-guessed here, where getting it wrong made the row jump twice:
    // once to where the tick put it, once to where the refetch did.
    rememberItems(
      projectId,
      items.map((c) =>
        c.sessionId === row.sessionId ? { ...c, status: { ...c.status, done: closing } } : c,
      ),
    )
    const call = closing
      ? api.closeChat(projectId, row.sessionId)
      : api.reopenChat(projectId, row.sessionId)
    void call
      .then(() => onChanged())
      .catch((err) => {
        rememberError(projectId, err instanceof Error ? err.message : String(err))
        onChanged()
      })
  }

  /**
   * The lock as two values rather than as the object it arrived in.
   *
   * `holder` is parsed out of a fresh JSON body every 1.5 seconds, so its
   * identity changes on every poll while the fact it carries almost never does.
   * Depending on the object below would rebuild and re-sort the whole list twice
   * a second; depending on what was actually read from it rebuilds only when the
   * lock genuinely moves.
   */
  const holdingSession = holder?.sessionId ?? null
  const holderBlocked = holder?.blocked ?? false
  const running = holder !== null

  /**
   * The chat the project's most recent run happened in.
   *
   * The one row you almost always want next, and the list is deliberately no
   * help in finding it: `sortChats` orders by when a chat STARTED and is
   * emphatic about not reordering on activity, so the conversation that just
   * answered you is wherever you first parked it — three screens down, beside
   * whatever else you started that morning. Until this, the only thing pointing
   * at it was the run mark, which goes out with the run: the one pointer to the
   * row disappeared at exactly the moment there was finally something to read.
   *
   * A run in flight wins over the dates, and that is not a preference — a
   * session file is only rewritten when a turn ENDS, so for the length of a turn
   * the newest `lastModified` in the list belongs to whichever chat spoke
   * BEFORE this one.
   *
   * That still matters even though `DoneCheck` draws the run instead of the gold
   * for the length of one — arguably more. The gold outline is what the square is
   * left wearing the instant the dial stops, and this is what decides which row
   * that is; reading the dates instead would mark the chat that spoke before this
   * one, then correct itself a beat later when the session file lands. A mark
   * that moves after the fact is worse than one that was briefly absent.
   *
   * A holder with no session id yet is a brand new chat in its first seconds,
   * and it lights nothing: the row it will become does not exist in this list,
   * and falling back to the dates would light the conversation it just
   * displaced instead.
   */
  const newest = useMemo(() => {
    if (running) return holdingSession
    let best: ConversationRow | null = null
    for (const c of items ?? []) if (!best || c.lastModified > best.lastModified) best = c
    return best?.sessionId ?? null
  }, [items, running, holdingSession])

  /**
   * Every row this project has, in one order: newest first, whatever each one is
   * doing. See `sortChats` — a chat you park has to appear where you are looking.
   *
   * Memoized because `sortChats` copies, and this list is re-rendered on the
   * app's poll: a fresh array every 1.5 seconds is a fresh identity for every
   * row's props, which is enough to make a 200-chat list stutter while you
   * scroll it.
   *
   * The status each row carries is `withLock`'s rather than the one it was
   * fetched with, because it is what the badge draws and what the split below
   * sorts a chat into — and the fetched copy is as old as the last time anything
   * asked for the list.
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
            status: withLock(c.status, c.sessionId, holdingSession, holderBlocked),
            createdAt: c.createdAt,
            lastModified: c.lastModified,
          }),
        ),
      ]),
    [unstarted, items, holdingSession, holderBlocked],
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
        status={row.status}
        heldSince={row.chat.sessionId === holdingSession ? (holder?.startedAt ?? null) : null}
        ranLast={row.chat.sessionId === newest}
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
   * How many files are uncommitted in the project, which is exactly the scope a
   * commit takes. Passed down rather than polled here: the git rail already asks
   * on the app's beat, and two pollers would let the box and the rail disagree
   * about whether a new chat is allowed.
   */
  uncommitted: number
  /**
   * Who has the project's checkout right now, from the app's poll.
   *
   * The one fact about other chats this pane reads live, and it has to be: the
   * daemon refuses every send while anything holds the project, and what a run
   * is about to write is not knowable from `uncommitted`, which can only report
   * files that already exist. Without this the box stayed lit beside a turn in
   * flight and answered a press with a red line.
   */
  holder: LockHolder | null
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
   * Something OTHER than the run this pane is watching has the checkout.
   *
   * By run id, and deliberately not by session as well. A commit is attributed
   * to a conversation without being that conversation's turn, so "the holder's
   * session is the open one" is true of a commit you walked away from and came
   * back to — and that box has to stay shut, because the daemon refuses a send
   * under any holder. The run id is the only thing that means what is wanted
   * here: the turn on this screen, which is the one you can interrupt rather
   * than the one you must wait for.
   *
   * The cost is a padlock for the length of one fetch when you open a chat whose
   * turn is already running — until the transcript comes back with its
   * `activeRunId` and the box becomes the interrupt. It is not a lie while it is
   * up: nothing could be sent in that moment either.
   */
  const heldElsewhere = holder && holder.runId !== runId ? holder : null

  // The point of the whole conversation pane is that you leave it running and
  // come back. Something has to say when to come back.
  useDoneChime(busy, runId)

  /**
   * The commit run's drafting model, while it is still writing the message.
   *
   * A commit is the one run that streams text without being a chat turn, so the
   * text arriving during it belongs in the box the finished message lands in
   * rather than in the transcript. Null once `commit.drafted` has landed,
   * because that box is now the real one.
   *
   * It reads `commit.drafting` and not "this run has emitted a `commit.step`",
   * which is what it used to do and what a commit outgrew: a failing check now
   * gets one agent turn inside the same run, and the fix's own words were drawn
   * into the message box under the drafter's name.
   */
  const draftingCommit = useMemo<string | null>(() => {
    if (!runId) return null
    const mine = turnEvents.filter((e) => e.runId === runId)
    if (mine.some((e) => e.type === "commit.drafted")) return null
    const drafting = mine.findLast((e) => e.type === "commit.drafting")
    return drafting?.type === "commit.drafting" ? drafting.model : null
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
      busy &&
      runId &&
      draftingCommit === null &&
      (draft.text || draft.thinking || draft.tools.length)
        ? { runId, thinking: typedThinking, text: typedText, tools: draft.tools }
        : null,
    [
      busy,
      runId,
      draftingCommit,
      draft.text,
      draft.thinking,
      draft.tools,
      typedText,
      typedThinking,
    ],
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
  const toBottom = useCallback(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  /** Whether the last line is on screen: what draws the jump button. */
  const [atEnd, setAtEnd] = useState(true)
  /**
   * The same fact, where the follower can read it.
   *
   * A ref as well as state because the follower runs from an observer callback
   * that closes over the render it was made in, and state read there is whatever
   * was true when the observer was attached.
   */
  const following = useRef(true)

  /**
   * Stick to the end while you are at the end, and stay out of the way when you
   * are not.
   *
   * There used to be an unconditional follower here and it was removed, because
   * a transcript that moves while you are dragging a cursor across it cannot be
   * read — the text goes out from under the pointer and the highlight lands
   * somewhere else. Both halves of that survive. Scrolling up at all ends the
   * follow, and being scrolled up is a resting state you can sit in for an hour
   * with a turn writing underneath; and a drag that has selected something
   * pauses it even at the bottom. Where the mouse-up leaves you is then simply
   * where you are — the button comes back rather than the pane jumping and
   * taking the selection you just made off screen with it.
   */
  useEffect(() => {
    const el = scroller.current
    if (!el || !body) return

    let dragging = false
    // A few pixels of slack: at fractional zoom the arithmetic lands half a
    // pixel short of the end, and an exact test would leave the pill on screen
    // for a view that is plainly already at the bottom.
    const read = () => {
      const end = el.scrollHeight - el.scrollTop - el.clientHeight < 24
      following.current = end
      setAtEnd(end)
    }
    // A drag that has actually taken text, which is the only kind worth pausing
    // for. A click is a mouse-down too, and dropping the follow at every click
    // would stop a streaming turn following the first time you opened a tool row
    // to see what it did.
    const selecting = () => {
      const sel = window.getSelection()
      return dragging && !!sel && !sel.isCollapsed
    }
    const follow = () => {
      if (!following.current || selecting()) return
      el.scrollTop = el.scrollHeight
    }
    const down = (e: MouseEvent) => {
      if (e.button === 0) dragging = true
    }
    // On the window, not on the pane: a drag very often ends outside the box it
    // started in, and a mouse-up missed here leaves the follow paused for good.
    const up = () => {
      if (!dragging) return
      dragging = false
      read()
    }

    // In this order, and this is the whole of what makes opening a chat land at
    // the bottom: the rows exist for the first time in this very commit, so
    // reading the position first would find a full-height transcript scrolled to
    // the top and conclude the reader had scrolled up.
    follow()
    read()
    el.addEventListener("scroll", read, { passive: true })
    el.addEventListener("mousedown", down)
    window.addEventListener("mouseup", up)
    // Content growing under a view that is already at the end fires no scroll
    // event, so the follow cannot hang off `scroll` the way the button's state
    // does: a reply streaming in, a tool row opening, a pasted screenshot
    // finishing loading and the pane being dragged narrower are all height
    // changes with no scroll behind them.
    const grow = new ResizeObserver(follow)
    grow.observe(body)
    return () => {
      el.removeEventListener("scroll", read)
      el.removeEventListener("mousedown", down)
      window.removeEventListener("mouseup", up)
      grow.disconnect()
    }
  }, [body])

  /**
   * Opening a chat, and starting a turn, both put you back at the end.
   *
   * A turn starting counts as asking: you pressed send, or pressed commit, and
   * the thing you pressed it for is about to appear down there.
   *
   * `view.events.length` used to be in here as well, and that is the one thing
   * removed rather than kept: it meant a poll picking up a line yanked a reader
   * back down, which is exactly what the follow above is careful not to do.
   * Anything arriving while you are scrolled up is the button's business now.
   */
  useEffect(() => {
    following.current = true
    setAtEnd(true)
    toBottom()
  }, [sessionId, runId, toBottom])

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
          {events.length === 0 && openSessionId && view === null && !error ? (
            <Empty>Reading…</Empty>
          ) : events.length === 0 ? (
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
                events={events}
                onPermission={busy ? answer : undefined}
                live={typing}
                tail={showAll ? undefined : VISIBLE_TAIL}
                // So the question you are under can pin itself to the top edge of
                // this box. It is the only thing in there that needs to know where
                // the box's edge is.
                scroller={scroller}
              >
                {busy && draftingCommit !== null && draft.text ? (
                  <CommitMessageDraft text={draft.text} model={draftingCommit} />
                ) : null}
              </Transcript>
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

      {busy && <WorkingBar events={turnEvents} runId={runId} outputTokens={draft.outputTokens} />}

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
          // Two blocks, and they are held back from different chats.
          //
          // A run somewhere else stops EVERY box, this one included: the daemon
          // takes one turn per project and refuses the rest, so a follow-up to a
          // chat you are reading is refused just as flatly as a new one. That is
          // the half that cannot wait for files to appear — the run is writing
          // them right now — and it is why the padlock is on the lock rather
          // than on what the lock has produced so far.
          //
          // Uncommitted work stops only a chat that has NOT started, because the
          // way out of it is to finish the chat that caused it. Its own turn in
          // flight is exempt too: for its first few seconds it has no session id
          // yet, while its own edits pile up in the tree.
          blocked={
            heldElsewhere
              ? heldBy(heldElsewhere.title)
              : sessionId || busy || uncommitted === 0
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
    </section>
  )
}
