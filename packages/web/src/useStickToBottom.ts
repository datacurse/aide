import { useCallback, useEffect, useRef, useState } from "react"

/**
 * Follow the bottom of a scrolling transcript, unless the reader has scrolled up.
 *
 * Driven by a ResizeObserver on the content rather than by a dependency array,
 * and that is the whole point. The dependency-array version was wrong in a way
 * that was invisible until a conversation got long: it watched the length of the
 * *rendered slice*, which is capped at VISIBLE_TAIL, so once a transcript passed
 * that cap the number stopped changing and the effect stopped running. Following
 * worked perfectly on short conversations and silently gave up on exactly the
 * long ones where it matters.
 *
 * An observer on the content element cannot be wrong about this: if the
 * transcript got taller — a new message, a streaming token, a code block
 * reflowing after its font loads — it fires. There is no list of causes to keep
 * in sync.
 */

/**
 * How close to the bottom still counts as "at the bottom".
 *
 * Generous on purpose: a reader who nudges the wheel a little has not asked to
 * stop following, and a threshold of a few pixels makes the feature feel like it
 * disengages at random.
 */
const AT_BOTTOM_PX = 80

export function useStickToBottom() {
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  /** Ref, not state: it is read inside the observer and must never be stale. */
  const pinned = useRef(true)
  /** Only for rendering the "jump to latest" affordance. */
  const [following, setFollowing] = useState(true)

  const toBottom = useCallback(() => {
    const el = scroller.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    pinned.current = true
    setFollowing(true)
  }, [])

  /**
   * Jump to the start and stop following — for content that reads top-down, like
   * a diff, where being dropped at the bottom is disorienting rather than
   * helpful.
   */
  const toTop = useCallback(() => {
    const el = scroller.current
    if (!el) return
    el.scrollTop = 0
    pinned.current = false
    setFollowing(false)
  }, [])

  const onScroll = useCallback(() => {
    const el = scroller.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_PX
    pinned.current = atBottom
    // A state write per scroll frame would be wasteful; only the transitions
    // matter, and React bails out of a set that does not change the value.
    setFollowing(atBottom)
  }, [])

  useEffect(() => {
    const el = content.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      if (!pinned.current) return
      const s = scroller.current
      if (s) s.scrollTop = s.scrollHeight
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return { scroller, content, toBottom, toTop, onScroll, following }
}
