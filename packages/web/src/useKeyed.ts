import { useCallback, useState } from "react"

/**
 * The last answer for each key, kept while you are looking at another one.
 *
 * Every pane in aide is a reading of one project, and switching projects used to
 * throw all of them away at once: the chat list, the transcript, the uncommitted
 * list and the history each blanked to "Reading…" and then repainted a fetch
 * later. Going back to a project you had been in a second ago flashed the whole
 * window, which is the flicker this exists to remove.
 *
 * The blanking was not laziness. It enforced a real rule — a rail must never
 * show one repository's files under another repository's name — and holding the
 * previous pane's contents for a beat would have broken it. Addressing the value
 * by key keeps the rule and drops the flash: what you land on is that project's
 * OWN last answer, no more stale than the poll that is already on its way to
 * replace it.
 *
 * It is also the stronger version of the rule, because a write that names its
 * key cannot be misfiled by arriving late. Blanking could: two `git status`
 * calls straddling a switch — a slow one on the repo you left, a fast one on the
 * repo you arrived at — landed in the order they answered, so the old project's
 * files appeared under the new project's name until the next poll corrected it.
 */

/**
 * How many keys are worth keeping.
 *
 * Small because one of these holds transcripts, and a conversation view is up to
 * 1500 messages — an unbounded map of them is a page that grows for as long as
 * you keep clicking. Eight is more projects than anyone has open and more chats
 * than any switch crosses; the ninth costs one fetch, which is what every switch
 * used to cost.
 */
const KEEP = 8

export function useKeyed<T>(
  key: string | null,
): [T | null, (forKey: string | null, value: T | null) => void] {
  const [seen, setSeen] = useState<ReadonlyMap<string, T>>(() => new Map())

  /**
   * `forKey` is the key the value was FETCHED for, not whatever is open when it
   * answers — see above, that difference is the point. Null forgets one, for the
   * answer that says the last one is no longer true.
   */
  const remember = useCallback((forKey: string | null, value: T | null) => {
    if (forKey === null) return
    setSeen((prev) => {
      if (value === null) {
        if (!prev.has(forKey)) return prev
        const next = new Map(prev)
        next.delete(forKey)
        return next
      }
      if (prev.get(forKey) === value) return prev
      const next = new Map(prev)
      // Deleted before it is set, so re-answering moves a key to the end: a Map
      // iterates in insertion order, and without this the eviction below would
      // drop whichever key was first WRITTEN — which on a project you have been
      // sitting in for an hour is the one being polled right now.
      next.delete(forKey)
      next.set(forKey, value)
      while (next.size > KEEP) {
        const oldest = next.keys().next().value
        if (oldest === undefined) break
        next.delete(oldest)
      }
      return next
    })
  }, [])

  return [key === null ? null : (seen.get(key) ?? null), remember]
}
