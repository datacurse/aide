import { useCallback, useEffect, useState } from "react"

/**
 * Everybody holding the same key, so a change reaches all of them.
 *
 * Two components can remember the same preference — the typing toggle is in the
 * composer and the transcript it acts on is a pane away — and each `useState`
 * reads localStorage once, at mount. Without this the writer updates and the
 * reader does not, so the switch reads as broken and stays broken until a
 * reload. The `storage` event does not cover it: browsers fire that at OTHER
 * tabs, never at the one that did the writing.
 */
const listeners = new Map<string, Set<(v: unknown) => void>>()

/**
 * A preference that outlives the page.
 *
 * For the settings you choose once and expect to stay chosen — the chat mode,
 * the effort level. Component state resets them on every reload, which turns a
 * decision into a chore: pick Auto, reload, get asked to approve a command,
 * remember you have to pick Auto again.
 *
 * Validated on read rather than trusted. localStorage is editable by hand and
 * survives across versions, so a value that was legal last month can be garbage
 * today — and these feed straight into the SDK's permission mode, where an
 * unrecognised string is not a cosmetic problem.
 */
export function useRemembered<T>(
  key: string,
  fallback: T,
  isValid: (v: unknown) => v is T,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key)
      if (raw !== null) {
        const parsed: unknown = JSON.parse(raw)
        if (isValid(parsed)) return parsed
      }
    } catch {
      // Private mode, disabled storage, or malformed JSON. The fallback is
      // always safe, so there is nothing to report.
    }
    return fallback
  })

  // Subscribed to the key rather than to the other component, which this one
  // has no way to name. Validated again on the way in for the same reason it is
  // validated on read: the sender is another copy of this hook, but nothing in
  // the types says the two agreed on T.
  useEffect(() => {
    const heard = (v: unknown) => {
      if (isValid(v)) setValue(v)
    }
    const set = listeners.get(key) ?? new Set()
    set.add(heard)
    listeners.set(key, set)
    return () => {
      set.delete(heard)
      if (set.size === 0) listeners.delete(key)
    }
    // `isValid` is left out deliberately: it is written inline at most call
    // sites, so a new identity every render would resubscribe every render.
    // Which predicate it is cannot change for a given key.
  }, [key])

  const set = useCallback(
    (next: T) => {
      setValue(next)
      try {
        window.localStorage.setItem(key, JSON.stringify(next))
      } catch {
        /* the choice still applies for this page */
      }
      // After the write, so anything that reads storage in response sees the
      // new value rather than the one being replaced.
      for (const heard of listeners.get(key) ?? []) heard(next)
    },
    [key],
  )

  return [value, set]
}
