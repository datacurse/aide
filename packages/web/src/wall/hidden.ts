import { useCallback } from "react"
import { withHidden } from "@aide/protocol"
import { useRemembered } from "../useRemembered.js"

/**
 * Which projects the wall is not drawing a column for.
 *
 * ## Why this is not `forget`
 *
 * `forget` already exists on a column and drops the registry entry — the project
 * stops existing for aide entirely, in every pane, for every view. This is the
 * much smaller thing that was missing: a project you are not working on THIS
 * WEEK, which you want out of the way of the four you are. Nothing about the
 * project changes, no request stops being made anywhere else, and the panes are
 * untouched; the wall simply does not draw it.
 *
 * The two live side by side in the same header and the distinction has to survive
 * a glance, which is why the labels are `hide` and `forget` rather than two
 * shades of removal — see `EyeSlash`, which carries the same argument for the
 * glyph.
 *
 * ## Why localStorage, and why NOT the daemon
 *
 * Hiding is a property of this screen, not of the project. The registry is the
 * daemon's and describes what exists; a `hidden` flag there would be aide
 * remembering, on disk and for every browser that connects, that you were not
 * interested in a repository on Tuesday — and it would then have to be honoured
 * or deliberately ignored by every other surface that lists projects. Keeping it
 * in the browser makes it exactly what it looks like: a view setting.
 *
 * ## Why it is remembered at all
 *
 * The wall's `full` flip is deliberately NOT remembered, and the reasoning there
 * — a preference means opening the wall tomorrow to five transcripts — is what
 * makes this one the opposite case. Hiding is a statement about what you are
 * working on, which is stable across days and is the whole reason to bother; a
 * hide that reset on reload would have to be redone every morning and nobody
 * would use it twice. The escape hatch is that the count is always on screen, so
 * a hidden column can never be silently forgotten about.
 *
 * ## Stored as a LIST of ids
 *
 * Not a per-project boolean and not a map, so the stored value is
 * `["<id>", …]` — the set of exceptions, which is almost always empty or tiny.
 * A map would accumulate a `false` for every project ever un-hidden and keep
 * entries for projects that have since been forgotten; a list of what is
 * currently hidden has nothing to prune, and an id in it that no longer resolves
 * to a project simply never matches.
 *
 * The rules OVER that list — which columns are drawn, how many are hidden, and
 * that an id never appears twice — are `splitHiddenColumns` and `withHidden` in
 * protocol, not here. This file is the storage and the subscription; those are
 * the arithmetic, and they are where `pnpm smoke` can reach them.
 */
const HIDDEN_KEY = "aide.wall.hidden"

const isIdList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string")

export type HiddenColumns = {
  /** Project ids currently hidden, in the order they were hidden. */
  ids: readonly string[]
  hide: (projectId: string) => void
  /** Bring every hidden column back, for the "4 hidden" control. */
  showAll: () => void
}

export function useHiddenColumns(): HiddenColumns {
  const [ids, setIds] = useRemembered<string[]>(HIDDEN_KEY, [], isIdList)

  // `withHidden` rather than a bare append — the no-duplicates rule lives in
  // protocol beside the split that depends on it, so `pnpm smoke` can assert
  // both halves together.
  const hide = useCallback((projectId: string) => setIds(withHidden(ids, projectId)), [ids, setIds])

  const showAll = useCallback(() => setIds([]), [setIds])

  return { ids, hide, showAll }
}
