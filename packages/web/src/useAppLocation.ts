import { useCallback, useEffect, useState } from "react"

/**
 * Where you are, in the URL.
 *
 * Held in `location.hash` rather than in component state, because component
 * state does not survive a reload and this is the state you least want to
 * rebuild by hand: which project, which list, which conversation. Putting it in
 * the URL gets three things at once — reload survives it, browser back and
 * forward step through conversations, and a link to a specific conversation is
 * just the address bar.
 *
 * The hash rather than a path, so no router is needed and nothing can collide
 * with `/api` or `/__daemon` through the dev server's proxy.
 *
 * localStorage mirrors it as a fallback, for the case the hash cannot cover:
 * opening `localhost:5173` fresh in a new tab. The URL is the source of truth
 * whenever it says anything; the mirror only speaks when it is silent.
 */

const REMEMBERED = "aide.location"

export const PANES = ["board", "chats"] as const
export type Pane = (typeof PANES)[number]

export interface AppLocation {
  projectId: string | null
  pane: Pane
  /** null in the `chats` pane means a new conversation. */
  sessionId: string | null
}

const EMPTY: AppLocation = {
  projectId: null,
  pane: "board",
  sessionId: null,
}

export function parseLocation(hash: string): AppLocation {
  // "#/p/<projectId>/board" or "#/p/<projectId>/chats/<sessionId>".
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean)
  if (parts[0] !== "p" || !parts[1]) return EMPTY

  const named = parts[2] as Pane | undefined
  // The board is the front door: it is the one view that answers "what now" —
  // and so it is also where an unrecognised pane lands, including a saved
  // location left over from the `git` pane this app used to have.
  const pane: Pane = named && PANES.includes(named) ? named : "board"
  return {
    projectId: parts[1],
    pane,
    sessionId: pane === "chats" ? (parts[3] ?? null) : null,
  }
}

export function formatLocation(loc: AppLocation): string {
  if (!loc.projectId) return "#/"
  const id = loc.pane === "chats" ? loc.sessionId : null
  return `#/p/${loc.projectId}/${loc.pane}${id ? `/${id}` : ""}`
}

export function useAppLocation(): [AppLocation, (patch: Partial<AppLocation>) => void] {
  const [loc, setLoc] = useState<AppLocation>(() => {
    const fromHash = parseLocation(window.location.hash)
    if (fromHash.projectId) return fromHash
    try {
      const saved = window.localStorage.getItem(REMEMBERED)
      if (saved) return parseLocation(saved)
    } catch {
      // Private mode, or storage disabled. Not knowing where you were is a
      // smaller problem than failing to start.
    }
    return EMPTY
  })

  // Back and forward, and anything else that rewrites the hash.
  useEffect(() => {
    const onHashChange = () => setLoc(parseLocation(window.location.hash))
    window.addEventListener("hashchange", onHashChange)
    return () => window.removeEventListener("hashchange", onHashChange)
  }, [])

  // Keep the address bar and the mirror in step with wherever we ended up,
  // including the restored-from-storage case on first paint.
  useEffect(() => {
    const next = formatLocation(loc)
    if (window.location.hash !== next) {
      // replaceState, not `location.hash =`: this runs on every render that
      // changed the location, and assigning the hash would push a history entry
      // for the restore itself — so the first Back would land you nowhere.
      window.history.replaceState(null, "", next)
    }
    try {
      window.localStorage.setItem(REMEMBERED, next)
    } catch {
      /* nothing to do about it */
    }
  }, [loc])

  const navigate = useCallback((patch: Partial<AppLocation>) => {
    setLoc((prev) => {
      const next = { ...prev, ...patch }
      // Selecting a different project cannot keep the old selection: a session
      // id from another project resolves to nothing.
      if (patch.projectId !== undefined && patch.projectId !== prev.projectId) {
        next.sessionId = null
      }
      const href = formatLocation(next)
      if (href !== formatLocation(prev)) {
        // A real navigation, so it earns a history entry — this is what makes
        // Back step between conversations rather than out of the app.
        window.history.pushState(null, "", href)
      }
      return next
    })
  }, [])

  // pushState does not fire hashchange, so popstate is what carries Back and
  // Forward for the entries navigate() creates.
  useEffect(() => {
    const onPop = () => setLoc(parseLocation(window.location.hash))
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])

  return [loc, navigate]
}
