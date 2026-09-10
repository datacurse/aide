import { useEffect, useId, useMemo, useRef, useState } from "react"
import { buildTimeline, looksOnly, type TimelineCall, type TimelineRow } from "@aide/protocol"

/**
 * A turn's tool calls as a grid: one row per thing touched, one column per
 * assistant message — a model round trip, which is the latency metric the flat
 * list could never show. Ten calls in one column cost one round trip; ten
 * columns of one call cost ten. Failures are red; the round trips spent
 * redoing them are tinted AMBER, not red, because recovery is cost rather
 * than failure — the retry usually SUCCEEDS, and a red wash under a green dot
 * read as the grid contradicting itself. The transcript behind `show N steps`
 * is unchanged — clicking a dot opens it at that call.
 *
 * Everything derived is `buildTimeline` in protocol, where `pnpm smoke` pins
 * it; this file only draws. The one rule enforced here is the spec's: a column
 * exists only once the model has actually sent the message — live calls come
 * in as spinner dots on the column the streaming message will become, and
 * nothing queued or predicted is ever drawn.
 */

/** Dot diameter. 1.5× the original 10px, because these are CLICK TARGETS. */
const DOT = 15
/** The gap between parallel calls in one cell. */
const GAP = 3

/** Column width for n dots side by side; 24px floor so header numbers align. */
const colWidth = (n: number): number => Math.max(24, n * DOT + (n - 1) * GAP + 10)

/**
 * The row connector, one SVG per cell: a half-opacity 2px line that SWELLS
 * into each dot with tangent curves, fading up to that dot's OWN colour.
 *
 * Drawn, because rectangles could not say this. The first version was a grey
 * hairline (disconnected from the dots it joined), the second a rounded pill
 * under each dot (which poked past the row's end dots — a stadium shape has
 * no way to stop AT a circle). A path can: each swell rises from line
 * thickness to just under the dot's radius with horizontal tangents at both
 * ends, and an endpoint dot simply gets no swell on its outer side. SVG
 * rather than canvas for the same result: crisp at any zoom, no resize or
 * repaint plumbing, and the dots stay HTML — focusable, hoverable, clickable.
 *
 * Each half-swell is its own gradient, and the gradient is doing two jobs.
 * The line runs at half opacity so the PATH reads apart from the NODES, and
 * the swell fades from that back to full — the line genuinely dissolves into
 * the dot rather than butting against it. And the far stop takes the dot's
 * colour, so the approach to a failed call shades green into red along the
 * way: the transition lives in the connector, not on a hard edge.
 *
 * Geometry mirrors the HTML dots exactly — `DOT` on `GAP`, centred; the
 * swell peaks half a pixel under the dot's radius so its seam is always
 * covered, ring dots included.
 */
function Connector({
  gid,
  w,
  xs,
  reds,
  from,
  to,
}: {
  /** Unique per cell — gradient ids are document-global. */
  gid: string
  w: number
  xs: number[]
  /** Which dots are failures, so their swell can shade into red. */
  reds: boolean[]
  from: number
  to: number
}) {
  const y = 12 // half the 24px row
  const t = 1 // half the line's thickness
  const r = DOT / 2 - 0.5 // the swell's peak, just under the dot's radius
  const lead = 10 // how far out a swell begins
  const halves: { key: string; d: string; x1: number; x2: number; red: boolean }[] = []
  xs.forEach((x, i) => {
    const red = reds[i] === true
    // A half-swell only where the line actually continues on that side — the
    // outermost dots end the shape instead of wearing a stub past the row.
    if (x > from + 0.5) {
      halves.push({
        key: `l${i}`,
        d:
          `M ${x - lead} ${y - t} C ${x - lead + 4} ${y - t} ${x - r - 1} ${y - r} ${x} ${y - r} ` +
          `L ${x} ${y + r} C ${x - r - 1} ${y + r} ${x - lead + 4} ${y + t} ${x - lead} ${y + t} Z`,
        x1: x - lead,
        x2: x,
        red,
      })
    }
    if (x < to - 0.5) {
      halves.push({
        key: `r${i}`,
        d:
          `M ${x + lead} ${y - t} C ${x + lead - 4} ${y - t} ${x + r + 1} ${y - r} ${x} ${y - r} ` +
          `L ${x} ${y + r} C ${x + r + 1} ${y + r} ${x + lead - 4} ${y + t} ${x + lead} ${y + t} Z`,
        x1: x + lead,
        x2: x,
        red,
      })
    }
  })
  return (
    <svg aria-hidden="true" width={w} height={24} className="pointer-events-none absolute inset-0">
      <defs>
        {halves.map((h) => (
          <linearGradient
            key={h.key}
            id={`${gid}${h.key}`}
            gradientUnits="userSpaceOnUse"
            x1={h.x1}
            y1={0}
            x2={h.x2}
            y2={0}
          >
            <stop offset="0" style={{ stopColor: "var(--color-ok)" }} stopOpacity={0.5} />
            <stop
              offset="1"
              style={{ stopColor: h.red ? "var(--color-err)" : "var(--color-ok)" }}
            />
          </linearGradient>
        ))}
      </defs>
      <path
        d={`M ${from} ${y - t} L ${to} ${y - t} L ${to} ${y + t} L ${from} ${y + t} Z`}
        style={{ fill: "var(--color-ok)" }}
        fillOpacity={0.5}
      />
      {halves.map((h) => (
        <path key={h.key} d={h.d} fill={`url(#${gid}${h.key})`} />
      ))}
    </svg>
  )
}

