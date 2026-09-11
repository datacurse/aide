import { useRef, type ReactNode } from "react"
import { useSmoothWheel } from "./useSmoothWheel.js"

/**
 * A vertical scrollport with a smoothed wheel. The plain case.
 *
 * Most scrolling boxes in the app are a `div` with `overflow-auto` and a list
 * inside, and all of them wanted the same thing — see `useSmoothWheel` for why
 * `scroll-behavior: smooth` is not it. This is that div, so those call sites
 * change by their tag rather than by growing a ref and a hook each.
 *
 * `OverlayScroller` is the other one, and it is NOT built on this: it already
 * owns a scroller element, a hidden native bar and a drawn thumb, and it calls
 * the hook directly. Two components rather than one wrapping the other, because
 * the nesting would put two scrollports on one axis — the outer one inert but
 * still a box the wheel has to pass through.
 *
 * The className split is the same as `OverlayScroller`'s, deliberately: sizing
 * (`flex-1`, `min-h-0`) belongs to the box, padding to the content, and a call
 * site moving between the two should not have to re-learn which is which.
 * Padding on the scrollport itself is a real difference and not a style
 * preference — bottom padding there is scrollable trailing room, which is what
 * the transcript's `pb-32` is for, while padding on the content is inset rows.
 */
export function Scroller({
  className,
  contentClassName,
  children,
}: {
  /** Sizing for the scrollport — `flex-1`, `max-h-[45%]` and friends. */
  className?: string
  /** Padding that used to sit on the scrolling div — `py-1` and friends. */
  contentClassName?: string
  children: ReactNode
}) {
  const el = useRef<HTMLDivElement>(null)
  useSmoothWheel(el)
  return (
    <div ref={el} className={`min-h-0 overflow-y-auto ${className ?? ""}`}>
      {/* A wrapper rather than the padding on the scrollport, so that
          `contentClassName` means the same thing it does in `OverlayScroller`.
          `display: contents` is not an option here: the padding needs a box.

          `min-h-full` and not `h-full`: several of these lists draw `Empty`,
          which centres itself with `h-full` — against this box, not the
          scrollport — so without a height to resolve against it collapses to
          the height of its own text and the message sits jammed under the
          header instead of centred in the pane. `min-h-` rather than `h-`
          because content taller than the port is the normal case here, and a
          fixed height would clip it. */}
      <div className={`min-h-full ${contentClassName ?? ""}`}>{children}</div>
    </div>
  )
}
