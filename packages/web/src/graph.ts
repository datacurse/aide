import type { GitGraphRow } from "@aide/protocol"

/**
 * Where the lines go — the geometry of the commit graph, with no markup in it.
 *
 * Split from the component that draws it so there is exactly one description of
 * the shape. The maths here is the part that can be wrong invisibly (a line that
 * stops two pixels short of the row edge is a graph with hairline gaps in it),
 * and keeping it as data rather than as a string of SVG means it can be
 * rasterised and looked at outside a browser.
 *
 * Everything is in row-local pixels: 0 is the top edge of the row, `ROW_H` the
 * bottom. That is the whole contract with the list — every line is drawn edge to
 * edge, so two rows join up if and only if the row box is exactly this tall.
 */

/** Height of one row, in pixels. The list must use this, not a guess. */
export const ROW_H = 44

/** Width of one lane column. Narrow: this is a sidebar, not a diagram. */
export const LANE_W = 14

export const STROKE = 1.5

/**
 * Lane colours. `color` on the wire is an index into this, so a branch keeps one
 * colour for as long as its line lives, and running out simply wraps.
 */
export const PALETTE = [
  "var(--color-graph-1)",
  "var(--color-graph-2)",
  "var(--color-graph-3)",
  "var(--color-graph-4)",
  "var(--color-graph-5)",
]

export const colorOf = (i: number) => PALETTE[i % PALETTE.length] ?? "currentColor"

const MID = ROW_H / 2
const x = (lane: number) => lane * LANE_W + LANE_W / 2

/** Vertical centre of the row — where the dot sits. */
export const dotAt = (lane: number): [number, number] => [x(lane), MID]

/** How wide the column is for a given page. Reserved once, so it never jitters. */
export const graphWidth = (lanes: number) => Math.max(1, lanes) * LANE_W

/**
 * One drawn line, as a cubic curve.
 *
 * A straight line is a degenerate curve rather than a second shape, so nothing
 * downstream has to branch on which kind it is.
 */
export interface Segment {
  from: [number, number]
  c1: [number, number]
  c2: [number, number]
  to: [number, number]
  /** Palette index, not a colour. */
  color: number
}

const straight = (fromX: number, fromY: number, toY: number, color: number): Segment => ({
  from: [fromX, fromY],
  c1: [fromX, fromY],
  c2: [fromX, toY],
  to: [fromX, toY],
  color,
})

/**
 * Every line to draw for one row, in paint order: the ones passing by, then the
 * ones arriving, then the ones leaving. The dot is drawn on top by the caller.
 */
export function segmentsFor(row: GitGraphRow): Segment[] {
  const out: Segment[] = []

  for (const l of row.through) out.push(straight(x(l.lane), 0, ROW_H, l.color))

  // Top edge down into the dot. Same lane is straight; anything else eases
  // across, with the bend nearer the dot so the two curves of a merge meet it
  // symmetrically.
  for (const l of row.enters) {
    if (l.lane === row.lane) {
      out.push(straight(x(row.lane), 0, MID, l.color))
      continue
    }
    out.push({
      from: [x(l.lane), 0],
      c1: [x(l.lane), MID * 0.6],
      c2: [x(row.lane), MID * 0.4],
      to: [x(row.lane), MID],
      color: l.color,
    })
  }

  for (const l of row.leaves) {
    if (l.lane === row.lane) {
      out.push(straight(x(row.lane), MID, ROW_H, l.color))
      continue
    }
    out.push({
      from: [x(row.lane), MID],
      c1: [x(row.lane), MID + MID * 0.4],
      c2: [x(l.lane), ROW_H - MID * 0.6],
      to: [x(l.lane), ROW_H],
      color: l.color,
    })
  }

  return out
}

export const pathOf = (s: Segment) =>
  `M ${s.from[0]} ${s.from[1]} C ${s.c1[0]} ${s.c1[1]}, ${s.c2[0]} ${s.c2[1]}, ${s.to[0]} ${s.to[1]}`