/** File rows show their tail; `search`, `shell` and friends are already short. */
const shortLabel = (r: TimelineRow): string =>
  r.sys ? r.label : r.label.split(/[/\\]/).slice(-2).join("/")

function Dot({
  call,
  selected,
  onPick,
}: {
  call: TimelineCall
  selected: boolean
  onPick: () => void
}) {
  const looked = call.status !== "err" && call.status !== "busy" && looksOnly(call.tool)
  const shape =
    call.status === "busy"
      ? "border-2 border-info border-t-transparent bg-editor animate-spin"
      : call.status === "err"
        ? "bg-err"
        : looked
          ? // Opaque background, not transparent: the row's connecting line
            // runs behind the dots, and a see-through ring would draw it
            // straight through its own middle.
            "border-2 border-ok bg-editor"
          : "bg-ok"
  const state =
    call.status === "err"
      ? `failed${call.failTag ? `: ${call.failTag}` : ""}`
      : call.status === "busy"
        ? "running"
        : "ok"
  return (
    <span className="group relative">
      {/* The classified reason, directly above the dot, on hover or focus.
          The scroll container carries top headroom so this never clips. */}
      {call.failTag && (
        <span className="pointer-events-none absolute -top-[17px] left-1/2 z-10 -translate-x-1/2 text-[10px] whitespace-nowrap text-err opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          {call.failTag}
        </span>
      )}
      <span
        role="button"
        tabIndex={0}
        aria-label={`${call.tool} ${call.target}, message ${call.message}, ${state}`}
        title={`${call.tool} ${call.target}`.trim()}
        onClick={onPick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            onPick()
          }
        }}
        className={`block size-[15px] cursor-pointer rounded-full focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-info ${shape} ${
          selected ? "outline-2 outline-offset-1 outline-fg" : ""
        }`}
      />
    </span>
  )
}

