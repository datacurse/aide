/**
 * A turn, as one card you decide on rather than a transcript you read.
 *
 * This is the simplified half of the conversation: prompt in, card out, with the
 * full transcript one keystroke behind it. The design constraint that shaped
 * every field is that the bottleneck is REVIEW, not writing — so a card exists
 * to be acted on, and anything that merely describes belongs in the other view.
 *
 * ## What is on it, and where each field comes from
 *
 * Six fields, in a fixed order, because a row that reflows by content cannot be
 * scanned down a column. The first four are deterministic — computed by
 * `reduceCard` off exit codes and git, with no model involved — and the last two
 * are the only model-written things on screen:
 *
 *   state glyph · checks badge · diffstat · headline · next/blocker · age
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
import type { TurnCard } from "@aide/protocol"
import { checkVerdict } from "@aide/protocol"
import { Check, Circle, GitCommit, Lock, Warning, X } from "./icons.js"

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
    <div className="border-b border-line px-3 py-2 last:border-b-0">
      <div className="flex items-baseline gap-2">
        {/* The state, first and always in the same place, so a column of these
            can be read down rather than across. */}
        <Icon className={`size-3 shrink-0 translate-y-0.5 ${tone}`} />

        {/* The checks, straight off exit codes. Absent — not empty — for a turn
            that ran none, which is most of them: a badge on every row would
            spend the card's most valuable pixel saying nothing. */}
        {verdict && (
          <span
            className={`shrink-0 font-sans text-[10px] ${verdict.ok ? "text-ok" : "text-err"}`}
            title={card.checks
              .map((c) => `${c.command} — ${c.skipped ? "skipped" : c.ok ? "passed" : "FAILED"}`)
              .join("\n")}
          >
            {verdict.ok ? `${verdict.ran} green` : `${verdict.failed} failed`}
            {/* Shown, never omitted. A gate that quietly shrinks is
                indistinguishable from one that broke. */}
            {verdict.skipped > 0 && (
              <span className="text-fg-dim"> · {verdict.skipped} skipped</span>
            )}
          </span>
        )}

        {/* What landed. Only for a turn that committed, since that is the only
            time the number is a fact rather than a guess about the tree. */}
        {card.sha && (
          <span className="flex shrink-0 items-center gap-1 font-sans text-[10px] text-fg-muted">
            <GitCommit className="size-3" />
            {card.changed} {card.changed === 1 ? "file" : "files"}
          </span>
        )}

        <span className="ml-auto shrink-0 font-sans text-[10px] text-fg-dim">
          {age(card.startedAt, now)}
        </span>
      </div>

      {/* What was asked, which is what the row is FOUND by. A stack of cards
          showing only answers cannot be scanned for the turn you are thinking
          of — the question is the thing you remember. Clamped to two lines: some
          prompts are three paragraphs, and a card that grows with its input
          stops being a fixed row you can read down a column. */}
      {card.prompt.trim() && (
        <p className="mt-1 line-clamp-2 pl-5 font-sans text-[11px] leading-snug text-fg-muted">
          {card.prompt.trim()}
        </p>
      )}

      {/* The model's own line. Indented to the glyph's text column so the card
          reads as one block rather than as a header and a paragraph. */}
      <div className="mt-1 pl-5">
        {card.summary ? (
          <p className="font-sans text-xs leading-snug text-fg">{card.summary.headline}</p>
        ) : (
          // Degraded on purpose — see the file header. This is what a turn that
          // did not write a closing block looks like, and it is meant to be
          // noticed rather than papered over with the first line of the reply.
          <p className="font-sans text-xs text-fg-dim italic">
            no summary — {label}
          </p>
        )}

        {/* The handover. The one field that turns a description into a decision,
            so it gets the accent and a glyph of its own. */}
        {card.summary?.next && (
          <p className="mt-1 flex items-start gap-1.5 font-sans text-[11px] leading-snug text-accent">
            <Warning className="size-3 shrink-0 translate-y-0.5" />
            {card.summary.next}
          </p>
        )}

        {/* Bounded prose, kept because a fixed schema otherwise loses the "why".
            Dimmer than the headline: it is context for a card you have already
            decided to look at, not part of the scan. */}
        {card.summary?.risk && (
          <p className="mt-1 font-sans text-[11px] leading-snug text-fg-muted">
            {card.summary.risk}
          </p>
        )}

        {onOpen && (
          <button
            type="button"
            onClick={onOpen}
            className="mt-1.5 font-sans text-[10px] text-fg-dim underline underline-offset-2 hover:text-fg"
          >
            read the turn
          </button>
        )}
      </div>
    </div>
  )
}
