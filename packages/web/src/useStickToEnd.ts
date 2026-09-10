import { useCallback, useEffect, useRef, useState, type RefObject } from "react"

/**
 * Stick to the end while you are at the end, and stay out of the way when you
 * are not.
 *
 * Shared by the conversation pane and every wall column, because they are the
 * same transcript with the same reading behaviour — and because this is far more
 * subtle than it looks. The column had NO follower at all: it passed a scroller
 * down so the transcript could position its pinned question and nothing ever
 * scrolled it, so a turn streaming into a column wrote off the bottom of the box
 * while the visible rows sat still. Writing a second copy for the wall was the
 * obvious fix and the wrong one: every comment below is a failure somebody hit
 * once, and a reimplementation gets to hit them all again.
 *
 * Returns whether the end is currently in view — what draws a jump button — and
 * a way back down.
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
): { atEnd: boolean; toBottom: () => void } {
  const toBottom = useCallback(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [scroller])

  /** Whether the last line is on screen: what draws the jump button. */
  const [atEnd, setAtEnd] = useState(true)
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
    // A few pixels of slack: at fractional zoom the arithmetic lands half a
    // pixel short of the end, and an exact test would leave the pill on screen
    // for a view that is plainly already at the bottom.
    const read = () => {
      const end = el.scrollHeight - el.scrollTop - el.clientHeight < 24
      following.current = end
      setAtEnd(end)
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
      el.scrollTop = el.scrollHeight
    }
    const down = (e: MouseEvent) => {
      if (e.button === 0) dragging = true
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
      window.removeEventListener("mouseup", up)
      grow.disconnect()
    }
  }, [scroller, body])

  useEffect(() => {
    following.current = true
    setAtEnd(true)
    toBottom()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toBottom, ...reset])

  return { atEnd, toBottom }
}
