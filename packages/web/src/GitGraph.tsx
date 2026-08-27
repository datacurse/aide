import type { GitGraphRow } from "@aide/protocol"
import {
  ROW_H,
  STROKE,
  colorOf,
  dotAt,
  graphWidth,
  pathOf,
  segmentsFor,
} from "./graph.js"

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
        <path
          key={i}
          d={pathOf(s)}
          stroke={colorOf(s.color)}
          strokeWidth={STROKE}
          fill="none"
        />
      ))}
    </>
  )
}

/**
 * One row of the graph.
 *
 * Merges are drawn as a ring rather than a disc. It is the one distinction worth
 * spending a shape on in an aide-managed repo: every landed task is a `--no-ff`
 * merge, so the rings are the history of what aide shipped and the discs between
 * them are what was done by hand.
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
        fill={merge ? "var(--color-editor)" : color}
        stroke={color}
        strokeWidth={merge ? 2 : 0}
      />
    </svg>
  )
}

/**
 * The working tree's own node, above the newest commit.
 *
 * Dashed and hollow because it is the one row in the column that is not a commit
 * and may never become one. The line down to HEAD is drawn only when the row
 * below really is HEAD: `--branches` can put another branch's tip at the top of
 * the page, and a line joining the working tree to a commit it is not sitting on
 * is worse than no line at all.
 */
export function WorkingTreeCell({
  lanes,
  lane,
  dirty,
  connected,
}: {
  lanes: number
  lane: number
  dirty: boolean
  connected: boolean
}) {
  const width = graphWidth(lanes)
  const color = dirty ? "var(--color-warn)" : "var(--color-fg-dim)"
  const [cx, cy] = dotAt(lane)
  return (
    <svg
      width={width}
      height={ROW_H}
      viewBox={`0 0 ${width} ${ROW_H}`}
      className="shrink-0"
      aria-hidden="true"
    >
      {connected && (
        <path
          d={`M ${cx} ${cy} V ${ROW_H}`}
          stroke={color}
          strokeWidth={STROKE}
          strokeDasharray="2 3"
          fill="none"
        />
      )}
      <circle
        cx={cx}
        cy={cy}
        r={4}
        fill="var(--color-editor)"
        stroke={color}
        strokeWidth={1.5}
        strokeDasharray="2 2"
      />
    </svg>
  )
}
