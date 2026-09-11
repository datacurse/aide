import { useEffect, type RefObject } from "react"

/**
 * How much of the remaining distance is covered per SECOND, as a survival rate.
 *
 * Exponential decay, framed the way it has to be to survive a 144Hz monitor:
 * the first version was `gap * 0.18` once per frame, which is 0.18 per frame
 * and therefore 2.4× faster on a 144Hz display than on a 60Hz one — the same
 * flick travelling a different distance on two machines, and on the fast one
 * arriving so abruptly that the easing read as a stutter. This is the fraction
 * of the gap still REMAINING after one second, applied as `rate ** dt`, so the
 * curve is identical at any refresh rate.
 *
 * 0.0005 puts a 100px notch inside its last half-pixel in ~145ms. Lower and the
 * ease is gone; higher and the list lags the wheel, which reads as the app
 * being slow rather than smooth.
 */
const RETAINED_PER_SEC = 0.0005
/**
 * Below this the remainder is not worth another frame — snap and stop.
 *
 * A whole pixel, not the half it was. Subpixel scroll positions are not
 * addressable on every display: at fractional device-pixel-ratio (a 125%
 * Windows display, which is this project's own) the browser snaps `scrollTop`
 * to its own grid, so a 0.5px floor is a target the element can be unable to
 * land on — the loop then spins frames forever against a gap it cannot close.
 */
const DONE = 1
/**
 * How far the element may be from where this loop put it before the loop
 * concludes somebody else moved it.
 *
 * Generous on purpose, and the tightest of the three bugs that made the first
 * version glitch. `scrollTop` is stored as a float and reported back snapped to
 * the device pixel grid, which at 125% zoom is not integers — so a write of
 * 847.3 reads back as something else entirely, and near the end of a scroll,
 * where each step is under a pixel, a write can round to NO CHANGE AT ALL.
 * Against a 1px threshold that drift read as interference: the loop called
 * `stop()` partway through, so a scroll died early at a different random point
 * on every notch. That is the stutter. Nothing legitimately competing for this
 * scroller moves it by less than a rounding error — the stick-to-end follower
 * jumps to the bottom, a thumb drag tracks a pointer — so the test only has to
 * catch real motion, and 8px catches all of it while being deaf to rounding.
 */
const HIJACKED = 8
/**
 * Multiplier on a line-based delta, for Firefox's `deltaMode === 1`.
 *
 * The same 16px a line the timeline's wheel handler already assumes, so the
 * two do not disagree about how far one notch is.
 */
const LINE = 16

/**
 * Smooth the wheel on one scrollport, without taking ownership of its scroll.
 *
 * Native wheel scrolling on Windows is a step: one notch teleports the content
 * ~100px with nothing in between, and on a list of 48px rows that is two rows
 * appearing where two others were. `scroll-behavior: smooth` is the obvious
 * fix and is the wrong tool — it is a property of the ELEMENT, so it eases
 * every programmatic write too, and the writes in this app are the ones that
 * must be instant: `useStickToEnd`'s follower assigns `scrollTop` from a
 * ResizeObserver as a turn streams, and easing that turns a steady stream into
 * a permanent chase it can never catch up with (it re-targets every frame,
 * each time from further behind). Same for `OverlayScroller`'s thumb drag,
 * which would trail the pointer, and the timeline's `scrollIntoView`.
 *
 * So the easing lives on the WHEEL only. A wheel event sets a target and a
 * rAF loop walks `scrollTop` toward it; everything else in the app keeps
 * writing `scrollTop` directly and instantly, and any such write CANCELS the
 * loop (see `expected` below) so there is never more than one thing deciding
 * where the scroller is.
 *
 * Deliberately a hook rather than a wrapper component: every scrollport here
 * is already an element with layout, padding and behaviour of its own —
 * `OverlayScroller`'s hidden-bar div, the transcript's `pb-32` scrollport —
 * and a wrapper would either re-parent those or add a second box for the same
 * axis. One line in the element that already exists is the smaller change.
 */
