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
    <button
      type="button"
      title={locked ?? title}
      // `aria-disabled` and a dropped press, not `disabled`. A disabled button
      // takes no pointer events, so its `title` never opens — which is how the
      // one sentence naming what has the repo became the one thing on screen you
      // could not read. Every `locked` here is a sentence written to be read.
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

/**
 * Are you sure?
 *
 * For the few actions that throw work away rather than move it along. Not
 * `window.confirm`: that blocks the whole tab, which on a page whose whole
 * premise is that runs keep going in the background is the wrong thing to do —
 * and it renders in the OS chrome, so the one dialog aide shows would be the one
 * thing on screen that looks nothing like aide.
 *
 * The mounting component owns `open`, so the question is asked by whatever knows
 * what is about to happen and can name it.
 */
export function Confirm({
  title,
  detail,
  confirmLabel = "confirm",
  tone = "danger",
  onConfirm,
  onCancel,
}: {
  title: string
  detail?: string
  confirmLabel?: string
  tone?: "default" | "primary" | "danger"
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    // Escape cancels, and the backdrop is a click target for the same reason:
    // the safe answer has to be the easy one to reach.
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onClick={onCancel}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel()
      }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        // autoFocus so Escape reaches the handler above without a click first.
        autoFocus
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="w-[24rem] max-w-full rounded border border-line bg-chrome p-4 font-sans shadow-lg outline-none"
      >
        <p className="text-[13px] text-fg">{title}</p>
        {detail && <p className="mt-1.5 text-[11px] leading-relaxed text-fg-dim">{detail}</p>}
        <div className="mt-4 flex justify-end gap-1.5">
          <Button onClick={onCancel}>cancel</Button>
          <Button tone={tone} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}

export const money = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`
