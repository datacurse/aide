import { useEffect, useState } from "react"
import { api, type PlanUsage } from "./api.js"
import type { UsageWindow } from "@aide/protocol"

/**
 * Slower than everything else the page polls, on purpose.
 *
 * A cold reading opens a session with the CLI and takes a second or so, and the
 * daemon holds one for a minute after that. A window that takes five hours to
 * fill has not moved in less time than this, and the countdown beside it is
 * rounded to the minute anyway.
 */
const POLL_MS = 60_000

/**
 * What is left of the plan, and when it comes back.
 *
 * Sits under the daemon's own line because it answers the same question that
 * line does — whether the next thing you ask for can actually happen. It is the
 * only figure in aide that is not aide's: a plan window is measured across every
 * client on the account, so it moves while aide sits idle, and it is unrelated
 * to the dollar estimates on the chat rows.
 *
 * Renders nothing at all when there are no windows — an API key is billed rather
 * than metered, and a rail should not carry a row that says "not applicable".
 */
export function PlanUsageMeter({ enabled }: { enabled: boolean }) {
  const [usage, setUsage] = useState<PlanUsage | null>(null)

  useEffect(() => {
    if (!enabled) return
    let live = true
    const load = () => {
      void api
        .usage()
        .then((next) => {
          if (live) setUsage(next)
        })
        // Keep the last reading rather than blanking. A daemon restart makes
        // this fail for a couple of seconds, and a meter that empties itself
        // every time reads as "you are out" — the one wrong thing it could say.
        .catch(() => {})
    }
    load()
    const timer = setInterval(load, POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [enabled])

  if (!usage?.available || usage.windows.length === 0) return null

  return (
    <div className="flex flex-col gap-1">
      <span
        className="truncate text-[11px] text-fg-dim"
        title={`Windows on your Claude ${usage.plan ?? ""} plan, as a share still unspent. Read ${readAt(usage.readAt)}.`}
      >
        {usage.plan ? `${usage.plan} plan` : "plan"} · usage left
      </span>
      {usage.windows.map((w) => (
        <Meter key={w.id} window={w} />
      ))}
    </div>
  )
}

function Meter({ window: w }: { window: UsageWindow }) {
  const left = 100 - w.used
  return (
    // Tabular figures and fixed columns for the same reason the chat rows have
    // them: three of these are read down, not across, and a percentage that
    // shuffles sideways between rows cannot be compared at a glance.
    <div className="flex items-center gap-1.5 text-[10px] tabular-nums" title={hover(w)}>
      <span className="w-8 shrink-0 truncate text-fg-dim">{w.label}</span>
      <span className="h-1 min-w-4 flex-1 rounded-full bg-input">
        {/* The bar drains rather than fills. It is showing what is LEFT — the
            number beside it says so too, and the two must not disagree. */}
        <span className={`block h-1 rounded-full ${tone(left)}`} style={{ width: `${left}%` }} />
      </span>
      <span className="w-7 shrink-0 text-right text-fg-muted">{left}%</span>
      <span className="w-9 shrink-0 truncate text-right text-fg-dim">
        {w.resetsAt === null ? "" : until(w.resetsAt)}
      </span>
    </div>
  )
}

/** Green while there is room, amber when it is worth knowing, red near the end. */
const tone = (left: number) => (left <= 10 ? "bg-err" : left <= 25 ? "bg-warn" : "bg-ok/70")

/**
 * Time to the reset, in the width of a rail column.
 *
 * "due" rather than a negative: the reading is up to a minute old, so a window
 * whose reset has just passed shows as due until the next poll confirms it.
 */
function until(at: number): string {
  const s = Math.round((at - Date.now()) / 1000)
  if (s <= 0) return "due"
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h${String(m % 60).padStart(2, "0")}m`
  return `${Math.floor(h / 24)}d${h % 24}h`
}

/** The daemon writes the sentence about the window; this adds the reset to it. */
function hover(w: UsageWindow): string {
  if (w.resetsAt === null) return w.detail
  return `${w.detail} Resets ${new Date(w.resetsAt).toLocaleString()}.`
}

function readAt(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000)
  return s < 90 ? "just now" : `${Math.round(s / 60)} minutes ago`
}
