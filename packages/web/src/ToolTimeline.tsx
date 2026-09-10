import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react"
import {
  buildTimeline,
  isRefusal,
  looksOnly,
  type TimelineCall,
  type TimelineRow,
} from "@aide/protocol"
import { Hint } from "./Hint.js"

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
  // A refusal is amber, not red — aide declining a call is the system working,
  // and drawn in the fault colour it reads as a broken tool. Same amber the
  // recovery bracket uses, which is the same weight: expected, worth noticing,
  // not an error. See `isRefusal`.
  const refused = call.status === "err" && isRefusal(call.failTag)
  const shape =
    call.status === "busy"
      ? "border-2 border-info border-t-transparent bg-editor animate-spin"
      : refused
        ? "bg-warn"
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
      ? // "refused" rather than "failed: denied" — the screen reader gets the
        // same distinction the colour draws.
        refused
        ? "refused"
        : `failed${call.failTag ? `: ${call.failTag}` : ""}`
      : call.status === "busy"
        ? "running"
        : "ok"
  return (
    <span className="group relative">
      {/* The classified reason, directly above the dot, on hover or focus.
          The scroll container carries top headroom so this never clips. */}
      {call.failTag && (
        <span
          className={`pointer-events-none absolute -top-[17px] left-1/2 z-10 -translate-x-1/2 text-[10px] whitespace-nowrap opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 ${
            refused ? "text-warn" : "text-err"
          }`}
        >
          {call.failTag}
        </span>
      )}
      {/* `display: contents`, so the dot's own click still reaches the cell —
          the hint listens for the hover and adds nothing the press can land
          on. A wrapper with a box here would be the second click handler the
          comment below rules out. */}
      <Hint hint={`${call.tool} ${call.target}`.trim()}>
        <span
          role="button"
          tabIndex={0}
          data-dotid={call.id}
          aria-label={`${call.tool} ${call.target}, message ${call.message}, ${state}`}
          // No `onClick`: the CELL handles clicks, so a press on the dot bubbles
          // up and lands on the same nearest-call path as a press beside it. Two
          // click handlers for one dot would be two answers to one question, and
          // the inner one would silently win. The keyboard keeps its own — a
          // keypress has no coordinates for the cell to be nearest to, and this
          // is how the grid is reachable without a mouse.
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
      </Hint>
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
   * The listener is registered once, so what it needs each event rides in a
   * ref — `[]` deps with a closure over props is how the first version of
   * this handler quietly read the mount-time selection forever.
   */
  const wheelCtx = useRef({ selected, calls, onSelect })
  wheelCtx.current = { selected, calls, onSelect }
  /** Accumulated wheel travel between selection steps. */
  const wheelAcc = useRef(0)

  /**
   * The wheel, over the grid, does the thing the moment calls for.
   *
   * With a card OPEN it scrubs: each notch steps the selection through the
   * calls in the order they happened, the card follows, and the grid pans
   * itself to keep the selected dot in view. The wheel is owned outright in
   * this mode, ends clamped — you are inspecting the grid, not the page.
   * (This is also why "hover and wheel" seemed dead before: on a grid that
   * fits its box, panning — the only thing the wheel did then — has nowhere
   * to go.)
   *
   * With NOTHING selected it pans sideways — a horizontal scroller inside a
   * vertical one has no wheel axis of its own — and stays polite: a grid
   * that fits never takes the wheel, and one at either edge hands it back to
   * the page instead of going dead under the pointer.
   *
   * A manual non-passive listener, because React registers `onWheel`
   * passively and a passive listener cannot preventDefault — the page would
   * scroll along with whichever behaviour ran.
   */
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    // One selection step per standard mouse notch (~100px of delta);
    // trackpads accumulate their smaller deltas up to the same threshold.
    const STEP = 100
    const onWheel = (e: WheelEvent) => {
      // Shift+wheel is the browser's own horizontal scroll; leave it alone.
      if (e.deltaY === 0 || e.shiftKey) return
      // Firefox reports line-based deltas; ~16px a line.
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY

      const ctx = wheelCtx.current
      if (ctx.selected !== null && ctx.onSelect) {
        const at = ctx.calls.findIndex((c) => c.id === ctx.selected)
        if (at === -1) return
        e.preventDefault()
        wheelAcc.current += delta
        const steps = Math.trunc(wheelAcc.current / STEP)
        if (steps === 0) return
        wheelAcc.current -= steps * STEP
        const next = ctx.calls[Math.max(0, Math.min(ctx.calls.length - 1, at + steps))]
        if (!next || next.id === ctx.selected) return
        ctx.onSelect(next.id)
        // After the render, walk the grid to the dot the card now describes.
        requestAnimationFrame(() => {
          el.querySelector(`[data-dotid="${CSS.escape(next.id)}"]`)?.scrollIntoView({
            block: "nearest",
            inline: "nearest",
          })
        })
        return
      }

      if (el.scrollWidth <= el.clientWidth) return
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
  /** Failed, but only ever because aide refused — amber rather than red. */
  const refused = new Set(t.refused)
  const inBracket = (m: number) => failed.has(m) || recovery.has(m)

  /**
   * For each bracketed column, whether the whole RUN it belongs to was refusals.
   *
   * The bracket is one bar spanning a failure and the messages spent working
   * around it, so its colour is a property of the run and not of the column the
   * cell happens to be. Computed by walking each contiguous run once: red wins
   * if any column in it failed for a reason other than a refusal, because a run
   * holding a genuine fault must not be softened by the refusals beside it.
   */
  const softBracket = useMemo(() => {
    const out = new Map<number, boolean>()
    for (let i = 0; i < t.messages.length; i++) {
      const start = t.messages[i]!
      if (!inBracket(start)) continue
      let end = i
      while (end + 1 < t.messages.length && inBracket(t.messages[end + 1]!)) end++
      const run = t.messages.slice(i, end + 1)
      const soft = run.every((m) => !failed.has(m) || refused.has(m))
      for (const m of run) out.set(m, soft)
      i = end
    }
    return out
  }, [t.messages, t.failed, t.recovery, t.refused])
  /**
   * Every call in a column, across all rows — what a click anywhere in that
   * column is choosing between. Built once per timeline rather than per cell,
   * since every cell of a column needs the same list.
   */
  const columnCalls = useMemo(() => {
    const out = new Map<number, TimelineCall[]>()
    for (const r of t.rows) {
      for (const c of r.calls) {
        const list = out.get(c.message)
        if (list) list.push(c)
        else out.set(c.message, [c])
      }
    }
    return out
  }, [t])
  const callsIn = (m: number) => columnCalls.get(m)?.length ?? 0

  const pick = (c: TimelineCall) => onSelect?.(selected === c.id ? null : c.id)

  /**
   * A click anywhere in a COLUMN selects the call nearest the pointer.
   *
   * Not the cell, and the difference is the whole point: a message is usually
   * one or two calls spread down a grid of many rows, so cell-only targeting
   * still left most of the column dead — you had to find the one row that
   * happened to hold the dot. The column is what is unambiguous. A click in it
   * means "this message", and the only question left is which of its calls,
   * which the pointer answers by being nearest one of them. With a single call
   * in the column — the common case — every pixel of it selects that call.
   *
   * Nearest is measured in BOTH axes, so two dots in different rows split at
   * the midpoint between them exactly as two dots side by side in one row do.
   * One rule, one boundary, whichever way the neighbours happen to lie.
   *
   * Measured off the RENDERED dots (`data-dotid`) rather than recomputed from
   * DOT/GAP, the column width and the row height. That arithmetic already
   * exists twice — the flex layout the browser performs, and the connector's
   * own x positions — and a third copy deciding what you clicked is the one
   * that disagrees after a padding change, selecting a neighbour with nothing
   * on screen to explain it. The single-call case skips the measuring entirely.
   */
  const pickInColumn = (e: ReactMouseEvent<HTMLElement>, cs: TimelineCall[]) => {
    const only = cs[0]
    if (!only) return
    if (cs.length === 1) {
      pick(only)
      return
    }
    // The scroll container, which is the one ancestor holding every row's dots
    // — a `<td>` holds only its own, and this has to reach across rows.
    const root = wrap.current
    if (!root) {
      pick(only)
      return
    }
    let best = only
    let bestDist = Infinity
    for (const c of cs) {
      const el = root.querySelector(`[data-dotid="${CSS.escape(c.id)}"]`)
      if (!el) continue
      const r = el.getBoundingClientRect()
      const dx = e.clientX - (r.left + r.width / 2)
      const dy = e.clientY - (r.top + r.height / 2)
      // Squared, because only the comparison matters and a square root per dot
      // buys nothing.
      const d = dx * dx + dy * dy
      if (d < bestDist) {
        bestDist = d
        best = c
      }
    }
    pick(best)
  }

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
          {/* Only when there is one to explain. A permanent fourth entry would
              spend legend width on a colour most turns never draw. */}
          {t.refused.length > 0 && (
            <Hint hint="aide declined the call — a policy refusal, not a fault">
              <span className="flex items-center gap-1.5">
                <span className="inline-block size-2 rounded-full bg-warn" />
                refused
              </span>
            </Hint>
          )}
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

      {/* The overview strip: one tick per message, red for a failure, amber
          for the recovery that followed it, blue for in flight. Dragging
          scrolls the grid. Hidden while the grid fits.

          The ticks SHARE the full width (`flex-1`, `basis-0`) rather than
          claiming a fixed 3px each. Fixed-width ticks make the strip as long
          as the turn happens to be — 61 messages drew ~244px of it — while the
          window indicator over them is positioned in PERCENTAGES of the strip.
          So the two disagreed about what "all the way across" meant: the
          indicator was correct about a strip that stopped a fifth of the way
          into the space it was describing, which reads as a scrollbar floating
          loose above an unrelated minimap. Sharing the width also makes the
          strip mean the same thing at every length, which is what lets it be
          seeked by fraction. */}
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
              // `min-w-0` so a long turn's ticks may go under a pixel wide
              // rather than forcing the strip past its container and bringing
              // back the overflow this is meant to remove.
              className={`min-w-0 flex-1 basis-0 ${
                refused.has(m)
                  ? // Full height like a failure — it is one, and it is worth
                    // finding — but amber, because aide refusing is the system
                    // working rather than breaking.
                    "h-3.5 bg-warn"
                  : failed.has(m)
                    ? "h-3.5 bg-err"
                    : recovery.has(m)
                      ? "h-2 bg-warn/40"
                      : cells.busy.has(m)
                        ? "h-2 bg-info"
                        : "h-[5px] bg-line"
              }`}
            />
          ))}
          {composing && <span className="h-2 min-w-0 flex-1 basis-0 animate-pulse bg-info" />}
          <span
            className="pointer-events-none absolute -inset-y-0.5 border border-fg-dim bg-white/5"
            style={{ left: `${(win.left * 100).toFixed(2)}%`, width: `${(win.width * 100).toFixed(2)}%` }}
          />
        </div>
      )}

      {/* pt-4 is the headroom the fail tags rise into on the first row.

          The native scrollbar is hidden because the strip above IS one, and a
          better one: it appears under exactly the same condition (the grid
          overflowing), it seeks by drag, and it says what is in the part you
          cannot see — which failed, which is still running — where the native
          bar only says how far along you are. Two bars for one axis, one of
          them redundant, on a component whose whole job is to be read at a
          glance. Scrolling itself is untouched: the wheel handler above, the
          drag, and `scrollIntoView` all still work, so nothing here is a
          scrollbar removed without a replacement. */}
      <div
        ref={wrap}
        onScroll={() => {
          const el = wrap.current
          if (el) follow.current = el.scrollLeft + el.clientWidth >= el.scrollWidth - 4
          measure()
        }}
        className="overflow-x-auto overflow-y-hidden pt-4 pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <table className="border-collapse">
          <thead>
            <tr>
              <th className="sticky left-0 z-[2] bg-editor p-0" />
              {t.messages.map((m) => {
                const br = inBracket(m)
                const allRefused = softBracket.get(m) === true
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
                    {/* The failure→recovery bracket: one bar from the message
                        that failed through the messages spent redoing it,
                        capped at each end. Amber when every failure it spans
                        was aide refusing, red when any of them was a genuine
                        fault — the bar is one continuous run across several
                        columns, so it takes ONE colour and the stricter of the
                        two wins. A run holding a real error must not be
                        softened by the refusals beside it. */}
                    {br && (
                      <Hint
                        hint={
                          allRefused
                            ? "a refused call, and the messages spent working around it"
                            : "a failure, and the messages spent redoing it"
                        }
                      >
                        <span
                          className={`absolute bottom-0 h-[2px] ${allRefused ? "bg-warn" : "bg-err"} ${
                            inBracket(m - 1) ? "left-0" : "left-1.5 rounded-l"
                          } ${inBracket(m + 1) ? "right-0" : "right-1.5 rounded-r"}`}
                        />
                      </Hint>
                    )}
                  </th>
                )
              })}
              {composing && (
                <th
                  style={{ width: 24, minWidth: 24 }}
                  className="h-5 p-0 text-center align-middle"
                >
                  <Hint hint="Claude is thinking — the next message has not arrived">
                    <span className="mx-auto block size-2.5 animate-spin rounded-full border-[1.5px] border-info border-t-transparent" />
                  </Hint>
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
                    className={`sticky left-0 z-[2] h-6 bg-editor p-0 pr-3 text-[11px] ${
                      r.sys ? "text-fg-dim" : "text-syn-string"
                    }`}
                  >
                    {/* The hint wraps the label rather than the cell: a
                        `display: contents` span is invisible to layout, but a
                        table's own children are not — a wrapper between `tr`
                        and `td` would be pulled out into an anonymous row and
                        the sticky column would stop lining up. */}
                    <Hint hint={r.key}>
                      <span className="block max-w-52 truncate">{shortLabel(r)}</span>
                    </Hint>
                  </td>
                  {t.messages.map((m) => {
                    const cs = byMsg?.get(m) ?? []
                    // This column's calls across EVERY row — what a click in
                    // this cell is choosing between, since the target is the
                    // column rather than the cell.
                    const inColumn = columnCalls.get(m) ?? []
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
                        // The whole COLUMN selects, so this cell answers for
                        // its message even when the dot is several rows away —
                        // a message is usually one or two calls down a tall
                        // grid, and requiring the right row left most of the
                        // column dead. Nearest-in-both-axes decides between a
                        // column's calls, which is the midpoint between them
                        // whether they sit side by side or rows apart. A column
                        // with no calls at all gets no handler, so it stays
                        // inert rather than becoming a target that does
                        // nothing.
                        onClick={inColumn.length > 0 ? (e) => pickInColumn(e, inColumn) : undefined}
                        className={`relative h-6 p-0 ${inColumn.length > 0 ? "cursor-pointer" : ""} ${
                          recovery.has(m) ? "bg-warn/10" : ""
                        } ${hover === m ? "bg-hover" : ""}`}
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
