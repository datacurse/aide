/**
 * A turn, as one card you decide on rather than a transcript you read.
 *
 * This is the simplified half of the conversation: prompt in, card out, with the
 * full transcript one keystroke behind it. The design constraint that shaped
 * every field is that the bottleneck is REVIEW, not writing — so a card exists
 * to be acted on, and anything that merely describes belongs in the other view.
 *
 * ## Three bands, and the icons are the whole readability argument
 *
 * A card is read top to bottom as three things with different provenance, drawn
 * differently on purpose:
 *
 *   1. the FACTS strip — state, checks, diffstat, age. Small, one line, every
 *      value off an exit code or off git. No model wrote any of it.
 *   2. the QUESTION — what you typed, behind a quote rule. The one line whose
 *      role needs no explaining.
 *   3. the MODEL's fields — what it did, what is next, why, and what to watch —
 *      each opened by its own glyph in a fixed left column.
 *
 * That third band took two passes. The first version stacked four bare
 * paragraphs at one indent, distinguished only by colour, and it was genuinely
 * hard to tell which line was which — a colour code only works on a reader who
 * already knows it. The second named each role in words, which fixed the
 * ambiguity and spent four repeated words per card on furniture. Icons say the
 * same thing in a quarter of the ink and are read as a category rather than
 * parsed as a word; the words survive on each row's `title`, so the legend is a
 * hover away rather than something to memorise.
 *
 * The label column is a FIXED width, not `auto`. `auto` is measured per grid, so
 * a card with a `risk` row and one without would indent differently and the list
 * would ripple as it scrolled.
 *
 * Cost and turn count are deliberately NOT here. They were on the first sketch
 * and they are the two numbers nobody acts on mid-review — the brief already
 * says a cost figure is an estimate never to be trusted, and a card whose every
 * field must change a decision has no room for one that cannot. Both are in the
 * profile, one keystroke away, which is where they were being read anyway.
 *
 * ## Why a missing summary is drawn as missing
 *
 * A turn that writes no closing block gets a visible gap rather than a fallback
 * to the first line of its reply. Falling back is friendlier and hides the parse
 * rate — and this is being built to change behaviour, so for the first stretch
 * the ugly version is the useful one: it says how often the model complies,
 * which is the number that decides whether this whole layer is worth keeping.
 */
import { useEffect, useState, type ReactNode } from "react"
import type { TurnCard } from "@aide/protocol"
import { checkVerdict } from "@aide/protocol"
import {
  ArrowRight,
  Check,
  CheckCircle,
  Circle,
  GitCommit,
  Lightbulb,
  Lock,
  WarningCircle,
  X,
} from "./icons.js"

/**
 * How long ago, in the shortest form that is still true.
 *
 * Minutes for the first hour, then hours, then days. A card is scanned rather
 * than read, so "3h" beats "3 hours ago" and both beat a timestamp — the
 * question this answers is "is this still what I was doing", not "when exactly".
 */
function age(ts: number, now: number): string {
  // A replayed turn has no stamp at all. `sessions.ts` sets `ts: 0` on
  // everything it reads out of the session store, because the SDK's envelope
  // carries no time and ordering is the only temporal information there is — so
  // subtracting from it prints the age of the unix epoch, which is how a card
  // ends up claiming a turn is 20700d old. An empty column is the honest answer.
  if (!ts) return ""
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86_400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86_400)}d`
}

/** `1m 04s` — seconds kept past the minute, because this one is watched. */
function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`
}

/**
 * The glyph, its colour and its label, for each state.
 *
 * A table rather than a chain of ternaries in the markup, because the four
 * states are a vocabulary and the point of a vocabulary is that it is written
 * down once. `blocked` is the red one and outranks everything — see `reduceCard`
 * for why a finished-but-blocked turn is still blocked.
 */
const STATE: Record<
  TurnCard["state"],
  { Icon: typeof Check; tone: string; label: string }
