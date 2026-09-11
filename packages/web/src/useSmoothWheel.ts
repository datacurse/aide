import { useEffect, type RefObject } from "react"

/**
 * How much of the remaining distance is covered each frame, at 60fps.
 *
 * 0.18 lands a standard 100px notch in ~9 frames (150ms) with the last few
 * pixels drifting in — long enough to read as motion rather than a jump, short
 * enough that a second notch feels like it went to the same place. Higher and
 * the ease is gone; lower and the list lags the wheel, which reads as the page
 * being slow rather than smooth.
 */
const EASE = 0.18
/**
 * Below this the remainder is not worth another frame — snap and stop.
 *
 * Half a pixel rather than one: at fractional device-pixel-ratio (a 125%
 * Windows display, which is this project's own) a whole-pixel floor leaves a
 * visible seam at the end of every scroll.
 */
const DONE = 0.5
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
   * the timeline owns its wheel outright for scrubbing, so a scroller that
   * contains one must not also smooth it.
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
     * The `scrollTop` this loop last wrote, rounded the way the browser does.
     *
     * The cancel test. A frame that finds the scroller somewhere OTHER than
     * where it put it has been overruled by somebody else — the stick-to-end
     * follower, a thumb drag, `scrollIntoView`, a keypress, a touch — and the
     * only correct response is to stop steering, because continuing would
     * drag the view back to a target chosen before that happened. Without
     * this, a turn streaming into a transcript you had just wheeled upward
     * fought the follower for as long as the turn lasted: the follower snapped
     * to the bottom, this loop pulled back up, and the pane juddered between
     * the two at 60fps.
     */
    let expected: number | null = null

    const stop = () => {
      if (frame) cancelAnimationFrame(frame)
      frame = 0
      target = null
      expected = null
    }

    const step = () => {
      frame = 0
      if (target === null) return
      // Somebody else moved it. Their position wins, and this loop is done.
      // Compared with a pixel of slack because a browser stores `scrollTop` as
      // a float and reports it back rounded to the device pixel grid, so an
      // exact test would read the browser's own rounding as interference.
      if (expected !== null && Math.abs(el.scrollTop - expected) > 1) return stop()

      const max = el.scrollHeight - el.clientHeight
      // Re-clamped every frame, not once when the wheel arrived: the content
      // grows under a streaming turn, and a target pinned to the old maximum
      // stops short of a bottom that has since moved down.
      const to = Math.max(0, Math.min(max, target))
      const gap = to - el.scrollTop
      if (Math.abs(gap) < DONE) {
        el.scrollTop = to
        return stop()
      }
      el.scrollTop = el.scrollTop + gap * EASE
      expected = el.scrollTop
      frame = requestAnimationFrame(step)
    }

    const onWheel = (e: WheelEvent) => {
      // Somebody inside already claimed this wheel and it is only passing
      // through on its way up. The tool timeline does exactly that — it scrubs
      // the selected call, or pans its own grid sideways, and preventDefaults
      // when it does — and without this test the transcript containing it
      // would smooth-scroll on the same notch, so one turn of the wheel both
      // stepped the card and slid the conversation out from under it.
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
      // is, so a flick of several notches adds up to their full travel. Taken
      // from `scrollTop` when no animation is running, which is also what
      // makes a notch after an interruption start from what is on screen.
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
      // The first step runs on the NEXT frame rather than now. Writing
      // `scrollTop` synchronously inside the handler would move the view a
      // fraction of the delta immediately and then ease the rest, which reads
      // as a jolt followed by a glide.
      if (!frame) {
        expected = el.scrollTop
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
