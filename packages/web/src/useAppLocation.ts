import { useCallback, useEffect, useState } from "react"
import { EMPTY_LOCATION as EMPTY, formatLocation, parseLocation, type AppLocation } from "@aide/protocol"

// Re-exported so the components that draw a location import it from the hook
// they already use, rather than from two places to do one thing.
export { formatLocation, parseLocation, type AppLocation }

/**
 * Where you are, in the URL.
 *
 * The parsing and the formatting are in `protocol/location.ts` — they are pure,
 * and this file is not, so leaving them here put the one part of routing that
 * can be silently wrong out of `pnpm smoke`'s reach. See that file.
 *
 * Held in `location.hash` rather than in component state, because component
 * state does not survive a reload and this is the state you least want to
 * rebuild by hand: which project, which conversation. Putting it in
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
 *
 * It also keeps the chat each project was last left on, which is the other case
 * a single location cannot cover — see REMEMBERED_CHATS. That one is consulted
 * only when a move to another project would otherwise open nothing, so it never
 * argues with a URL either.
 */

const REMEMBERED = "aide.location"
/**
 * Which chat each project was last left on, `{ [projectId]: hash }`.
 *
 * A second store rather than a field on the one above, because that one only
 * ever holds the single place you were most recently — so every trip to another
 * project and back dropped you on an empty pane, with the conversation you were
 * in the middle of somewhere in a thirty-row list under a title you half
 * remember.
 *
 * Values are whole locations, the same strings `formatLocation` writes, so a
 * hand-edited or stale entry costs nothing: `parseLocation` already turns
 * anything it does not recognise into "this project, nothing open".
 */
const REMEMBERED_CHATS = "aide.open-chats"

/** Which chat is open, the half of a location that belongs to a project. */
type OpenChat = Pick<AppLocation, "sessionId" | "draftId">

const NO_CHAT: OpenChat = { sessionId: null, draftId: null }

function readOpenChats(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(REMEMBERED_CHATS)
    const parsed: unknown = raw === null ? null : JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    )
  } catch {
    // Private mode, storage disabled, or malformed JSON. Landing on nothing open
    // is the behaviour this replaced, so there is nothing to report.
    return {}
  }
}

/**
 * Where a project was left, or nothing open if it has not been visited.
 *
 * What makes moving between projects cheap: each arrival reopens that project's
 * own last chat rather than a blank pane, so following two pieces of work at
 * once does not cost you the one you left.
 */
function rememberedChat(projectId: string | null): OpenChat {
  if (!projectId) return NO_CHAT
  const saved = readOpenChats()[projectId]
  if (saved === undefined) return NO_CHAT
  const loc = parseLocation(saved)
  // A saved entry naming a different project would open one project's
  // conversation under another's name, which the pane would then fetch and fail
  // on. Cheap to check, and the only way in is a hand-edited store.
  if (loc.projectId !== projectId) return NO_CHAT
  return { sessionId: loc.sessionId, draftId: loc.draftId }
}

function writeOpenChat(projectId: string, href: string): void {
  try {
    const all = readOpenChats()
    if (all[projectId] === href) return
    all[projectId] = href
    window.localStorage.setItem(REMEMBERED_CHATS, JSON.stringify(all))
  } catch {
    /* the selection still holds for this page */
  }
}

function rememberChat(loc: AppLocation): void {
  if (!loc.projectId) return
  // Stored WITHOUT the whole-window prefix. This records which chat a project was
  // left on, and the dashboard is not a chat — saving one here would mean
  // arriving at a project from anywhere reopened that page over it.
  writeOpenChat(loc.projectId, formatLocation({ ...loc, activity: false }))
}

export function useAppLocation(): [AppLocation, (patch: Partial<AppLocation>) => void] {
  const [loc, setLoc] = useState<AppLocation>(() => {
    const fromHash = parseLocation(window.location.hash)
    // The dashboard as well as a project: a bare "#/activity" is a complete
    // location — it is about every project, so it needs none — and testing only
    // for a project id would drop it and restore the mirror instead, which is the
    // one case a shared link to that page consists of.
    if (fromHash.projectId || fromHash.activity) return fromHash
    try {
      const saved = window.localStorage.getItem(REMEMBERED)
      // The mirror is for landing back where you were working, which is a
      // project. A fresh tab should not open onto the dashboard because that is
      // where the last one happened to be left.
      if (saved) return { ...parseLocation(saved), activity: false }
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
    // Recorded on arrival as well as on every later move, so the project you are
    // in right now is already remembered before you leave it — including the one
    // restored from storage on first paint.
    rememberChat(loc)
  }, [loc])

  const navigate = useCallback((patch: Partial<AppLocation>) => {
    setLoc((prev) => {
      // Selecting a different project cannot keep the old selection: neither a
      // session id nor a draft id from another project resolves to anything.
      // What takes its place is that project's own last chat rather than a blank
      // pane — moving between projects is how you follow two pieces of work at
      // once, and each arrival was costing you the one you had left there.
      //
      // Under the patch rather than over it, so a move that names a chat as well
      // as a project still opens the chat it named.
      const moved = patch.projectId !== undefined && patch.projectId !== prev.projectId
      const next = moved
        ? { ...prev, ...rememberedChat(patch.projectId ?? null), ...patch }
        : { ...prev, ...patch }
      // The two are one field wearing two names — opening either closes the
      // other, so a patch naming one clears the other unless it named both.
      if (patch.sessionId !== undefined && patch.draftId === undefined) next.draftId = null
      if (patch.draftId !== undefined && patch.sessionId === undefined) next.sessionId = null
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
