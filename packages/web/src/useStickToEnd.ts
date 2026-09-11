import { useCallback, useEffect, useRef, useState, type RefObject } from "react"

/**
 * How far below the fold counts as "fully hidden" for the fade, in pixels.
 *
 * Roughly the height of the gradient it drives: the fade should be at full
 * strength once there is a gradient's worth of content underneath it, and
 * proportionally weaker as the last of it comes into view.
 */
const FADE_OVER = 120

/**
 * Stick to the end while you are at the end, and stay out of the way when you
 * are not.
 *
 * A hook rather than logic inside the pane, because this is far more subtle than
 * it looks: every comment below is a failure somebody hit once, and a second
 * implementation for a second surface gets to hit them all again. That is not
 * hypothetical — it is what happened when one existed with no follower at all,
 * passing a scroller down so the transcript could position its pinned question
 * while nothing ever scrolled it, so a streaming turn wrote off the bottom of the
 * box while the visible rows sat still.
 *
 * Returns whether the end is currently in view — what draws a jump button — a
 * ref to hang the bottom fade on, whose opacity this writes directly, and a way
 * back down.
 *
 * There used to be an unconditional follower in the pane and it was removed,
 * because a transcript that moves while you are dragging a cursor across it
 * cannot be read: the text goes out from under the pointer and the highlight
 * lands somewhere else. Both halves of that survive here. Scrolling up at all
 * ends the follow, and being scrolled up is a resting state you can sit in for
 * an hour with a turn writing underneath; a drag that has selected something
 * pauses it even at the bottom. Where the mouse-up leaves you is then simply
 * where you are — the button comes back rather than the pane jumping and taking
 * the selection you just made off screen with it.
 */
