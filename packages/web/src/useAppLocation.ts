import { useCallback, useEffect, useState } from "react"

/**
 * Where you are, in the URL.
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

/** Where a project was left, or nothing open if it has not been visited. */
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

function rememberChat(loc: AppLocation): void {
  if (!loc.projectId) return
  try {
    const all = readOpenChats()
    all[loc.projectId] = formatLocation(loc)
    window.localStorage.setItem(REMEMBERED_CHATS, JSON.stringify(all))
  } catch {
    /* the selection still holds for this page */
  }
}

export interface AppLocation {
  projectId: string | null
  /** A conversation the daemon knows about. Null when an unstarted one is open. */
  sessionId: string | null
  /**
   * A chat that has not been sent yet, by its local draft id.
   *
   * Never set at the same time as `sessionId` — they are the two halves of "which
   * chat is open", split because only one of them means anything to the daemon.
   * It survives a reload for the same reason the session id does: an idea you
   * typed and did not send is exactly the thing you would hate to have to find
   * again.
   */
  draftId: string | null
}

const EMPTY: AppLocation = {
  projectId: null,
  sessionId: null,
  draftId: null,
}

export function parseLocation(hash: string): AppLocation {
  // "#/p/<projectId>", "#/p/<projectId>/<sessionId>" or "#/p/<projectId>/new/<draftId>".
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean)
  if (parts[0] !== "p" || !parts[1]) return EMPTY
  const projectId = parts[1]

  if (parts[2] === "new") return { projectId, sessionId: null, draftId: parts[3] ?? null }
  // Saved locations from when this app had panes: "#/p/<id>/chats/<sessionId>"
  // and "#/p/<id>/board". Both land on the project with nothing open rather than
  // on a 404, because the mirror in localStorage outlives the layout.
  if (parts[2] === "chats") return { projectId, sessionId: parts[3] ?? null, draftId: null }
  if (parts[2] === "board") return { projectId, sessionId: null, draftId: null }
  return { projectId, sessionId: parts[2] ?? null, draftId: null }
}

export function formatLocation(loc: AppLocation): string {
  if (!loc.projectId) return "#/"
  if (loc.draftId) return `#/p/${loc.projectId}/new/${loc.draftId}`
  if (loc.sessionId) return `#/p/${loc.projectId}/${loc.sessionId}`
  return `#/p/${loc.projectId}`
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
