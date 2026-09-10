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

/** One connector segment between two neighbouring dots, in cell-local coords. */
interface Segment {
  x1: number
  x2: number
  /** CSS variable names — each end takes its own dot's colour. */
  c1: string
  c2: string
}

/**
 * The connectors for one cell: plain 4px segments between neighbouring dots,
 * at half opacity, in the dots' own colours.
 *
 * The swelling metaball shapes this replaces were drawn twice and refused
 * twice — the organic feel turned out to be carried by COLOUR, not geometry.
 * A segment runs centre to centre and the 15px dots cover its ends, so
 * nothing pokes past a row's edge; where its two dots differ — a failure's
 * red, a running call's blue — the fill is a gradient across the whole
 * segment, so the path shades smoothly into the state it arrives at. Half
 * opacity is what keeps a line reading as a line beside full-strength dots.
 *
 * Coordinates arrive grid-global translated into this cell, and a segment
 * that crosses cells is drawn by every cell it touches with the SAME
 * endpoints — `userSpaceOnUse` gradients interpolate over the full span, so
 * the colour ramp lines up across the boundary.
 */
function Connector({ gid, w, segs }: { gid: string; w: number; segs: Segment[] }) {
  return (
    <svg aria-hidden="true" width={w} height={24} className="pointer-events-none absolute inset-0">
      <defs>
        {segs.map((s, i) =>
          s.c1 === s.c2 ? null : (
            <linearGradient
              key={i}
              id={`${gid}s${i}`}
              gradientUnits="userSpaceOnUse"
              x1={s.x1}
              y1={0}
              x2={s.x2}
              y2={0}
            >
              {/* Through a neutral grey midpoint, not straight across: SVG
                  gradients interpolate in sRGB, and the direct road from
                  green to red passes through a muddy orange that reads as a
                  third state the row never had. Desaturating down and back
                  up reads as a CHANGE instead of a colour. */}
              <stop offset="0" style={{ stopColor: `var(${s.c1})` }} stopOpacity={0.5} />
              <stop offset="0.5" style={{ stopColor: "var(--color-fg-dim)" }} stopOpacity={0.5} />
              <stop offset="1" style={{ stopColor: `var(${s.c2})` }} stopOpacity={0.5} />
            </linearGradient>
          ),
        )}
      </defs>
      {segs.map((s, i) =>
        s.c1 === s.c2 ? (
          <rect
            key={i}
            x={s.x1}
            y={10}
            width={s.x2 - s.x1}
            height={4}
            style={{ fill: `var(${s.c1})` }}
            fillOpacity={0.5}
          />
        ) : (
          <rect key={i} x={s.x1} y={10} width={s.x2 - s.x1} height={4} fill={`url(#${gid}s${i})`} />
        ),
      )}
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
    // Each column's x offset from the start of the message columns, so a row
    // can place its dots in GRID-GLOBAL coordinates: a segment between two
    // dots crosses cell boundaries, and every cell drawing its slice needs
    // the same endpoints or the gradient ramps stop lining up.
    const offsets = new Map<number, number>()
    let acc = 0
    for (const m of t.messages) {
      offsets.set(m, acc)
      acc += widths.get(m) ?? 24
    }
    const busy = new Set<number>()
    for (const r of t.rows) for (const c of r.calls) if (c.status === "busy") busy.add(c.message)
    return { grid, widths, offsets, busy }
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

  /**
   * The wheel scrolls the grid SIDEWAYS while the pointer is over it. A
   * horizontal scroller inside a vertical one has no wheel axis of its own —
   * without this, reaching column 30 means grabbing a thin scrollbar or the
   * overview strip. Two escapes keep it polite: a grid that FITS never takes
   * the wheel at all, and one scrolled to either edge hands the wheel back to
   * the page instead of going dead under the pointer. A manual listener
   * because React registers `onWheel` passively, and a passive listener
   * cannot preventDefault — the page would scroll as well, which is worse
   * than either behaviour alone.
   */
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      // Shift+wheel is the browser's own horizontal scroll; leave it alone.
      if (e.deltaY === 0 || e.shiftKey) return
      if (el.scrollWidth <= el.clientWidth) return
      // Firefox reports line-based deltas; ~16px a line.
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY
      const max = el.scrollWidth - el.clientWidth
      const next = Math.max(0, Math.min(max, el.scrollLeft + delta))
      if (next === el.scrollLeft) return
      e.preventDefault()
      el.scrollLeft = next
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
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
            {t.rows.map((r, ri) => {
              const byMsg = cells.grid.get(r.key)
              // Every dot in the row at its grid-global x, in order. The
              // segments between consecutive dots are the row's connectors,
              // and each carries the colours of BOTH its dots so the fill
              // can shade from one state into the next.
              const dots: { x: number; c: string }[] = []
              for (const m of t.messages) {
                const cs = byMsg?.get(m) ?? []
                const w = cells.widths.get(m) ?? 24
                const off = cells.offsets.get(m) ?? 0
                cs.forEach((call, i) => {
                  dots.push({
                    x:
                      off +
                      w / 2 -
                      (cs.length * DOT + (cs.length - 1) * GAP) / 2 +
                      DOT / 2 +
                      i * (DOT + GAP),
                    c:
                      call.status === "err"
                        ? "--color-err"
                        : call.status === "busy"
                          ? "--color-info"
                          : "--color-ok",
                  })
                })
              }
              const segs = dots.slice(1).map((b, i) => ({ a: dots[i]!, b }))
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
                    const w = cells.widths.get(m) ?? 24
                    const off = cells.offsets.get(m) ?? 0
                    // This cell's slice of the row's segments, translated to
                    // local coordinates. A row touched once has no segments —
                    // there is nothing to join.
                    const local = segs
                      .filter((s) => s.b.x > off && s.a.x < off + w)
                      .map((s) => ({ x1: s.a.x - off, x2: s.b.x - off, c1: s.a.c, c2: s.b.c }))
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
                        {/* Keyed by row INDEX as well as column: gradient ids
                            are document-global, and every row in this column
                            renders its own defs. */}
                        {local.length > 0 && (
                          <Connector gid={`${gid}r${ri}m${m}`} w={w} segs={local} />
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
