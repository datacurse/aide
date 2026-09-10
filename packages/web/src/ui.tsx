import { Hint } from "./Hint.js"
import { Lock } from "./icons.js"

/**
 * How a control that something else is holding is drawn.
 *
 * Red, and at full strength. The state this marks is not "there is nothing here"
 * — it is "this is the thing in your way", which is what you are looking for
 * when you press a dead button, so it has to be the most legible control on
 * screen rather than the least. Fading to 40% said the opposite, and said it in
 * the same grey as a button that is merely empty.
 *
 * gitDecoration.deletedResourceForeground rather than errorForeground: #f14c4c
 * is the colour of something that broke, and nothing here has. A run holding the
 * checkout is a wait — this is the darker, flatter red of a refusal.
 *
 * Exported because two controls that are not `Button` wear it too: the ▶ on a
 * parked chat and the composer's send. One plate, so a locked control looks the
 * same wherever you meet it.
 */
export const LOCKED = "cursor-not-allowed bg-diff-del-fg/15 text-diff-del-fg"

/**
 * What a control says when a run has the project, wherever it is drawn.
 *
 * Beside the plate rather than at each control it stops, for the same reason the
 * plate is: one condition worded four ways reads as four conditions. It stops
 * `new`, the ▶ on a parked row, `commit`, and the composer — and those said
 * "has this checkout", "has the repo right now", and, on the composer, nothing
 * at all. The last is what this is really for: a lock the daemon enforces on
 * every send, which the box in front of you did not mention until the send came
 * back red.
 */
export const heldBy = (title: string) =>
  `"${title}" is working in this checkout. Wait for it to finish, or stop it.`

/**
 * How the row you have open is drawn, in every list there is: a frame, not a
 * fill. `list.focusOutline`, which is the key VS Code draws this with.
 *
 * A filled plate is a second background, and a row is not a blank surface —
 * every colour it carries was picked against the list's near-black. Over the
 * selection navy they all came apart at once: the red padlock rang against it,
 * the green tick and the blue "has the repo" stopped reading (blue text on a
 * blue plate), and the grey button plates turned to smudges. The fix was six
 * selected-only variants that repainted each of them white — a second palette,
 * maintained forever, so that one row could have a background. A frame leaves
 * every one of those colours on the surface it was chosen for.
 *
 * It also lets the marks compose rather than fight. The row that ran last is
 * often the row you are in, and as two fills that was a contest one of them had
 * to win. That fact is now an outline on the chat row's own button rather than a
 * wash across it — a border inside a frame cannot contest anything — but the
 * argument is unchanged for the next mark that wants a background.
 *
 * Hover keeps the grey wash it always had, and that is now the whole difference
 * between them: hover fills, selection frames. Two languages, so neither can be
 * mistaken for the other as the pointer crosses the list.
 *
 * The 1px is paid for by every row — `border border-transparent` on the ones
 * that are not selected — or the column of titles steps sideways as you move.
 */
export const SELECTED = "border-accent"

export function Button({
  children,
  onClick,
  disabled,
  locked = null,
  tone = "default",
  title,
}: {
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  /**
   * Why something else is holding this control, or null when it is yours to
   * press. Distinct from `disabled`, which is for a button with nothing to do —
   * no project selected, nothing to copy, a request already in flight. A lock
   * has a holder and a sentence naming it; those have neither.
   */
  locked?: string | null
  tone?: "default" | "primary" | "danger"
  title?: string
}) {
  // button.secondaryBackground / button.background / a red drawn from
  // gitDecoration.deletedResourceForeground.
  const tones = {
    default: "bg-input text-fg hover:bg-raised",
    primary: "bg-accent text-white hover:bg-accent-hover",
    danger: "bg-diff-del-fg/85 text-white hover:bg-diff-del-fg",
  }
  return (
    <Hint hint={locked ?? title}>
      <button
        type="button"
        // `aria-disabled` and a dropped press, not `disabled`. A disabled button
        // takes no pointer events, so nothing hovering it ever fires — which is
        // how the one sentence naming what has the repo became the one thing on
        // screen you could not read. Every `locked` here is a sentence written
        // to be read. Still true now the hint is aide's own: `Hint` opens on
        // `pointerenter`, which a disabled button does not emit either.
        aria-disabled={locked ? true : undefined}
        onClick={locked ? undefined : onClick}
        disabled={locked ? undefined : disabled}
        className={`inline-flex items-center gap-1 rounded-sm px-2.5 py-1 text-xs transition-colors outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40 ${
          locked ? LOCKED : tones[tone]
        }`}
      >
        {locked && <Lock className="size-3 shrink-0" />}
        {children}
      </button>
    </Hint>
  )
}

export function PaneHeader({
  title,
  children,
}: {
  title: string
  children?: React.ReactNode
}) {
  return (
    <div className="flex h-9 shrink-0 items-center justify-between border-b border-line px-3">
      <h2 className="font-sans text-[11px] font-semibold tracking-wide text-fg-muted uppercase">
        {title}
      </h2>
      <div className="flex items-center gap-1.5">{children}</div>
    </div>
  )
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center font-sans text-xs leading-relaxed text-fg-dim">
      {children}
    </div>
  )
}

export const money = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`
