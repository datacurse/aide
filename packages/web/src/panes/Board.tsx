import { useRef, useState } from "react"
import type { BoardRow, BoardRowState } from "@aide/protocol"
import { Markdown } from "../Markdown.js"
import { Empty, PaneHeader } from "../ui.js"
import { useAutoGrow } from "../useAutoGrow.js"

/**
 * The board: what you want, next to what is built.
 *
 * The backlog is the middle column and the spec is the main pane, which is not
 * an arbitrary layout choice — seeing the gap between the two is the whole point
 * of the view, and a tab that shows one at a time cannot show a gap.
 *
 * A list, not a Kanban. Columns group work by a state that changes twice an hour
 * and tell you nothing you could not read from a badge, while costing the one
 * thing a backlog actually needs, which is being scannable top to bottom in the
 * order you should care.
 *
 * Rows carry the state of whatever conversation is working them, so a row that
 * an agent already has in hand is visibly taken. Without that, the natural thing
 * to do with a stale backlog is start a second chat on a row the first one is
 * halfway through.
 */

const STATE_STYLE: Record<BoardRowState, { dot: string; text: string; label: string }> = {
  idle: { dot: "bg-fg-dim/50", text: "text-fg-dim", label: "" },
  working: { dot: "bg-info animate-pulse", text: "text-info", label: "working" },
  "needs-you": { dot: "bg-warn", text: "text-warn", label: "needs you" },
}

function Row({
  row,
  onOpen,
  onDelete,
}: {
  row: BoardRow
  onOpen: (row: BoardRow) => void
  onDelete: (row: BoardRow) => void
}) {
  const style = STATE_STYLE[row.state]
  // Blocked outranks the row's own state in the badge as well as in the sort: a
  // conversation sitting on an unanswered permission prompt is not merely
  // waiting, it is stopped, and it is stopped on you.
  const label = row.blocked ? "blocked" : style.label
  const tone = row.blocked ? "text-err" : style.text

  return (
    <div className="group flex w-full items-start gap-2 px-3 py-[3px] text-left font-sans text-[13px] text-fg-muted hover:bg-hover">
      <button
        type="button"
        onClick={() => onOpen(row)}
        // items-start, not items-center: a row is as tall as its text now, and
        // centring would leave the dot and the id floating against the middle of
        // a three-line request.
        className="flex min-w-0 flex-1 items-start gap-2 text-left"
        title={
          row.sessionId
            ? "Open the conversation working this"
            : "Start a chat about this. It fills the message box — you still press send."
        }
      >
        <span className={`mt-1.5 inline-block size-2 shrink-0 rounded-full ${style.dot}`} />
        <span className="w-8 shrink-0 text-fg-dim">{row.id}</span>
        {/* Wrapped, not truncated. A row is a sentence, and an ellipsis eats the
            half of it that says which thing it is about — leaving a backlog
            where three rows all read "not a fan of…". */}
        <span className="min-w-0 flex-1 break-words">{row.text}</span>
        {label && <span className={`mt-0.5 shrink-0 text-[10px] ${tone}`}>{label}</span>}
      </button>
      <button
        type="button"
        onClick={() => onDelete(row)}
        // Only on hover: a backlog is read far more often than it is pruned, and
        // a delete button on every row turns scanning into dodging.
        className="shrink-0 text-[11px] text-fg-dim opacity-0 group-hover:opacity-100 hover:text-err"
        title="Remove this row"
      >
        ×
      </button>
    </div>
  )
}

export function BoardList({
  projectId,
  rows,
  warnings,
  onOpen,
  onAdd,
  onDelete,
}: {
  projectId: string | null
  rows: BoardRow[]
  /** Project-state problems that would otherwise fail silently. Usually empty. */
  warnings: string[]
  onOpen: (row: BoardRow) => void
  onAdd: (text: string) => void
  onDelete: (row: BoardRow) => void
}) {
  const [text, setText] = useState("")
  const box = useRef<HTMLTextAreaElement>(null)
  useAutoGrow(box, text, { minRows: 1, maxRows: 8 })

  const submit = () => {
    if (!text.trim()) return
    // Collapsed to one line on the way out. The box wraps so you can SEE the
    // whole request, but `todos.md` is line-based — a row containing a newline
    // would come back from the next parse as two rows, the second unnumbered.
    onAdd(text.trim().replace(/\s*\r?\n\s*/g, " "))
    setText("")
  }

  if (!projectId) return <Empty>Select a project.</Empty>

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-line bg-editor p-2">
        {/* A textarea, not an input. An input scrolls sideways once the text
            passes the width of the box, so the sentence you are in the middle of
            writing slides off the left edge as you type it. This wraps, and
            grows a line at a time up to a cap. */}
        <textarea
          ref={box}
          value={text}
          onChange={(e) => setText(e.target.value)}
          // Enter rather than a button as the primary path. Capturing an idea has
          // to cost one line typed, or it loses to saying the thing in a chat and
          // the backlog stops being true.
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          rows={1}
          placeholder="Something you want. Enter to add."
          className="w-full resize-none rounded border border-line-soft bg-input px-2 py-1 font-sans text-xs leading-relaxed outline-none placeholder:text-fg-dim focus:border-accent"
        />
      </div>

      {warnings.map((w) => (
        <p key={w} className="border-b border-line px-3 py-1.5 font-sans text-[11px] text-warn">
          {w}
        </p>
      ))}

      <div className="flex-1 overflow-auto py-1">
        {rows.length === 0 ? (
          <Empty>Nothing yet. What you add lands in .aide/todos.md.</Empty>
        ) : (
          rows.map((row) => (
            <Row key={row.id} row={row} onOpen={onOpen} onDelete={onDelete} />
          ))
        )}
      </div>
    </div>
  )
}

/**
 * The spec, rendered.
 *
 * Read-only here on purpose. It is written by agents inside a diff you review at
 * the commit gate — an editable box in this pane would be a second way in that
 * skips that review, and the whole reason the spec is trustworthy is that
 * nothing reaches it without passing one.
 */
export function SpecPane({ spec }: { spec: string }) {
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-editor">
      <PaneHeader title="spec" />
      <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
        {spec.trim() ? (
          <Markdown text={spec} />
        ) : (
          <Empty>
            No .aide/spec.md yet. It describes what the app can and cannot do, and agents
            write it as part of the change that earns the claim.
          </Empty>
        )}
      </div>
    </section>
  )
}

/** Shown in the board's header: how much of the backlog is already moving. */
export function BoardSummary({ rows }: { rows: BoardRow[] }) {
  const live = rows.filter((r) => r.sessionId).length
  if (live === 0) return null
  return (
    <span className="mr-1 text-[10px] text-fg-dim">
      {live}/{rows.length} in flight
    </span>
  )
}
