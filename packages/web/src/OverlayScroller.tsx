import { useEffect, useRef, useState } from "react"
import type { PointerEvent as ReactPointerEvent, ReactNode, WheelEvent } from "react"
import { useSmoothWheel } from "./useSmoothWheel.js"

/**
 * A scroller whose scrollbar floats over the content instead of taking a column.
 *
 * A classic scrollbar is layout: it appears and every row gets 10px narrower,
 * it goes and they widen back. The chat list met both ends of that — folding
 * the archived group usually removes the scrollbar, so the press shifted the
 * whole list sideways — and `scrollbar-gutter: stable`, the first fix, traded
 * the shift for a permanent 10px stripe of nothing down the right edge.
 * `overflow: overlay`, which was exactly this, is gone from Chromium. So: the
 * native bar is hidden (wheel, keys and touch still scroll — only the bar's
 * pixels are gone) and the thumb is drawn on top, in the colours index.css
 * gives every other scrollbar, over content that is always full width.
 *
 * The thumb goes proportional-position wrong if it is measured from stale
 * numbers, so everything is re-read from the element on every scroll and on
 * every resize of the scroller OR its content — the content observer is the
 * one that notices the archived group folding.
 */
export function OverlayScroller({
  className,
  contentClassName,
  children,
}: {
  /** Sizing for the box the scroller fills — `flex-1` and friends go here. */
  className?: string
  /** Padding that used to sit on the scroller itself — `py-1` and friends. */
  contentClassName?: string
  children: ReactNode
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const [thumb, setThumb] = useState<{ top: number; height: number } | null>(null)
  useSmoothWheel(scroller)

  /**
   * The thumb's own node, so its POSITION can be written without a render.
   *
   * Whether the thumb exists at all is React's business — that mounts and
   * unmounts a node, and it changes only when the content crosses the height of
   * the box. Where it sits is not: it changes on every scroll event, and the
   * smoothed wheel now fires one of those every animation frame. Held as state,
   * that was a `setThumb` per frame re-rendering the whole chat list beneath it
   * — 60 to 144 times a second — which is most of what "glitchy" was here. The
   * native wheel fired a handful of events per notch and got away with it.
   */
  const bar = useRef<HTMLDivElement>(null)
  /**
   * The live numbers, for the drag and the track-press to do their sums with.
   *
   * The rendered `thumb` state goes stale by design now — `measure` stops calling
   * `setThumb` once the bar is mounted — and the drag divides by the thumb's
   * height. Read off a stale render, the grab ratio was out by however much the
   * list had grown since, so a drag halfway down a streaming chat list tracked
   * the pointer at the wrong speed.
   */
  const metrics = useRef<{ top: number; height: number } | null>(null)
  /** Whether the bar is mounted, so `measure`'s closure can tell. */
  const thumbUp = useRef(false)
  thumbUp.current = thumb !== null

  const measure = () => {
    const el = scroller.current
    if (!el) return
    const { scrollHeight, clientHeight, scrollTop } = el
    if (scrollHeight <= clientHeight) {
      setThumb(null)
      return
    }
    // Floored at 20px: a thumb proportional to a 200-chat list is a sliver too
    // small to grab, and the native ones stop shrinking at about this size too.
    const height = Math.max(20, (clientHeight / scrollHeight) * clientHeight)
    const top = (scrollTop / (scrollHeight - clientHeight)) * (clientHeight - height)
    // Straight to the node when it is already up, and to state only to bring it
    // into existence or size it. `metrics` keeps the numbers the drag arithmetic
    // reads, which must not go stale just because the render was skipped.
    metrics.current = { top, height }
    const node = bar.current
    if (node && thumbUp.current) {
      node.style.top = `${top}px`
      node.style.height = `${height}px`
      return
    }
    setThumb({ top, height })
  }

  useEffect(() => {
    const ro = new ResizeObserver(measure)
    if (scroller.current) ro.observe(scroller.current)
    if (content.current) ro.observe(content.current)
    return () => ro.disconnect()
    // measure reads live DOM only, so the empty deps are honest: there is
    // nothing from render for the observer's copy to go stale against.
  }, [])

  /** Where a drag took hold: the pointer's y, and the scrollTop it grabbed. */
  const drag = useRef<{ y: number; scrollTop: number } | null>(null)

  const onTrackDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = scroller.current
    // `metrics`, not `thumb`: the rendered state is deliberately stale between
    // mounts, and this arithmetic has to be about the thumb on screen now.
    const m = metrics.current
    if (!el || !m) return
    e.preventDefault()
    const y = e.clientY - e.currentTarget.getBoundingClientRect().top
    const range = el.clientHeight - m.height
    if (range <= 0) return
    // A press on the empty track jumps the thumb's centre to the pointer and
    // then behaves as a drag from there — one gesture, no paging.
    if (y < m.top || y > m.top + m.height) {
      const top = Math.min(range, Math.max(0, y - m.height / 2))
      el.scrollTop = (top / range) * (el.scrollHeight - el.clientHeight)
    }
    drag.current = { y: e.clientY, scrollTop: el.scrollTop }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onTrackMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = scroller.current
    const m = metrics.current
    if (!el || !drag.current || !m) return
    const range = el.clientHeight - m.height
    if (range <= 0) return
    const ratio = (el.scrollHeight - el.clientHeight) / range
    el.scrollTop = drag.current.scrollTop + (e.clientY - drag.current.y) * ratio
  }

  const onTrackEnd = () => {
    drag.current = null
  }

  /**
   * A wheel over the track's 10px, re-aimed at the scroller underneath.
   *
   * Re-DISPATCHED rather than applied as a `scrollBy`, which is what this used
   * to do: the scroller's own wheel is smoothed now (`useSmoothWheel`), and a
   * direct write would make the right-hand 10px of every list the one strip
   * where the wheel still steps. Sending the event on means both strips go
   * through the one easing, so there is no seam to feel for.
   *
   * `cancelable: false`, because this synthetic event must not be
   * preventDefaulted into swallowing the page scroll at an edge — the real
   * event is already past its own default by the time this runs, and the hook
   * hands an edge wheel back by NOT preventing it.
   */
  const onTrackWheel = (e: WheelEvent) => {
    const el = scroller.current
    if (!el) return
    el.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: e.deltaY,
        deltaMode: e.deltaMode,
        shiftKey: e.shiftKey,
        ctrlKey: e.ctrlKey,
        bubbles: false,
        cancelable: false,
      }),
    )
  }

  return (
    <div className={`relative min-h-0 ${className ?? ""}`}>
      <div
        ref={scroller}
        onScroll={measure}
        className="h-full overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <div ref={content} className={contentClassName}>
          {children}
        </div>
      </div>
      {/* The track is a sibling floating over the scroller, so a wheel turned
          over its 10px lands on it and not on the content — forwarded, or the
          right edge of the list would be a dead strip for the wheel. Only
          mounted while there is something to scroll, so when there is not, the
          same strip belongs to the rows and their buttons. */}
      {thumb && (
        <div
          onPointerDown={onTrackDown}
          onPointerMove={onTrackMove}
          onPointerUp={onTrackEnd}
          onPointerCancel={onTrackEnd}
          onWheel={onTrackWheel}
          className="absolute top-0 right-0 bottom-0 w-[10px]"
        >
          {/* scrollbarSlider.background / .hoverBackground — the same pair
              index.css paints the native bars with, so this one is not a
              different-looking scrollbar, just a floating one.

              `style` seeds the position for the first paint; `measure` writes
              this node's `top`/`height` directly from then on, so a smooth
              scroll moves the thumb without a render. React never re-renders it
              with a changed style, so the two do not fight over the attribute. */}
          <div
            ref={bar}
            style={{ top: thumb.top, height: thumb.height }}
            className="absolute right-0 w-full bg-[#79797966] hover:bg-[#646464b3]"
          />
        </div>
      )}
    </div>
  )
}
