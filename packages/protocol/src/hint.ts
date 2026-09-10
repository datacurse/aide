/**
 * Where a hover hint goes: the arithmetic behind `Hint` in the web package.
 *
 * Here rather than in the component for the reason `location.ts` and
 * `activity-line.ts` are here — it is pure, and it is the half that fails
 * SILENTLY. A hint that opens is not an error however badly it is placed: a box
 * half off the right edge of the window is still a rendered tooltip, and a box
 * flipped under the pointer is still a rendered tooltip. Nothing throws, nothing
 * logs, and the only report is somebody noticing they cannot read it. A React
 * component cannot be asserted from `pnpm smoke`; this can.
 *
 * The web package's `Hint.tsx` holds the hover timing, the portal and the paint,
 * and calls this for the numbers.
 */

/** Gap between the hinted element and the box, in px. */
export const HINT_OFFSET = 6

/** How near the viewport edge the box may come before it is pushed back, in px. */
export const HINT_MARGIN = 8

/** How far in from the box's own corner the arrow may sit, in px. */
const ARROW_INSET = 8

export type HintSide = "top" | "bottom"

export type HintRect = { left: number; top: number; right: number; bottom: number }

export type HintPlacement = {
  left: number
  top: number
  side: HintSide
  /** The arrow's x, in px from the box's own left edge. */
  arrow: number
}

/**
 * Place a hint of a known size against the thing it describes.
 *
 * ABOVE by default, because a box below the pointer is under the hand holding
 * the mouse. It flips under only when there is genuinely no room above — and it
 * compares the two ROOMS rather than just testing the default, because near the
 * bottom of a short window neither side fits and flipping there trades a clipped
 * top for a clipped bottom. The default wins that tie, so a hint that cannot fit
 * anywhere is at least always in the same place.
 *
 * Horizontally it centres on the anchor and is then clamped into the viewport.
 * The clamp is applied low-edge-LAST so that a box wider than the window ends up
 * pinned to the left rather than the right: the start of a sentence is the half
 * worth keeping.
 */
export function placeHint(
  anchor: HintRect,
  hint: { width: number; height: number },
  viewport: { width: number; height: number },
): HintPlacement {
  const roomAbove = anchor.top
  const roomBelow = viewport.height - anchor.bottom
  const needed = hint.height + HINT_OFFSET + HINT_MARGIN
  const side: HintSide = roomAbove >= needed || roomAbove >= roomBelow ? "top" : "bottom"
  const top =
    side === "top" ? anchor.top - hint.height - HINT_OFFSET : anchor.bottom + HINT_OFFSET

  const centre = (anchor.left + anchor.right) / 2
  const wanted = centre - hint.width / 2
  const left = Math.max(
    HINT_MARGIN,
    Math.min(wanted, viewport.width - hint.width - HINT_MARGIN),
  )

  // The arrow follows the anchor's centre even after the box has been pushed
  // sideways, so a clamped hint still points at what it describes rather than at
  // its own middle. Kept in from the corners, where the box's rounding and
  // border would otherwise cut it in half.
  const arrow = Math.max(
    ARROW_INSET,
    Math.min(centre - left, Math.max(ARROW_INSET, hint.width - ARROW_INSET)),
  )
  return { left, top, side, arrow }
}
