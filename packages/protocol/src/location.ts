/**
 * Where you are in the app, as a string and back again.
 *
 * ## Why this is in protocol rather than beside the hook that uses it
 *
 * It is pure — no `window`, no storage — but it used to live in
 * `web/useAppLocation.ts`, which touches both, and so could not be imported from
 * Node. That put the one part of the app's routing that can be silently wrong
 * beyond the reach of `pnpm smoke`, which is the same trap `mergedMode` was
 * moved here to escape.
 *
 * "Silently wrong" is not hypothetical for this pair. They are inverses, and the
 * failure of a round trip is not an error anywhere — it is a URL that parses to
 * a place you did not ask for, or a reload that lands somewhere else. Both look
 * like the app forgetting what you had open rather than like a parser bug.
 */

export interface AppLocation {
  /**
   * The dashboard is open, over everything else.
   *
   * A field beside the project rather than a project id of its own, because it
   * is not a place in the four panes — it is the whole window, and closing it
   * has to put you back exactly where you were. Keeping the project and chat
   * alongside is what makes that free: closing clears this one flag and the
   * panes behind it were never navigated away from.
   */
  activity: boolean
  /**
   * The wall is open: one column per project, each showing that project's
   * current chat.
   *
   * A flag beside the project for exactly the reasons `activity` is, and never
   * set at the same time as it. They are two whole-window pages, so a
   * hand-written URL naming both opens the one written first rather than
   * producing some third state.
   */
  wall: boolean
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

export const EMPTY_LOCATION: AppLocation = {
  activity: false,
  wall: false,
  projectId: null,
  sessionId: null,
  draftId: null,
}

export function parseLocation(hash: string): AppLocation {
  // "#/p/<projectId>", "#/p/<projectId>/<sessionId>" or "#/p/<projectId>/new/<draftId>",
  // optionally under a leading "#/activity/…" or "#/wall/…" when one of the
  // whole-window pages is open over it.
  let parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean)

  // Both are PREFIXES rather than locations of their own, so the project and
  // chat underneath survive in the URL — which is what lets closing either put
  // you back where you were, including after a reload.
  const activity = parts[0] === "activity"
  const wall = !activity && parts[0] === "wall"
  if (activity || wall) parts = parts.slice(1)

  if (parts[0] !== "p" || !parts[1]) return { ...EMPTY_LOCATION, activity, wall }
  const projectId = parts[1]
  const at = (rest: Omit<AppLocation, "activity" | "wall" | "projectId">) => ({
    activity,
    wall,
    projectId,
    ...rest,
  })

  if (parts[2] === "new") return at({ sessionId: null, draftId: parts[3] ?? null })
  // Saved locations from when this app had panes: "#/p/<id>/chats/<sessionId>"
  // and "#/p/<id>/board". Both land on the project with nothing open rather than
  // on a 404, because the mirror in localStorage outlives the layout.
  if (parts[2] === "chats") return at({ sessionId: parts[3] ?? null, draftId: null })
  if (parts[2] === "board") return at({ sessionId: null, draftId: null })
  return at({ sessionId: parts[2] ?? null, draftId: null })
}

export function formatLocation(loc: AppLocation): string {
  const prefix = loc.activity ? "#/activity" : loc.wall ? "#/wall" : "#"
  if (!loc.projectId) return `${prefix}/`
  if (loc.draftId) return `${prefix}/p/${loc.projectId}/new/${loc.draftId}`
  if (loc.sessionId) return `${prefix}/p/${loc.projectId}/${loc.sessionId}`
  return `${prefix}/p/${loc.projectId}`
}
