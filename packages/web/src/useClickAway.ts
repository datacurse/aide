import { useEffect, useRef } from "react"

/**
 * Close a menu when the next click lands outside it.
 *
 * Shared by the composer's two pickers and the settings panel rather than
 * written three times, because the failure of another copy is not a duplicate
 * listener — it is one of the menus staying open under another, which on a row
 * of controls this narrow means the open one covers the button you were
 * reaching for.
 */
export function useClickAway(open: boolean, close: () => void) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) close()
    }
    document.addEventListener("mousedown", away)
    return () => document.removeEventListener("mousedown", away)
  }, [open, close])
  return box
}
