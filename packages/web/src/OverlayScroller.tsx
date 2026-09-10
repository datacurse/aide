import { useEffect, useRef, useState } from "react"
import type { PointerEvent as ReactPointerEvent, ReactNode, WheelEvent } from "react"

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
    if (!el || !thumb) return
    e.preventDefault()
    const y = e.clientY - e.currentTarget.getBoundingClientRect().top
    const range = el.clientHeight - thumb.height
    if (range <= 0) return
    // A press on the empty track jumps the thumb's centre to the pointer and
    // then behaves as a drag from there — one gesture, no paging.
    if (y < thumb.top || y > thumb.top + thumb.height) {
      const top = Math.min(range, Math.max(0, y - thumb.height / 2))
      el.scrollTop = (top / range) * (el.scrollHeight - el.clientHeight)
    }
    drag.current = { y: e.clientY, scrollTop: el.scrollTop }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onTrackMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = scroller.current
    if (!el || !drag.current || !thumb) return
    const range = el.clientHeight - thumb.height
    if (range <= 0) return
    const ratio = (el.scrollHeight - el.clientHeight) / range
    el.scrollTop = drag.current.scrollTop + (e.clientY - drag.current.y) * ratio
  }

  const onTrackEnd = () => {
    drag.current = null
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
          onWheel={(e: WheelEvent) => scroller.current?.scrollBy({ top: e.deltaY })}
          className="absolute top-0 right-0 bottom-0 w-[10px]"
        >
          {/* scrollbarSlider.background / .hoverBackground — the same pair
              index.css paints the native bars with, so this one is not a
              different-looking scrollbar, just a floating one. */}
          <div
            style={{ top: thumb.top, height: thumb.height }}
            className="absolute right-0 w-full bg-[#79797966] hover:bg-[#646464b3]"
          />
        </div>
      )}
    </div>
  )
}
