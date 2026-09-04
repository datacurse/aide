import { useEffect, useRef, useState } from "react"

/**
 * Whether an element is currently on screen.
 *
 * Written for the wall, where it is not a nicety but the thing that bounds the
 * request rate. The four panes poll ONE project because only one is open; a wall
 * column polls its own, so the traffic becomes a function of how many projects
 * you happen to have added — a number nobody chose. Gating on visibility makes it
 * a function of window width instead, which is bounded and which you can see.
 *
 * It matters most for a project on another machine, where a `gitPending` is an
 * ssh connection. Windows OpenSSH cannot multiplex, so the cost is per
 * connection, and sshd refuses them past `MaxStartups` — measured, 12 at once
 * already loses one. The failure does not land on the wall when that happens; it
 * lands on whatever commit was unlucky enough to need a connection at the same
 * moment, which is very hard to read from where it surfaces. See `usePoll`,
 * which is the other half of this and guards the same budget from a different
 * direction.
 *
 * `rootMargin` is generous on purpose. A column that starts polling only once it
 * is fully in view arrives blank and fills in a beat later, so the scroll shows a
 * row of empty cards; a screen's worth of margin means the answer is usually
 * already there. It is bought at the cost of polling a little more than is
 * strictly visible, which is the right side of the trade — the ceiling this
 * exists for is dozens of connections, not one or two.
 *
 * Starts TRUE, and that is deliberate rather than an oversight: an observer
 * reports asynchronously, so starting false means every column's first beat waits
 * for a callback that arrives after paint. On a wall of local projects that is a
 * visible flash of nothing on arrival, for no benefit — an element that is about
 * to be reported off-screen has cost one request by then, and one request is what
 * it would have cost anyway.
 */
export function useOnScreen<T extends Element>(
  ref: React.RefObject<T | null>,
  rootMargin = "600px",
): boolean {
  const [visible, setVisible] = useState(true)
  // Held in a ref so the effect does not re-run when the margin is passed as a
  // literal — every render would otherwise tear down and rebuild the observer.
  const margin = useRef(rootMargin)
  margin.current = rootMargin

  useEffect(() => {
    const node = ref.current
    if (!node) return
    // No IntersectionObserver — an old browser, or a test environment. Every
    // column polling is exactly the behaviour this exists to improve on, and it
    // is correct, so falling back to it beats failing to render.
    if (typeof IntersectionObserver === "undefined") return

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1]
        if (entry) setVisible(entry.isIntersecting)
      },
      { rootMargin: margin.current },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [ref])

  return visible
}
