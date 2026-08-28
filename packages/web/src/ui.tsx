export function Button({
  children,
  onClick,
  disabled,
  tone = "default",
  title,
}: {
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
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
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-sm px-2.5 py-1 text-xs transition-colors outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40 ${tones[tone]}`}
    >
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