export function useSmoothWheel(
  /** The scrollport. Nothing happens until it exists. */
  ref: RefObject<HTMLElement | null>,
  /**
   * Off puts the native wheel back.
   *
   * For the case where smoothing would be wrong rather than as a preference:
   * the timeline's strip owns its wheel outright for scrubbing, so a scroller
   * that contains one must not also smooth it.
   */
  enabled = true,
): void {
  useEffect(() => {
    const el = ref.current
    if (!el || !enabled) return

    /** Where the wheel is steering, or null when the loop is not running. */
    let target: number | null = null
    let frame = 0
    /**
     * The animation's own position, in full float precision.
     *
     * The loop advances THIS and writes it to the element, rather than reading
     * `el.scrollTop` back each frame and advancing that. Reading it back means
     * every frame inherits the browser's pixel-grid rounding, and at 125% zoom
     * those errors compound: a slow tail where each step is a fraction of a
     * pixel rounds to zero movement over and over, so the scroll visibly stalls
     * short of its target while the loop believes it is still going.
     *
     * It is also the cancel test's reference — see `HIJACKED`. A frame finding
     * the element far from here has been overruled by somebody else, and the
     * only correct response is to stop steering: without that, a turn streaming
     * into a transcript you had just wheeled up fought the stick-to-end
     * follower for the length of the turn, the follower snapping to the bottom
     * and this loop pulling back up at 60fps.
     */
    let at = 0
    /** The timestamp of the last frame, for a frame-rate-independent step. */
    let last = 0

    const stop = () => {
      if (frame) cancelAnimationFrame(frame)
      frame = 0
      target = null
    }

    const step = (now: number) => {
      frame = 0
      if (target === null) return
      // Somebody else moved it — the stick-to-end follower, a thumb drag,
      // `scrollIntoView`. Their position wins and this loop is done, because
      // continuing would drag the view back to a target chosen before it
      // happened. Measured against what this loop last WROTE (`at`), not
      // against what the element reported afterwards; see `HIJACKED`.
      if (Math.abs(el.scrollTop - at) > HIJACKED) return stop()

      const max = el.scrollHeight - el.clientHeight
      // Re-clamped every frame, not once when the wheel arrived: the content
      // grows under a streaming turn, and a target pinned to the old maximum
      // stops short of a bottom that has since moved down.
      const to = Math.max(0, Math.min(max, target))
      target = to

      // Capped at 50ms. A frame that arrives late — a tab coming back to the
      // foreground, a long render on the main thread — would otherwise apply
      // one enormous decay step and teleport, which is the jump the easing
      // exists to remove, appearing at exactly the worst moment.
      const dt = Math.min(50, now - last) / 1000
      last = now

      if (Math.abs(to - at) < DONE) {
        at = to
        el.scrollTop = to
        return stop()
      }
      // Exponential decay toward the target, frame-rate independent: the gap
      // retains `RETAINED_PER_SEC` of itself per second whatever the refresh
      // rate, so 60Hz and 144Hz draw the same curve over the same wall clock.
      at = to - (to - at) * RETAINED_PER_SEC ** dt
      el.scrollTop = at
      frame = requestAnimationFrame(step)
    }

    const onWheel = (e: WheelEvent) => {
      // Somebody inside already claimed this wheel and it is only passing
      // through on its way up. The tool timeline's overview STRIP does exactly
      // that — it scrubs the selected call, or pans the grid sideways, and
      // preventDefaults when it does — and without this test the transcript
      // containing it would smooth-scroll on the same notch, so one turn of
      // the wheel both stepped the card and slid the conversation out from
      // under it. The grid itself deliberately claims nothing, so a wheel over
      // the body of a timeline scrolls the conversation like any other block.
      if (e.defaultPrevented) return
      // Left to the browser, all of it. Ctrl+wheel is zoom, shift+wheel is the
      // horizontal axis, and a non-vertical wheel is a horizontal scroller's
      // business — this hook only claims the vertical one.
      if (e.ctrlKey || e.shiftKey || e.deltaY === 0) return
      // A pinch-zoom's delta is in pages; there is no sensible pixel count for
      // one, so hand it back rather than guess.
      if (e.deltaMode === 2) return

      const max = el.scrollHeight - el.clientHeight
      if (max <= 0) return

      const delta = e.deltaMode === 1 ? e.deltaY * LINE : e.deltaY
      // From where the wheel is STEERING, not from where the view currently
      // is, so a flick of several notches adds up to their full travel rather
      // than each notch restarting from a view still catching up with the last.
      // Falls back to the live position when no animation is running.
      const from = target ?? el.scrollTop
      const to = Math.max(0, Math.min(max, from + delta))

      // At an edge, hand the event back: an unpreventDefaulted wheel at the
      // top of a nested list scrolls the page behind it, which is what the
      // native one does and what an overscroll-chained layout expects. Tested
      // against the CURRENT position as well as the target, or a scroller
      // already at its end would keep swallowing wheels aimed past it.
      if (to === from && (el.scrollTop === 0 || el.scrollTop >= max - 1)) return

      e.preventDefault()
      target = to
      if (!frame) {
        // Seeded from the element, because this is the first notch of a new
        // gesture and the element is the only thing that knows where the view
        // actually is — a `stop()` may have left `at` somewhere stale, and a
        // thumb drag or the follower may have moved it since.
        at = el.scrollTop
        // `performance.now()` and not the next frame's stamp: the first step
        // must measure from HERE, or its `dt` spans the whole gap since
        // whatever frame ran last — which for a wheel arriving on an idle
        // scroller is unbounded, and the cap would then eat the first 50ms of
        // the curve as one jump.
        last = performance.now()
        frame = requestAnimationFrame(step)
      }
    }

    // Non-passive, because this preventDefaults. React's `onWheel` registers
    // passively, so it cannot be used for this at all — the page would scroll
    // alongside the animation.
    el.addEventListener("wheel", onWheel, { passive: false })
    // A pointer or a key on the scroller is a gesture with its own idea of
    // where the view should be — a thumb drag, a text selection autoscrolling,
    // Page Down. Yield to it rather than waiting for `expected` to notice,
    // which would cost a frame of the two fighting.
    el.addEventListener("pointerdown", stop)
    el.addEventListener("keydown", stop)
    // A touch scroll is the platform's own inertia; smoothing on top of it is
    // two easings composed, and it never reaches `onWheel` to be cancelled.
    el.addEventListener("touchstart", stop, { passive: true })
    return () => {
      el.removeEventListener("wheel", onWheel)
      el.removeEventListener("pointerdown", stop)
      el.removeEventListener("keydown", stop)
      el.removeEventListener("touchstart", stop)
      stop()
    }
  }, [ref, enabled])
}