export function useStickToEnd(
  /** The scrollport. */
  scroller: RefObject<HTMLElement | null>,
  /**
   * The growing content inside it.
   *
   * State rather than a ref in every caller, and that is load-bearing: the
   * transcript is not rendered at all while a log is empty, so an effect that
   * found a null ref at mount would never learn the rows had arrived. A
   * `useState` setter as `ref=` re-runs this effect when the box appears.
   */
  body: HTMLElement | null,
  /**
   * Anything that should put the reader back at the end — a chat being opened, a
   * turn starting. Both count as asking: you pressed something, and what you
   * pressed it for is about to appear down there.
   *
   * Deliberately NOT the event count. That meant a poll picking up a line yanked
   * a reader back down, which is exactly what the follow is careful not to do.
   * Anything arriving while you are scrolled up is the button's business.
   */
  reset: unknown[] = [],
): { atEnd: boolean; fade: RefObject<HTMLDivElement | null>; toBottom: () => void } {
  const toBottom = useCallback(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [scroller])

  /** Whether the last line is on screen: what draws the jump button. */
  const [atEnd, setAtEnd] = useState(true)
  /**
   * The fade element, whose opacity is written DIRECTLY, never through state.
   *
   * What the fade is FOR: the pane's foot floats over the transcript behind a
   * gradient, and a gradient that is always on dims the last lines of a
   * conversation you have scrolled to the bottom of — text greyed out to hide
   * content that is not there. So it follows how much is actually below.
   *
   * Why it is a REF and not a number. This was a `below` state, quantized to 12
   * steps precisely because "`scroll` fires per frame, and state holding a live
   * pixel count re-renders the entire transcript on every one of those frames".
   * Quantizing was treating the symptom: `FADE_OVER` is 120px over 12 steps, so
   * a step every 10px, so ONE 100px wheel notch near the bottom still fired ~10
   * full re-renders of a transcript that is not memoized and rebuilds every row
   * — hundreds of elements with syntax highlighting — inside a 7ms frame budget
   * at 144Hz. That is what "unresponsive and jittery when I scroll the chat" was,
   * and why it was worst near the end of a conversation, where the ramp lives.
   * An opacity is a paint-only property with no bearing on layout or on any
   * other component, so it belongs on the node and nowhere else.
   */
  const fade = useRef<HTMLDivElement | null>(null)
  /**
   * The same fact, where the follower can read it.
   *
   * A ref as well as state because the follower runs from an observer callback
   * that closes over the render it was made in, and state read there is whatever
   * was true when the observer was attached.
   */
  const following = useRef(true)

  useEffect(() => {
    const el = scroller.current
    if (!el || !body) return

    let dragging = false
    /**
     * A press inside the pane arms this, and the NEXT growth consumes it.
     * Growth caused by a press is the reader OPENING something — a call
     * card, a fold, a tool row — and is the one growth the follow must not
     * chase; see `follow`. A one-shot flag rather than a time window,
     * because the first version was `Date.now() - pressedAt < 250` and lost
     * the race to any card heavy enough to matter: a whole-height Write
     * card can take longer than that to render and lay out, its growth
     * landed after the window closed, and the follower chased it anyway.
     * `pressedAt` survives only to expire a stale arm — a press that caused
     * no growth must not eat a stream beat minutes later.
     */
    let skipGrowth = false
    let pressedAt = 0
    // A few pixels of slack: at fractional zoom the arithmetic lands half a
    // pixel short of the end, and an exact test would leave the pill on screen
    // for a view that is plainly already at the bottom.
    const read = () => {
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight
      const end = gap < 24
      following.current = end
      // A boolean, and React bails out of a re-render when a `useState` is set
      // to the value it already holds — so this is free on all but the two
      // frames a scroll actually crosses the threshold. That is what makes it
      // safe to leave in state while the fade is not.
      setAtEnd(end)
      // Straight to the node: no state, no render, no quantization needed. The
      // ramp can be continuous now, which is strictly better than the 12 steps
      // it used to snap to. `Math.max(0, …)` because overscroll on a trackpad
      // reports a negative gap, which would otherwise drive a negative opacity.
      const node = fade.current
      if (node) node.style.opacity = `${Math.min(1, Math.max(0, gap) / FADE_OVER)}`
    }
    // A drag that has actually taken text, which is the only kind worth pausing
    // for. A click is a mouse-down too, and dropping the follow at every click
    // would stop a streaming turn following the first time you opened a tool row
    // to see what it did.
    const selecting = () => {
      const sel = window.getSelection()
      return dragging && !!sel && !sel.isCollapsed
    }
    const follow = () => {
      if (!following.current || selecting()) return
      // Growth on the heels of a press is the thing the press opened, not
      // the stream arriving — and snapping to the end then hoists what was
      // just clicked out from under the pointer, which is how selecting a
      // timeline dot at the bottom of a finished turn shoved the whole grid
      // upward. Skipping one beat costs a streaming turn nothing (its
      // growth is continuous, and the next one follows again); whatever the
      // press opened has pushed the end off screen anyway, so `read`
      // retires the follow until the reader closes it or jumps back down.
      if (skipGrowth && Date.now() - pressedAt < 2000) {
        skipGrowth = false
        return
      }
      skipGrowth = false
      el.scrollTop = el.scrollHeight
    }
    const down = (e: MouseEvent) => {
      if (e.button === 0) {
        dragging = true
        skipGrowth = true
        pressedAt = Date.now()
      }
    }
    // Keyboard activation opens the same things a click does — the timeline
    // dots are focusable buttons — so a key inside the pane counts as a press.
    const press = () => {
      skipGrowth = true
      pressedAt = Date.now()
    }
    // On the window, not on the pane: a drag very often ends outside the box it
    // started in, and a mouse-up missed here leaves the follow paused for good.
    const up = () => {
      if (!dragging) return
      dragging = false
      read()
    }

    // In this order, and this is the whole of what makes opening a chat land at
    // the bottom: the rows exist for the first time in this very commit, so
    // reading the position first would find a full-height transcript scrolled to
    // the top and conclude the reader had scrolled up.
    follow()
    read()
    el.addEventListener("scroll", read, { passive: true })
    el.addEventListener("mousedown", down)
    el.addEventListener("keydown", press)
    window.addEventListener("mouseup", up)
    // Content growing under a view that is already at the end fires no scroll
    // event, so the follow cannot hang off `scroll` the way the button's state
    // does: a reply streaming in, a tool row opening, a fold being expanded, a
    // pasted screenshot finishing loading and the pane being dragged narrower
    // are all height changes with no scroll behind them.
    //
    // `read` after `follow`, so the button's state reflects where the follow
    // just left things rather than where they were a frame before it.
    const settle = () => {
      follow()
      read()
    }
    const grow = new ResizeObserver(settle)
    grow.observe(body)
    // The VIEWPORT as well as the content, because being at the end is a
    // relation between the two boxes and either one can move it. Sending a
    // message changes only the viewport: the working bar mounts and the
    // composer collapses back, which together pull the scroller's bottom edge
    // up past the end of the transcript — no content grew, no scroll fired,
    // and the follower watching only `body` left the reader sitting short of
    // the bottom until the reply's first streamed line. With a send queued
    // behind a commit's checks that first line can be a minute away, which is
    // how "I sent a message and had to scroll down myself" happens. (This is
    // the observation the `body` comment above rules out for CONTENT growth —
    // observing an `overflow-y-auto` element reports its viewport, which is
    // exactly the half being covered here.)
    grow.observe(el)
    return () => {
      el.removeEventListener("scroll", read)
      el.removeEventListener("mousedown", down)
      el.removeEventListener("keydown", press)
      window.removeEventListener("mouseup", up)
      grow.disconnect()
    }
  }, [scroller, body])

  useEffect(() => {
    following.current = true
    setAtEnd(true)
    // The jump back down lands at the end, so the fade has nothing left to
    // cover — clearing it here as well as in `read` keeps it from drawing for
    // the frame between opening a chat and the first scroll reading.
    if (fade.current) fade.current.style.opacity = "0"
    toBottom()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toBottom, ...reset])

  return { atEnd, fade, toBottom }
}
