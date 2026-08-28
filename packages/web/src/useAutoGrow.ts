import { useLayoutEffect, type RefObject } from "react"

/**
 * Grow a textarea to fit what is in it.
 *
 * Counting newlines — which is what the composer did — measures the wrong
 * thing: a sentence typed without pressing Enter is one "line" and gets one row,
 * so the box scrolls its own beginning out of sight while you are still writing
 * it. The browser already knows how tall the wrapped text is; `scrollHeight` is
 * that number, and this asks for it.
 */
export function useAutoGrow(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  { minRows = 1, maxRows = 10 }: { minRows?: number; maxRows?: number } = {},
): void {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return

    const fit = () => {
      const style = getComputedStyle(el)
      const line =
        Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.5 || 16
      // Tailwind's preflight puts every box on border-box, so scrollHeight
      // covers the padding but never the border. Add it back, or the box is two
      // pixels short and scrolls by a sliver at every size.
      const border =
        Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth)
      const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom)

      // Collapse before measuring. scrollHeight is the larger of the content and
      // the box, so measuring a box that is already tall just returns its own
      // height — and it would never shrink back after a deletion.
      el.style.height = "0px"
      const content = el.scrollHeight
      const wanted = Math.min(Math.max(content, minRows * line + padding), maxRows * line + padding)
      el.style.height = `${wanted + border}px`
      // Only scroll once it has stopped growing, so a scrollbar does not appear
      // and vanish on every keystroke below the cap.
      el.style.overflowY = content > maxRows * line + padding ? "auto" : "hidden"
    }

    fit()
    // Width decides where the text wraps, so a narrower window means more rows.
    window.addEventListener("resize", fit)
    return () => window.removeEventListener("resize", fit)
  }, [ref, value, minRows, maxRows])
}
