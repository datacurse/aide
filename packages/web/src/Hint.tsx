import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { ReactNode } from "react"
import { placeHint, type HintPlacement } from "@aide/protocol"

/**
 * A hover hint, drawn by aide rather than by the browser.
 *
 * Every one of these was a native `title` attribute, which is the one piece of
 * UI on screen the theme could not reach: the OS draws it, in its own font at
 * its own size, in a light box on a dark app, after a delay nobody chose. On a
 * surface whose whole argument is that it looks like the editor, ~120 of them
 * were the exception, and they were the exception at exactly the moment
 * somebody was reading carefully enough to hover.
 *
 * What is gained beyond the paint is control of the two things that made the
 * native one useless in places: the delay, and the width. Several hints here
 * are two or three sentences of real explanation — `Dashboard.tsx`'s score
 * note, the composer's attach button — and the native tooltip renders those as
 * one line running off the screen. This wraps at `max-w-xs` and honours a
 * `\n` as a line break, which the native one does too but at whatever width
 * the OS feels like.
 *
 * The delay is 400ms: long enough that dragging the pointer across the wall's
 * columns does not leave a trail of boxes, short enough that a deliberate
 * hover feels answered. Once one is open, moving to another opens it at once
 * (`warm`), which is how every real tooltip behaves — the delay is there to
 * decide whether you MEANT to hover, and having just read one is that decision
 * already made.
 */

/** How long the pointer must rest before a hint opens, cold. */
const OPEN_DELAY_MS = 400

/**
 * How long after a hint closes that the next one opens instantly.
 *
 * Shared across every Hint on the page, which is the point: the state being
 * tracked is the reader's, not any one hint's.
 */
const WARM_MS = 300

let warmUntil = 0

export function Hint({
  hint,
  children,
  className,
  as = "span",
}: {
  /**
   * What to say, or nothing. Undefined means the wrapper is inert — the same
   * shape `title={x || undefined}` already had at several call sites, so a
   * conditional hint does not need a conditional wrapper.
   */
  hint?: string | null
  children: ReactNode
  /** Sizing for the wrapper. It is `contents` by default and takes no layout. */
  className?: string
  /**
   * The element the wrapper becomes. A span with `display: contents` keeps it
   * out of layout entirely, which is what let ~120 call sites be wrapped
   * without moving one of them. `div` is for the rare place that passes a
   * `className` and so wants the wrapper to be a real box.
   *
   * Deliberately not `td`/`th`: inside a table the Hint goes around the CELL'S
   * CONTENT, never the cell. A wrapper between `tr` and `td` — of any kind — is
   * pulled out into an anonymous table row by the browser's own fixup, and the
   * timeline's sticky label column stops lining up with its dots.
   */
  as?: "span" | "div"
}) {
  const anchor = useRef<HTMLElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [open, setOpen] = useState(false)
  const [place, setPlace] = useState<HintPlacement | null>(null)
  const id = useId()

  const cancel = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }

  /**
   * The box to point at.
   *
   * The wrapper is `display: contents` by default, which is what lets a Hint be
   * dropped around a flex child or a table cell's content without changing a
   * single layout — but a contents element HAS no box, and
   * `getBoundingClientRect()` on one answers with zeros. Placed against that,
   * every hint in the app would open in the top-left corner of the window,
   * pointing at nothing. So a contents wrapper measures its children instead,
   * unioned because `children` may be several elements (`Button` is one, but a
   * row of spans is just as legal) and the hint should point at the group.
   */
  const anchorRect = () => {
    const el = anchor.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    if (rect.width > 0 || rect.height > 0) return rect
    const kids = Array.from(el.children)
    if (kids.length === 0) return null
    const boxes = kids.map((k) => k.getBoundingClientRect())
    return {
      left: Math.min(...boxes.map((b) => b.left)),
      top: Math.min(...boxes.map((b) => b.top)),
      right: Math.max(...boxes.map((b) => b.right)),
      bottom: Math.max(...boxes.map((b) => b.bottom)),
    }
  }

  const close = () => {
    cancel()
    if (open) warmUntil = Date.now() + WARM_MS
    setOpen(false)
    setPlace(null)
  }

  const show = () => {
    if (!hint) return
    cancel()
    if (Date.now() < warmUntil) {
      setOpen(true)
      return
    }
    timer.current = setTimeout(() => setOpen(true), OPEN_DELAY_MS)
  }

  useEffect(() => cancel, [])

  // A hint whose text changes while it is open — the live ones do, the working
  // bar's token count most obviously — has to be re-measured, or the box keeps
  // the width of the sentence it used to hold.
  useLayoutEffect(() => {
    if (!open) return
    const measure = () => {
      const a = anchorRect()
      const b = box.current?.getBoundingClientRect()
      if (!a || !b) return
      setPlace(
        placeHint(a, { width: b.width, height: b.height }, {
          width: window.innerWidth,
          height: window.innerHeight,
        }),
      )
    }
    measure()
    // Anything that moves the anchor closes the hint rather than chasing it.
    // Chasing means a scroll listener per open hint and a box that slides over
    // content while you are trying to read past it; the pointer has left the
    // element it described in nearly every case anyway.
    window.addEventListener("scroll", close, true)
    window.addEventListener("resize", close)
    return () => {
      window.removeEventListener("scroll", close, true)
      window.removeEventListener("resize", close)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hint])

  // Escape closes it, the way it closes everything else here. Without this a
  // hint left open by a pointer that never moved again (a click that opened a
  // dialog over it) has nothing that dismisses it.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const Tag = as
  return (
    <>
      <Tag
        ref={anchor as never}
        className={className ?? (as === "span" ? "contents" : undefined)}
        onPointerEnter={show}
        onPointerLeave={close}
        // A press means the hover has been acted on, so the hint has said what
        // it had to say. Left open, it hangs over whatever the click revealed.
        onPointerDown={close}
        onFocus={show}
        onBlur={close}
        aria-describedby={open && hint ? id : undefined}
      >
        {children}
      </Tag>
      {open &&
        hint &&
        createPortal(
          <div
            ref={box}
            id={id}
            role="tooltip"
            style={
              place
                ? { left: place.left, top: place.top }
                : // Measured before it is placed: rendered off-screen rather
                  // than hidden, because a `display: none` box has no size to
                  // measure and a `visibility: hidden` one at 0,0 would be
                  // measured against a viewport edge it will not end up near.
                  { left: -9999, top: -9999 }
            }
            className="pointer-events-none fixed z-50 max-w-xs rounded-sm border border-line-soft bg-chrome px-2 py-1 font-sans text-[11px] leading-relaxed whitespace-pre-line text-fg shadow-lg shadow-black/40"
          >
            {hint}
            {place && (
              // A square rotated 45°, showing the two borders that end up on
              // the outside — bottom+right when the hint is above the anchor,
              // top+left when it is below. Getting that pair wrong draws a
              // hairline ACROSS the arrow where the box's own border should
              // have been broken, which reads as a rendering fault rather than
              // as a tooltip.
              <span
                style={{
                  left: place.arrow,
                  [place.side === "top" ? "bottom" : "top"]: -4,
                }}
                className={`absolute size-[7px] -translate-x-1/2 rotate-45 bg-chrome ${
                  place.side === "top"
                    ? "border-r border-b border-line-soft"
                    : "border-t border-l border-line-soft"
                }`}
              />
            )}
          </div>,
          document.body,
        )}
    </>
  )
}