> = {
  blocked: { Icon: Lock, tone: "text-diff-del-fg", label: "needs you" },
  failed: { Icon: X, tone: "text-err", label: "failed" },
  working: { Icon: Circle, tone: "text-accent", label: "working" },
  done: { Icon: Check, tone: "text-ok", label: "done" },
}

export function TurnCardRow({
  card,
  now,
  onOpen,
}: {
  card: TurnCard
  /** Passed in rather than read here, so a list of cards ticks in step. */
  now: number
  /** Opens the detailed view at this turn. */
  onOpen?: () => void
}) {
  const { Icon, tone, label } = STATE[card.state]
  const verdict = checkVerdict(card.checks)

  return (
    // A real card: its own surface, a rounded border, and a WIDTH so lines break
    // at a readable measure instead of running the width of the pane. `max-w`
    // rather than `w`, so a narrow window shrinks it rather than clipping it.
    <article className="mx-auto mb-3 w-full max-w-[46rem] rounded-lg border border-line bg-chrome px-4 py-3 shadow-sm">
      {/* The deterministic strip: everything on this line came off an exit code
          or off git, and none of it was written by a model. It reads as one row
          of small facts rather than as prose, which is what separates it at a
          glance from the block underneath. */}
      <div className="flex items-center gap-2.5">
        {/* The state, with its WORD. A bare glyph asks the reader to know a
            legend nobody gave them — and the four states are the vocabulary the
            whole view sorts by, so they are worth the characters. */}
        <span className={`flex shrink-0 items-center gap-1.5 font-sans text-[11px] ${tone}`}>
          <Icon className="size-3.5" />
          {label}
        </span>

        {verdict && (
          <span
            className="flex shrink-0 items-center gap-1.5 font-sans text-[11px]"
            title={card.checks
              .map((c) => `${c.command} — ${c.skipped ? "skipped" : c.ok ? "passed" : "FAILED"}`)
              .join("\n")}
          >
            <span className="text-fg-dim">checks</span>
            <span className={verdict.ok ? "text-ok" : "text-err"}>
              {verdict.ok ? `${verdict.ran} passed` : `${verdict.failed} failed`}
            </span>
            {/* Shown, never omitted. A gate that quietly shrinks is
                indistinguishable from one that broke. */}
            {verdict.skipped > 0 && (
              <span className="text-fg-dim">· {verdict.skipped} skipped</span>
            )}
          </span>
        )}

        {card.sha && (
          <span className="flex shrink-0 items-center gap-1.5 font-sans text-[11px] text-fg-muted">
            <GitCommit className="size-3.5 text-fg-dim" />
            {card.changed} {card.changed === 1 ? "file" : "files"}
          </span>
        )}

        {/* Empty for a replayed turn, which carries no usable stamp. */}
        {age(card.startedAt, now) && (
          <span className="ml-auto shrink-0 font-sans text-[11px] text-fg-dim">
            {age(card.startedAt, now)}
          </span>
        )}
      </div>

      {/* The question, which is what the row is FOUND by — a stack of cards
          showing only answers cannot be scanned for the turn you are thinking
          of. It gets the quote rule rather than a glyph because it is the one
          line here nobody has to be told the role of: it is what you typed.

          Clamped to two lines. Some prompts are three paragraphs, and a card
          that grows with its input stops being a fixed row you can read down a
          column. */}
      {card.prompt.trim() && (
        <p className="mt-2.5 line-clamp-2 border-l-2 border-line-soft pl-2.5 font-sans text-[13px] leading-snug text-fg-muted">
          {card.prompt.trim()}
        </p>
      )}

      {/* What it is doing RIGHT NOW, for a turn still running. This is the row
          that answers "has it stalled" — see `TurnCard.activity` for why the
          clock is per-STEP rather than for the whole turn. */}
      {card.activity && <LiveStep label={card.activity.label} since={card.activity.since} />}

      <div className="mt-2.5 grid grid-cols-[1.25rem_1fr] gap-x-2.5 gap-y-2">
        {card.summary ? (
          <>
            <Field Icon={CheckCircle} title="what this turn did" tone="text-fg-dim">
              <span className="text-fg">{card.summary.headline}</span>
            </Field>
            {/* The handover: the one field that turns a description into a
                decision, so it is the only one that keeps a colour of its own. */}
            {card.summary.next && (
              <Field Icon={ArrowRight} title="what to do next" tone="text-accent" bodyTone="text-accent">
                {card.summary.next}
              </Field>
            )}
            {card.summary.intent && (
              <Field Icon={Lightbulb} title="why it was done this way" tone="text-fg-dim">
                {card.summary.intent}
              </Field>
            )}
            {/* Bounded prose, kept because a fixed schema otherwise loses the
                "why" — and warm rather than grey, because a risk that reads as
                a footnote is one nobody acts on. */}
            {card.summary.risk && (
              <Field
                Icon={WarningCircle}
                title="what the diff does not show"
                tone="text-warn"
                bodyTone="text-warn"
              >
                {card.summary.risk}
              </Field>
            )}
          </>
        ) : (
          // Degraded on purpose — see the file header. A turn that wrote no
          // block is meant to be noticed rather than papered over with the first
          // line of its reply.
          <Field Icon={CheckCircle} title="this turn wrote no summary" tone="text-fg-dim">
            <span className="text-fg-dim italic">no summary — {label}</span>
          </Field>
        )}
      </div>

      {onOpen && (
        <button
          type="button"
          onClick={onOpen}
          className="mt-2.5 ml-[1.75rem] font-sans text-[11px] text-fg-dim underline underline-offset-2 hover:text-fg"
        >
          read the turn
        </button>
      )}
    </article>
  )
}