export function ToolTimeline({
  calls,
  live = false,
  selected = null,
  onSelect,
}: {
  calls: TimelineCall[]
  /** The turn is still running, so between messages the model is composing. */
  live?: boolean
  /**
   * Which call's card is open below the grid. Held by the CALLER, because the
   * caller owns the card and a second copy of "which call" here is the one
   * that would disagree with it.
   */
  selected?: string | null
  /** A dot was clicked; null means the selected dot was clicked again. */
  onSelect?: (id: string | null) => void
}) {
  const t = useMemo(() => buildTimeline(calls), [calls])
  /**
   * The turn is running and no call is open: the model is thinking, or writing
   * the message that will become the next column. Without a mark for it, a
   * grid whose last column has settled is indistinguishable from a stale one —
   * so the next header slot gets a spinner instead of a number. It draws no
   * dot and claims no call; the moment one opens, its own spinner takes over
   * and this disappears.
   */
  const composing = live && !calls.some((c) => c.status === "busy")
  const [hover, setHover] = useState<number | null>(null)
  // Gradient ids are document-global and a page draws one grid per turn, so
  // every cell's defs get a prefix unique to this instance. Stripped to
  // alphanumerics because the raw useId contains colons, which are legal in
  // an id and unreliable inside a `url(#…)` reference.
  const gid = useId().replace(/[^a-zA-Z0-9]/g, "")
  const wrap = useRef<HTMLDivElement>(null)
  const strip = useRef<HTMLDivElement>(null)
  /**
   * Keep the newest column in view while the turn streams — until the human
   * scrolls back, in which case stop following until they return to the end.
   * A ref, not state: which way it points must never itself cause a render.
   */
  const follow = useRef(true)
  /** The strip's viewport window, as fractions. Null while the grid fits. */
  const [win, setWin] = useState<{ left: number; width: number } | null>(null)

  const cells = useMemo(() => {
    // row key -> message -> calls, plus per-column dot maxima for the widths.
    const grid = new Map<string, Map<number, TimelineCall[]>>()
    const widest = new Map<number, number>()
    for (const r of t.rows) {
      const byMsg = new Map<number, TimelineCall[]>()
      for (const c of r.calls) {
        const list = byMsg.get(c.message)
        if (list) list.push(c)
        else byMsg.set(c.message, [c])
      }
      for (const [m, list] of byMsg) widest.set(m, Math.max(widest.get(m) ?? 0, list.length))
      grid.set(r.key, byMsg)
    }
    const widths = new Map<number, number>()
    for (const m of t.messages) widths.set(m, colWidth(widest.get(m) ?? 0))
    const busy = new Set<number>()
    for (const r of t.rows) for (const c of r.calls) if (c.status === "busy") busy.add(c.message)
    return { grid, widths, busy }
  }, [t])

  const measure = () => {
    const el = wrap.current
    if (!el) return
    if (el.scrollWidth <= el.clientWidth + 1) {
      setWin(null)
      return
    }
    setWin({ left: el.scrollLeft / el.scrollWidth, width: el.clientWidth / el.scrollWidth })
  }

  // After each change: follow the newest column if nobody scrolled away, and
  // re-decide whether the overview strip is needed at all.
  useEffect(() => {
    const el = wrap.current
    if (el && follow.current) el.scrollLeft = el.scrollWidth
    measure()
  }, [t])
  useEffect(() => {
    const onResize = () => measure()
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])

  const seek = (clientX: number) => {
    const el = wrap.current
    const st = strip.current
    if (!el || !st) return
    const r = st.getBoundingClientRect()
    el.scrollLeft = ((clientX - r.left) / r.width) * el.scrollWidth - el.clientWidth / 2
    follow.current = false
  }

  const failed = new Set(t.failed)
  const recovery = new Set(t.recovery)
  const inBracket = (m: number) => failed.has(m) || recovery.has(m)
  const callsIn = (m: number) => t.rows.reduce((n, r) => n + (cells.grid.get(r.key)?.get(m)?.length ?? 0), 0)

  const pick = (c: TimelineCall) => onSelect?.(selected === c.id ? null : c.id)

  return (
    <div className="my-1">
      {/* One row of chrome: the vocabulary, what the hovered column is, and
          the two numbers the grid exists to show. */}
      <div className="flex h-4 items-center gap-4 text-[10px] text-fg-dim">
        <span className="flex shrink-0 items-center gap-3">
          <span className="flex items-center gap-1.5">
            <span className="inline-block size-2 rounded-full border-[1.5px] border-ok" />
            looked
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block size-2 rounded-full bg-ok" />
            acted
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block size-2 rounded-full bg-err" />
            failed
          </span>
        </span>
        <span className="min-w-0 truncate">
          {hover !== null
            ? `message ${hover}, ${callsIn(hover)} call${callsIn(hover) === 1 ? "" : "s"}${
                recovery.has(hover) ? ", recovery" : ""
              }`
            : composing
              ? "thinking…"
              : ""}
        </span>
        <span className="ml-auto shrink-0 text-fg-muted">
          {t.total} calls in {t.messages.length} message{t.messages.length === 1 ? "" : "s"}
          {t.recovery.length > 0 && (
            <span className="text-warn">
              {"   "}
              {t.recovery.length} recovering
            </span>
          )}
        </span>
      </div>

      {/* The overview strip: 3px per message, red for a failure, amber for
          the recovery that followed it, blue for in flight. Dragging scrolls
          the grid. Hidden while the grid fits. */}
      {win !== null && (
        <div
          ref={strip}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            seek(e.clientX)
          }}
          onPointerMove={(e) => {
            if (e.buttons) seek(e.clientX)
          }}
          className="relative mb-1 flex h-3.5 cursor-crosshair items-end gap-px select-none"
        >
          {t.messages.map((m) => (
            <span
              key={m}
              className={`w-[3px] shrink-0 ${
                failed.has(m)
                  ? "h-3.5 bg-err"
                  : recovery.has(m)
                    ? "h-2 bg-warn/40"
                    : cells.busy.has(m)
                      ? "h-2 bg-info"
                      : "h-[5px] bg-line"
              }`}
            />
          ))}
          {composing && <span className="h-2 w-[3px] shrink-0 animate-pulse bg-info" />}
          <span
            className="pointer-events-none absolute -inset-y-0.5 border border-fg-dim bg-white/5"
            style={{ left: `${(win.left * 100).toFixed(2)}%`, width: `${(win.width * 100).toFixed(2)}%` }}
          />
        </div>
      )}

      {/* pt-4 is the headroom the fail tags rise into on the first row. */}
      <div
        ref={wrap}
        onScroll={() => {
          const el = wrap.current
          if (el) follow.current = el.scrollLeft + el.clientWidth >= el.scrollWidth - 4
          measure()
        }}
        className="overflow-x-auto overflow-y-hidden pt-4 pb-1 [scrollbar-width:thin]"
      >
        <table className="border-collapse">
          <thead>
            <tr>
              <th className="sticky left-0 z-[2] bg-editor p-0" />
              {t.messages.map((m) => {
                const br = inBracket(m)
                // On a long turn only every fifth number, plus any column that
                // failed or recovered — the ones somebody will look for.
                const numbered = t.messages.length <= 20 || m % 5 === 0 || br
                return (
                  <th
                    key={m}
                    style={{ width: cells.widths.get(m), minWidth: cells.widths.get(m) }}
                    onMouseEnter={() => setHover(m)}
                    onMouseLeave={() => setHover(null)}
                    className={`relative h-5 p-0 text-center align-middle text-[10px] font-normal text-fg-dim ${
                      recovery.has(m) ? "bg-warn/10" : ""
                    } ${hover === m ? "bg-hover" : ""}`}
                  >
                    {numbered ? m : ""}
                    {/* The failure→recovery bracket: one red bar from the
                        message that failed through the messages spent redoing
                        it, capped at each end. */}
                    {br && (
                      <span
                        title="a failure, and the messages spent redoing it"
                        className={`absolute bottom-0 h-[2px] bg-err ${
                          inBracket(m - 1) ? "left-0" : "left-1.5 rounded-l"
                        } ${inBracket(m + 1) ? "right-0" : "right-1.5 rounded-r"}`}
                      />
                    )}
                  </th>
                )
              })}
              {composing && (
                <th
                  style={{ width: 24, minWidth: 24 }}
                  className="h-5 p-0 text-center align-middle"
                  title="Claude is thinking — the next message has not arrived"
                >
                  <span className="mx-auto block size-2.5 animate-spin rounded-full border-[1.5px] border-info border-t-transparent" />
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {t.rows.map((r) => {
              const byMsg = cells.grid.get(r.key)
              const touched = t.messages.filter((m) => byMsg?.has(m))
              const lo = touched[0] ?? 0
              const hi = touched[touched.length - 1] ?? 0
              return (
                <tr key={r.key}>
                  <td
                    title={r.key}
                    className={`sticky left-0 z-[2] h-6 bg-editor p-0 pr-3 text-[11px] ${
                      r.sys ? "text-fg-dim" : "text-syn-string"
                    }`}
                  >
                    <span className="block max-w-52 truncate">{shortLabel(r)}</span>
                  </td>
                  {t.messages.map((m) => {
                    const cs = byMsg?.get(m) ?? []
                    // The connector from first touch to last, behind the dots.
                    // A row touched once gets none — there is nothing to join.
                    const on = lo !== hi && m >= lo && m <= hi
                    const w = cells.widths.get(m) ?? 24
                    // The HTML dots' geometry, recomputed for the path: DOT
                    // on GAP, centred — `colWidth`'s own arithmetic.
                    const xs = cs.map(
                      (_, i) =>
                        w / 2 -
                        (cs.length * DOT + (cs.length - 1) * GAP) / 2 +
                        DOT / 2 +
                        i * (DOT + GAP),
                    )
                    const from = m === lo ? (xs[0] ?? w / 2) : 0
                    const to = m === hi ? (xs[xs.length - 1] ?? w / 2) : w
                    return (
                      <td
                        key={m}
                        style={{ width: cells.widths.get(m), minWidth: cells.widths.get(m) }}
                        onMouseEnter={() => setHover(m)}
                        onMouseLeave={() => setHover(null)}
                        className={`relative h-6 p-0 ${recovery.has(m) ? "bg-warn/10" : ""} ${
                          hover === m ? "bg-hover" : ""
                        }`}
                      >
                        {on && (
                          <Connector
                            gid={`${gid}${m}`}
                            w={w}
                            xs={xs}
                            reds={cs.map((c) => c.status === "err")}
                            from={from}
                            to={to}
                          />
                        )}
                        {cs.length > 0 && (
                          <span className="relative z-[1] flex h-full items-center justify-center gap-[3px]">
                            {cs.map((c) => (
                              <Dot
                                key={c.id}
                                call={c}
                                selected={c.id === selected}
                                onPick={() => pick(c)}
                              />
                            ))}
                          </span>
                        )}
                      </td>
                    )
                  })}
                  {/* The thinking column's body: empty on purpose. Nothing
                      queued or predicted is ever drawn as a call. */}
                  {composing && <td style={{ width: 24, minWidth: 24 }} className="p-0" />}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
