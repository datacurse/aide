import type { TaskStatus } from "@aide/protocol"

/**
 * Status colours follow VS Code's own conventions rather than a fresh scheme:
 * blue for in-progress (progressBar), the git-decoration yellow for "modified,
 * needs your attention", green for settled, red for failed.
 *
 * `committed` borrows gitDecoration.addedResourceForeground — the muted green
 * VS Code uses for staged-but-not-yet-in-history. It reads as adjacent to `done`
 * without claiming to be it, which is exactly the distinction: the work is safe
 * on its branch, and it has not landed.
 */
export const STATUS_STYLE: Record<TaskStatus, { dot: string; text: string; label: string }> = {
  queued: { dot: "bg-fg-dim", text: "text-fg-dim", label: "queued" },
  running: { dot: "bg-info animate-pulse", text: "text-info", label: "running" },
  "needs-review": { dot: "bg-warn", text: "text-warn", label: "needs review" },
  committed: { dot: "bg-diff-add-fg", text: "text-diff-add-fg", label: "committed" },
  done: { dot: "bg-ok", text: "text-ok", label: "done" },
  failed: { dot: "bg-err", text: "text-err", label: "failed" },
  cancelled: { dot: "bg-fg-dim/50", text: "text-fg-dim", label: "cancelled" },
}

export function StatusDot({ status }: { status: TaskStatus }) {
  return <span className={`inline-block size-2 shrink-0 rounded-full ${STATUS_STYLE[status].dot}`} />
}

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

export const money = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`