/**
 * The live step, with its own clock.
 *
 * Ticks on its own once a second rather than taking `now` from the list: this is
 * the one row on a card that has to move, and driving every card in the list at
 * 1Hz to animate the single running one is a re-render per second of a page that
 * is mostly static.
 *
 * The clock measures the CURRENT STEP, not the turn. That is the whole point —
 * a total that only counts up looks the same whether the agent is working
 * through files or wedged on a call that will never return, whereas a per-step
 * clock that keeps resetting is visible progress and one sitting at 4m is the
 * thing worth interrupting.
 */
function LiveStep({ label, since }: { label: string; since: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  return (
    <div className="mt-2.5 flex items-center gap-2 rounded-md border border-line-soft bg-editor px-2.5 py-1.5">
      {/* The only thing on a card that animates, and it is doing a job: a
          spinner beside a clock says the page is live, so a clock that stops
          moving is the turn being stuck rather than the tab being asleep. */}
      <Circle className="size-3 shrink-0 animate-pulse text-accent" />
      <span className="min-w-0 flex-1 truncate font-sans text-[12px] text-fg">{label}</span>
      {/* Only when the stamp is real. A replayed turn is all `ts: 0` and would
          otherwise print the age of the unix epoch. */}
      {since > 0 && (
        <span className="shrink-0 font-mono text-[11px] text-fg-muted tabular-nums">
          {elapsed(now - since)}
        </span>
      )}
    </div>
  )
}

/**
 * One field of the card: a glyph, then the sentence.
 *
 * Two grid cells rather than a flex row, so every value starts at the same x —
 * a per-row flex would let each line size its own glyph column and the sentences
 * would zigzag down the card, which is most of what made the first version hard
 * to read.
 *
 * `title` carries the field's name in words. The icons are meant to be learned
 * in about two cards, and until they are, hovering is the legend.
 */
function Field({
  Icon,
  title,
  tone,
  bodyTone = "text-fg-muted",
  children,
}: {
  Icon: typeof Check
  title: string
  tone: string
  bodyTone?: string
  children: ReactNode
}) {
  return (
    <>
      <span className={`flex justify-center pt-0.5 ${tone}`} title={title}>
        <Icon className="size-4" />
      </span>
      <span className={`font-sans text-[13px] leading-snug ${bodyTone}`}>{children}</span>
    </>
  )
}
