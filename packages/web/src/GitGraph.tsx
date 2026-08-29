import type { GitGraphRow } from "@aide/protocol"
import { ROW_H, STROKE, colorOf, dotAt, graphWidth, pathOf, segmentsFor } from "./graph.js"

/**
 * The commit graph, drawn.
 *
 * One SVG per row rather than one for the whole list, and that is what makes it
 * survive a list that scrolls, polls and grows: a row draws itself from its own
 * `GitGraphRow` and nothing else, so appending fifty commits or swapping the
 * page mid-poll cannot leave a line pointing at a row that has moved. Where the
 * lines go is in graph.ts; which lane they are in was decided by the daemon,
 * where `pnpm smoke` can check it.
 */

export { ROW_H, graphWidth } from "./graph.js"

function Lines({ row }: { row: GitGraphRow }) {
  return (
    <>
      {segmentsFor(row).map((s, i) => (
        <path key={i} d={pathOf(s)} stroke={colorOf(s.color)} strokeWidth={STROKE} fill="none" />
      ))}
    </>
  )
}

/**
 * One row of the graph.
 *
 * Merges are drawn as a ring rather than a disc. aide makes none of its own any
 * more — there are no branches to merge, only commits onto the checkout — so a
 * ring here is always something you did in a terminal, which is exactly when a
 * history you are reading to get your bearings should not look ordinary.
 */
export function GraphCell({
  row,
  lanes,
  head,
}: {
  row: GitGraphRow
  lanes: number
  /** The commit the working tree is sitting on, drawn with a halo. */
  head?: boolean
}) {
  const width = graphWidth(lanes)
  const merge = row.leaves.length > 1
  const color = colorOf(row.color)
  const [cx, cy] = dotAt(row.lane)
  return (
    <svg
      width={width}
      height={ROW_H}
      viewBox={`0 0 ${width} ${ROW_H}`}
      className="shrink-0"
      aria-hidden="true"
    >
      <Lines row={row} />
      {head && (
        <circle cx={cx} cy={cy} r={6.5} fill="none" stroke={color} strokeWidth={1} opacity={0.45} />
      )}
      <circle
        cx={cx}
        cy={cy}
        r={merge ? 4.5 : 4}
        fill={merge ? "var(--color-chrome)" : color}
        stroke={color}
        strokeWidth={merge ? 2 : 0}
      />
    </svg>
  )
}
