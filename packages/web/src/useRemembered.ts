import { useCallback, useState } from "react"

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

  const set = useCallback(
    (next: T) => {
      setValue(next)
      try {
        window.localStorage.setItem(key, JSON.stringify(next))
      } catch {
        /* the choice still applies for this page */
      }
    },
    [key],
  )

  return [value, set]
}
