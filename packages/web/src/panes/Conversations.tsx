import { useEffect, useMemo, useRef, useState } from "react"
import type { Attachment, ChatOrder, ChatStatus } from "@aide/protocol"
import { born, isImageAttachment, sortChats } from "@aide/protocol"
import { api, type ConversationRow, type LockHolder } from "../api.js"
import { collectAttachments } from "../attachments.js"
import {
  addBacklogChat,
  captureKey,
  discardDraft,
  draftSubject,
  forgetDraftRun,
  idFromKey,
  readDraft,
  saveDraft,
  useDraft,
  useUnstartedChats,
  type Draft,
} from "../drafts.js"
import { Hint } from "../Hint.js"
import { Check, Lock, Play, X } from "../icons.js"
import { ImageViewer, useImageViewer } from "../ImageViewer.js"
import { draftName, useAutoNames } from "../naming.js"
import { Button, Empty, LOCKED, SELECTED } from "../ui.js"
import { useKeyed } from "../useKeyed.js"
import { useAutoGrow } from "../useAutoGrow.js"
import { useRemembered } from "../useRemembered.js"
import { OverlayScroller } from "../OverlayScroller.js"

/**
 * The list of a project's conversations, and the rows in it.
 *
 * The open conversation is `Conversation.tsx` next door — the two were one file
 * of two thousand lines and shared nothing but this import block, twenty-two
 * entries of which turned out to belong to only one of them. What is left here
 * is the list and the formatters its rows print with.
 */

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
  order,
  selected,
  blocked,
  onOpen,
  onStart,
  onDiscard,
}: {
  draft: Draft
  /** Which date the list is sorted by — the row prints that one. */
  order: ChatOrder
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
      {/* What was actually parked, in full. The line above is a name a model
          wrote once the request outgrew the column, so without this there is no
          way to check it against your own words short of opening the chat. */}
      <Hint hint={said || undefined}>
        <button
          type="button"
          onClick={onOpen}
          className="flex min-w-0 flex-1 flex-col gap-0.5 pr-1.5 text-left"
        >
          <span className="truncate text-[13px]">{preview || "New chat"}</span>
          <div className="flex items-baseline gap-2 text-[10px] tabular-nums text-fg-dim">
            {/* First in the line, the column a started chat puts its own time in —
                a parked chat is the same list at an earlier age, and a date that
                moves between the two would be a date you have to hunt for. Which
                date follows the sort, for the same reason `born` gives: printing
                one and ordering by the other reads as a broken sort. */}
            <Hint
              hint={
                draft.updatedAt !== draft.createdAt
                  ? `Parked ${fullDate(draft.createdAt)}\nLast edited ${fullDate(draft.updatedAt)}`
                  : `Parked ${fullDate(draft.createdAt)}`
              }
            >
              <span>{when(order === "activity" ? draft.updatedAt : draft.createdAt)}</span>
            </Hint>
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
      </Hint>
      <Hint hint="Discard this chat">
        <button
          type="button"
          onClick={onDiscard}
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
      </Hint>
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
        <Hint hint={blocked ?? "Start this chat — opens it and sends it"}>
          <button
            type="button"
            // Not `disabled`: the hint is the only place this row can say WHY,
            // and a disabled element emits no `pointerenter`, which is what
            // opens one — so the reason would be unreachable exactly when it is
            // the only thing worth reading. See `Button` in ui.tsx.
            aria-disabled={blocked ? true : undefined}
            onClick={blocked ? undefined : onStart}
            className={`flex size-9 shrink-0 items-center justify-center rounded-sm border ${
              blocked
                ? `border-diff-del-fg/40 ${LOCKED}`
                : "border-line-soft bg-input text-fg-muted hover:border-ok hover:bg-raised hover:text-ok"
            }`}
          >
            {blocked ? <Lock className="size-5" /> : <Play className="size-5" />}
          </button>
        </Hint>
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
  // Indexed over the pictures alone, so paging with the arrow keys cannot land
  // on an attachment that has nothing to draw. See the composer, which does the
  // same thing over the same shape of row.
  const pictures = attachments.filter(isImageAttachment)
  const viewer = useImageViewer()

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

  // Any file, the same as the composer — the two boxes share `collectAttachments`
  // so what may be parked and what may be sent cannot drift apart.
  const takeFiles = async (files: FileList | File[]) => {
    const { added, skipped } = await collectAttachments(files)
    if (skipped) setNote(`${skipped} file(s) too large, skipped`)
    if (added.length === 0) return
    // Re-read the box rather than trusting what this closure captured: decoding
    // is async, so anything typed — or a second file pasted — while it ran
    // would be overwritten by the stale copy.
    const now = readDraft(key)
    saveDraft(key, { text: now.text, attachments: [...now.attachments, ...added] })
  }

  return (
    <div
      className="shrink-0 border-b border-line bg-editor p-2"
      // A drop target on the same terms as the composer's bar: preventDefault
      // on dragOver is what permits the drop; without it the browser navigates
      // to the file and takes the whole app with it.
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault()
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return
        e.preventDefault()
        void takeFiles(e.dataTransfer.files)
      }}
    >
      {attachments.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {attachments.map((a) => {
            // The chip was one button that removed the whole attachment, with
            // no thumbnail — so a parked idea with two screenshots in it read as
            // two rows saying "image", and the only thing you could do to either
            // was throw it away. It splits the same way the composer's does: the
            // picture opens, the ✕ removes, and neither is nested inside the
            // other (a button inside a button is dropped by the browser).
            const seat = pictures.findIndex((p) => p.id === a.id)
            return (
              <span
                key={a.id}
                className="inline-flex items-center gap-1 rounded border border-line-soft px-1.5 py-0.5 font-sans text-[10px] text-fg-dim"
              >
                {seat >= 0 && (
                  <Hint hint="See what this is, full size">
                    <button
                      type="button"
                      onClick={() => viewer.show(seat)}
                      className="cursor-zoom-in"
                    >
                      <img
                        src={`data:${a.mediaType};base64,${a.data}`}
                        alt=""
                        className="size-3.5 rounded-sm object-cover"
                      />
                    </button>
                  </Hint>
                )}
                <span className="max-w-32 truncate">{a.name ?? "image"}</span>
                <Hint hint="Remove this attachment">
                  <button
                    type="button"
                    onClick={() => edit({ attachments: attachments.filter((x) => x.id !== a.id) })}
                    className="hover:text-err"
                  >
                    <X className="size-2.5" />
                  </button>
                </Hint>
              </span>
            )
          })}
        </div>
      )}
      {viewer.open !== null && (
        <ImageViewer
          images={pictures}
          index={viewer.open}
          onIndex={viewer.show}
          onClose={viewer.close}
        />
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
          if (files.length) {
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
      {/*
        `rounded-full`, and this is the whole bug that made the first version a
        propeller. A SQUARE that spins does not stay inside its own box: every
        corner sweeps a circle of radius half the diagonal, so a 38px rounded-rect
        traced a ~54px arc swinging well outside the 36px button and past the row.
        Only a circle is invariant under rotation, so only a circle can spin in
        place. `inset-0.5` keeps that circle inscribed in the square rather than
        touching its corners.

        The tick underneath is `hidden` rather than transparent, so this is
        centred by the flex row on its own — see `DoneCheck`.
      */}
      <span className="pointer-events-none absolute inset-0.5 animate-spin rounded-full border-2 border-info/70 border-t-transparent border-r-transparent" />
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
    // 11px, not the 9px this started at. 9px inside the ring is a speck with a
    // wide moat around it — the arc reads and the number does not, which wastes
    // the whole reason the count sits in the middle rather than out on the meta
    // line. `12m` is the widest string it can hold: the ring is a ~32px circle
    // inscribed in the 36px square, leaving ~26px of clear width inside its
    // 2px stroke, and three characters at this size sit just inside that.
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
    <Hint
      hint={
        working
          ? HAS_THE_REPO(heldSince)
          : ranLast
            ? `The most recent run in this project happened here — the row you probably want next.\n\n${done ? "Served its purpose. Click to reopen it." : "Click to mark this chat done."}`
            : done
              ? "Served its purpose. Click to reopen it."
              : "Mark this chat done"
      }
    >
      <button
        type="button"
        onClick={onToggle}
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
        {/* `hidden`, not `opacity-0`. An invisible tick is still a 20px flex item,
            so the row centred the PAIR of it and the elapsed count — which put the
            number visibly right of the dial it is supposed to sit in the middle of.
            The square's own size is fixed either way, so taking the tick out of the
            layout costs nothing and is what lets the digits centre. */}
        <Check className={`size-5 ${working ? "hidden" : ""}`} />
        {working && <RunDial since={heldSince} />}
      </button>
    </Hint>
  )
}

/**
 * The line between what still wants something from you and what does not.
 *
 * Drawn only when there is something on both sides of it. With one side empty a
 * heading is not telling two groups apart, it is a label on the only list there
 * is — and a 320px column has no room for a word that says nothing.
 *
 * Given `onToggle`, the heading is also the button that folds its group. The
 * button is not a second control beside the label because the label already IS
 * the group's one line — the count stays readable while the rows are gone, so
 * folding hides the pile without hiding the fact that there is one. The word on
 * the right says which way the next press goes, always drawn rather than on
 * hover: a heading that is secretly a button is a button nobody presses.
 */
function GroupLabel({
  label,
  count,
  ruled,
  folded,
  onToggle,
}: {
  label: string
  count: number
  ruled?: boolean
  /** The group's rows are hidden; the heading is all that is left of it. */
  folded?: boolean
  onToggle?: () => void
}) {
  const line = (
    <>
      <span>{label}</span>
      <span className="font-normal normal-case tracking-normal tabular-nums">{count}</span>
    </>
  )
  const base = `flex items-baseline gap-1.5 px-3 pt-2 pb-1 font-sans text-[10px] font-semibold tracking-wide text-fg-dim uppercase ${
    ruled ? "mt-1 border-t border-line" : ""
  }`
  if (!onToggle) return <div className={base}>{line}</div>
  return (
    <Hint
      hint={
        folded
          ? `${count} archived chat${count === 1 ? "" : "s"} hidden. Click to show them.`
          : "Hide the archived chats. The heading and the count stay."
      }
    >
      <button
        type="button"
        onClick={onToggle}
        className={`${base} w-full text-left hover:text-fg-muted`}
      >
        {line}
        <span className="ml-auto font-normal normal-case tracking-normal">
          {folded ? "show" : "hide"}
        </span>
      </button>
    </Hint>
  )
}

/**
 * Which date the list is ordered by: started, or last spoken to.
 *
 * Two words, not a dropdown — there are exactly two orders and `ChatOrder` is a
 * closed type, so a menu would be furniture around a toggle. The active word is
 * underlined rather than the inactive ones hidden, because a control showing
 * only the current state reads as a label; both choices visible is what says
 * there is a choice.
 *
 * Styled as the group headings are: this is the same kind of line — a fact
 * about how the list below is arranged, not a row in it.
 */
function OrderPicker({
  order,
  onChange,
}: {
  order: ChatOrder
  onChange: (next: ChatOrder) => void
}) {
  const opt = (value: ChatOrder, label: string, hint: string) => (
    <Hint hint={hint}>
      <button
        type="button"
        onClick={() => onChange(value)}
        className={`font-normal normal-case tracking-normal ${
          order === value ? "text-fg-muted underline underline-offset-2" : "hover:text-fg-muted"
        }`}
      >
        {label}
      </button>
    </Hint>
  )
  return (
    <div className="flex items-baseline gap-2 border-b border-line px-3 py-1 font-sans text-[10px] font-semibold tracking-wide text-fg-dim uppercase">
      <span>order</span>
      {opt(
        "created",
        "created",
        "Newest chat first, by when it was started. Speaking to a chat does not move its row, so the position you learned for one stays learned.",
      )}
      {opt(
        "activity",
        "activity",
        "Most recently spoken-to first. The chat that just answered is the top row — and rows move when you speak to them.",
      )}
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
  order,
  status,
  heldSince,
  ranLast,
  selected,
  onOpen,
  onToggleDone,
}: {
  chat: ConversationRow
  /** Which date the list is sorted by — the row prints that one. */
  order: ChatOrder
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
      <Hint hint={chat.gitBranch ? `${chat.cwd} · ${chat.gitBranch}` : chat.cwd}>
        <button
          type="button"
          onClick={onOpen}
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
            <Hint hint={dateTitle(chat)}>
              <span>{when(order === "activity" ? chat.lastModified : born(chat))}</span>
            </Hint>
            {spend && spend.activeMs > 0 && (
              <>
                <Dot />
                <Hint hint={WORKING_TIME(spend.turns)}>
                  <span>{dur(spend.activeMs)}</span>
                </Hint>
              </>
            )}
            {spend && spend.costUsd > 0 && (
              <>
                <Dot />
                <Hint hint={COST_IS_AN_ESTIMATE}>
                  <span>{money(spend.costUsd)}</span>
                </Hint>
              </>
            )}
            {spend && spend.usageShare > 0 && (
              <>
                <Dot />
                <Hint hint={USAGE_SHARE(spend.tokens)}>
                  <span>{share(spend.usageShare)}</span>
                </Hint>
              </>
            )}
          </div>
        </button>
      </Hint>
      {/* On `done`, not on `closed`: `closed` is a derivation that running
          outranks, and the box is the bit's own control. They used to differ on
          a ticked chat with a turn in flight — the box drew empty over a
          conversation you had plainly ticked. That case is gone from the other
          end now: a send into a ticked chat unticks it, so `done` is genuinely
          false there and an empty box is the truth rather than a display bug. */}
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
 * The row prints whichever date the list is ordered by — started under the
 * default order, last spoken to under activity — because printing one and
 * sorting by the other gives a list whose visible timestamps read as a broken
 * sort. Both dates are always here, so whichever one the row is not printing
 * is a hover away rather than dropped; the last-active one is the half that
 * answers "did my question go through", and it is a second line rather than a
 * second column because 320px was already full.
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
 * nothing is running in it, whatever the row was told earlier.
 *
 * `done` used to be taken from the row as fetched, on the grounds that a human
 * sets it and setting it refetches. That stopped being the whole story when
 * sending into a ticked-off chat began UNTICKING it daemon-side: the row was
 * fetched before the send, so it goes on carrying `done: true` for the length of
 * the turn, and the box beside it draws a tick over a bit the daemon has already
 * cleared. Nothing refetches during a turn, so it is cleared here from the same
 * poll that already answers "is it running" — a chat with a turn in flight is
 * one somebody has just asked for more, which is exactly the condition the
 * untick fires on.
 *
 * The reconstruction is `chatStatuses`' own rule, in the same order: running
 * outranks done — which now agrees with `done` rather than overriding it, since
 * the send that made it run is the send that cleared the tick.
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
    done: running ? false : status.done,
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
   * The one row you almost always want next, and under the default order the
   * list is deliberately no help in finding it: `sortChats` orders by when a
   * chat STARTED and refuses to reorder on activity unless asked, so the
   * conversation that just answered you is wherever you first parked it — three
   * screens down, beside whatever else you started that morning. Until this,
   * the only thing pointing at it was the run mark, which goes out with the
   * run: the one pointer to the row disappeared at exactly the moment there was
   * finally something to read. (The activity order surfaces that row by
   * position too, but the mark stays: it is what says WHY the row is on top.)
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
   * Which date the list is ordered by. One preference for the app rather than
   * one per project, on the fold's own reasoning: this is a way of reading the
   * list, and a preference you set once should not have to be re-set in every
   * project you visit.
   */
  const [order, setOrder] = useRemembered<ChatOrder>(
    "aide.chats.order",
    "created",
    (v): v is ChatOrder => v === "created" || v === "activity",
  )

  /**
   * Every row this project has, in one order: newest first, whatever each one is
   * doing. See `sortChats` — under the default order a chat you park has to
   * appear where you are looking, and under `activity` the chat that just
   * answered is the top row.
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
      sortChats(
        [
          ...unstarted.map(
            (d): ListRow => ({
              kind: "draft",
              draft: d,
              status: PARKED,
              createdAt: d.createdAt,
              // The activity key, as well as the fallback: a parked chat's last
              // activity is the last time its words were edited.
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
        ],
        order,
      ),
    [unstarted, items, holdingSession, holderBlocked, order],
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
  /**
   * Whether the archived group is folded to its heading.
   *
   * One preference for the app, not one per project: this is a way of reading
   * the list, like the typewriter, and a preference you set once should not
   * have to be re-set in every project you visit.
   *
   * The heading survives one case the `split` rule would drop it in: a project
   * whose every chat is archived, with the fold on. No heading there means the
   * rows vanish with nothing left to press — a hidden group whose only control
   * went with it — so the fold keeps its own heading even when it is the only
   * group in the list.
   */
  const [hideArchived, setHideArchived] = useRemembered(
    "aide.chats.hideArchived",
    false,
    (v): v is boolean => typeof v === "boolean",
  )
  const archivedHeading = archived.length > 0 && (stillOpen.length > 0 || hideArchived)

  const render = (row: ListRow) =>
    row.kind === "draft" ? (
      <UnstartedRow
        key={row.draft.key}
        draft={row.draft}
        order={order}
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
        order={order}
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
      {/* Only once there are two rows to order. On an empty or one-row list the
          two orders agree, so the control would be a line spent saying nothing
          — the same rule the group headings live by. */}
      {rows.length > 1 && <OrderPicker order={order} onChange={setOrder} />}
      {/* Overlaid rather than native, because folding the archived group
          usually takes the scrollbar with it: with a classic bar every row got
          10px wider on the press, and reserving the gutter instead left a
          permanent stripe of nothing. The rows are full width either way now,
          and the bar floats over them only while there is something to scroll. */}
      {/* pr-1.5: the rows' own pr-2 ends 8px from the edge, 2px short of the
          floating 10px thumb — this puts their buttons clear of it. */}
      <OverlayScroller className="flex-1" contentClassName="py-1 pr-1.5">
        {items === null && rows.length === 0 && <Empty>Reading the session store…</Empty>}
        {items !== null && rows.length === 0 && (
          <Empty>
            Nothing here yet. Type what you want above, or press new. Chats from Claude Code and
            the VS Code extension appear here too.
          </Empty>
        )}
        {split && <GroupLabel label="open" count={stillOpen.length} />}
        {stillOpen.map(render)}
        {archivedHeading && (
          <GroupLabel
            label="archived"
            count={archived.length}
            // No rule when there is nothing above it to be ruled off from.
            ruled={stillOpen.length > 0}
            folded={hideArchived}
            onToggle={() => setHideArchived(!hideArchived)}
          />
        )}
        {!hideArchived && archived.map(render)}
      </OverlayScroller>
    </div>
  )
}
