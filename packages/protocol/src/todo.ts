/**
 * `.aide/todos.md` — the backlog, and the left half of the board.
 *
 * One file, line-based, and forgiving on purpose. Adding an idea has to cost one
 * line typed into a file you already have open, or it loses to saying the thing
 * in a chat and the list stops being true. So a bare `- fix the diff wrapping`
 * is a valid todo; aide numbers it the next time it writes the file.
 *
 * Everything that is not a todo line is preserved verbatim. The file belongs to
 * the human as much as to the daemon, and a parser that silently ate their notes
 * on the first save would be the last time they used it.
 *
 * Pure string handling, no frontmatter, so this stays on the browser-safe side
 * of the package and both ends can render a row from the same definition.
 */

/** A numbered line of the backlog. */
export interface Todo {
  /**
   * Zero-padded and stable. It outlives the row: closing one deletes its line
   * while the commits it produced keep the number in an `Aide-Row` trailer, so
   * an id that reached a commit is never handed out again.
   */
  id: string
  text: string
}

/**
 * One line of the file: either a todo or prose kept as-is.
 *
 * Round-tripping every line rather than rebuilding the file from a `Todo[]` is
 * what lets someone keep headings, blank lines and a paragraph of context in
 * there without aide reformatting their file out from under them.
 */
export type TodoLine =
  | { kind: "todo"; id: string; text: string }
  | { kind: "text"; raw: string }

export interface TodoFile {
  lines: TodoLine[]
}

/** `- [0007] text` — a todo that has already been numbered. */
const NUMBERED = /^\s*-\s+\[(\d{4})\]\s*(.*)$/
/** `- text` — a todo the human just typed. Numbered on the next write. */
const BARE = /^\s*-\s+(.+)$/

/** What a project gets when it has no `todos.md` yet. */
export const DEFAULT_TODOS = `# Todos

One per line, starting with \`-\`. aide numbers them when it saves, and a
numbered line is what a chat can be started from.

`

/**
 * Parse, assigning ids to any unnumbered lines.
 *
 * Numbering happens here rather than in a separate pass so that reading and
 * writing are symmetric: parse then serialize is idempotent, and the file on
 * disk converges on being fully numbered without anyone running a migration.
 */
export function parseTodos(raw: string): TodoFile {
  const source = raw.split(/\r?\n/)

  // Two passes: the highest id already present has to be known before the first
  // unnumbered line can be given one, or a bare line at the top of the file
  // would take an id that a numbered line below it already holds.
  let max = 0
  for (const line of source) {
    const hit = NUMBERED.exec(line)
    if (hit?.[1]) max = Math.max(max, Number.parseInt(hit[1], 10) || 0)
  }

  const lines: TodoLine[] = []
  for (const line of source) {
    const numbered = NUMBERED.exec(line)
    if (numbered?.[1] !== undefined) {
      const text = (numbered[2] ?? "").trim()
      // A numbered line whose text was deleted is not a todo any more. Keeping
      // it as prose rather than dropping it means the id is not silently reused
      // while a branch named after it still exists.
      if (!text) {
        lines.push({ kind: "text", raw: line })
        continue
      }
      lines.push({ kind: "todo", id: numbered[1], text })
      continue
    }

    const bare = BARE.exec(line)
    if (bare?.[1]?.trim()) {
      max += 1
      lines.push({ kind: "todo", id: String(max).padStart(4, "0"), text: bare[1].trim() })
      continue
    }

    lines.push({ kind: "text", raw: line })
  }

  return { lines }
}

export function serializeTodos(file: TodoFile): string {
  const body = file.lines
    .map((l) => (l.kind === "todo" ? `- [${l.id}] ${l.text}` : l.raw))
    .join("\n")
  return body.endsWith("\n") ? body : `${body}\n`
}

/**
 * A row is one line, so anything written into one has to be.
 *
 * Not defensive for its own sake: the board's box wraps now, and a pasted
 * paragraph or a Shift+Enter would otherwise be serialized verbatim — the next
 * parse would read the tail as a second, unnumbered todo and number it, turning
 * one request into two rows that each say half of it.
 */
const oneLine = (text: string) => text.replace(/\s*\r?\n\s*/g, " ").trim()

export const todosOf = (file: TodoFile): Todo[] =>
  file.lines.flatMap((l) => (l.kind === "todo" ? [{ id: l.id, text: l.text }] : []))

/**
 * Append a todo to the end of the file, numbered.
 *
 * `floor` is the highest id known to exist ANYWHERE, not just in this file. Ids
 * must be monotonic across deletions: a closed row is removed from the backlog
 * but its branch and possibly its checkout live on, and reusing the number would
 * point new work at `.aide/worktrees/0004` — an abandoned checkout on somebody
 * else's branch, adopted silently because the directory already exists.
 */
export function appendTodo(
  file: TodoFile,
  text: string,
  floor = 0,
): { file: TodoFile; todo: Todo } {
  const max = todosOf(file).reduce(
    (n, t) => Math.max(n, Number.parseInt(t.id, 10) || 0),
    Math.max(0, floor),
  )
  const todo: Todo = { id: String(max + 1).padStart(4, "0"), text: oneLine(text) }

  // Drop trailing blank lines before appending, then restore one. Without this
  // every append pushes the row further from the last one and the file grows a
  // widening gap at the bottom.
  const lines = [...file.lines]
  while (lines.at(-1)?.kind === "text" && !(lines.at(-1) as { raw: string }).raw.trim()) {
    lines.pop()
  }
  lines.push({ kind: "todo", ...todo }, { kind: "text", raw: "" })
  return { file: { lines }, todo }
}

export function replaceTodo(file: TodoFile, id: string, text: string): TodoFile {
  return {
    lines: file.lines.map((l) =>
      l.kind === "todo" && l.id === id ? { ...l, text: oneLine(text) } : l,
    ),
  }
}

export function removeTodo(file: TodoFile, id: string): TodoFile {
  return { lines: file.lines.filter((l) => !(l.kind === "todo" && l.id === id)) }
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

/**
 * What a row is doing. Derived on every read, never stored.
 *
 * Deliberately not the chat's own status vocabulary: a row with no conversation
 * attached is not "needs you", it is an idea nobody has started. And closed
 * never appears here — closing a chat deletes its row either way. The chat list
 * is where closed work is visible; the backlog only holds what is left.
 */
export type BoardRowState = "idle" | "working" | "needs-you"

export interface BoardRow {
  id: string
  text: string
  /** The conversation working this row, or null while it is just an idea. */
  sessionId: string | null
  state: BoardRowState
  /** A tool call is waiting on a human. Sharpens `needs-you` into "right now". */
  blocked: boolean
}

/** Sorted by what it costs to ignore. Working sorts last: it wants nothing. */
const RANK: Record<BoardRowState, number> = { "needs-you": 0, idle: 1, working: 2 }

export function sortBoard(rows: readonly BoardRow[]): BoardRow[] {
  return [...rows].sort((a, b) => {
    if (a.blocked !== b.blocked) return a.blocked ? -1 : 1
    const rank = RANK[a.state] - RANK[b.state]
    return rank !== 0 ? rank : a.id.localeCompare(b.id)
  })
}

// ---------------------------------------------------------------------------
// A conversation's lifecycle
// ---------------------------------------------------------------------------

/**
 * How a piece of work ended. Set by the human, never by the agent — an agent
 * that could mark its own work done would make every "done" worthless, and this
 * is the gate that replaces the file permissions an earlier draft proposed.
 *
 * Two verdicts, and both remove the row: it was finished, or it was not wanted.
 *
 * There used to be a third, `failed`, which left the row for another attempt —
 * and it was a button asking to be told something aide can already see. Work
 * that did not land is work you say the next thing about, and typing that next
 * message IS the report that it failed. Meanwhile the row stayed open whether or
 * not anyone pressed it, so the only thing the button changed was whether the
 * conversation was ALSO marked closed — which is exactly the bookkeeping the
 * board exists to remove. An unpressed verdict now means one thing: still going.
 */
export const CHAT_VERDICTS = ["done", "dropped"] as const
export type ChatVerdict = (typeof CHAT_VERDICTS)[number]

export const isChatVerdict = (v: unknown): v is ChatVerdict =>
  typeof v === "string" && (CHAT_VERDICTS as readonly string[]).includes(v)

/** Three states and two flags. The question a status answers is "does this need me?". */
export type ChatState = "working" | "needs-you" | "closed"

export interface ChatStatus {
  /** The board row this conversation is working, while it still has one. */
  rowId: string | null
  /**
   * Null for an ordinary conversation.
   *
   * Only tracked work has a lifecycle. A question you asked last week is not
   * "needs you" forever, and giving every chat a status would drown the two that
   * genuinely want something in a list of ones that do not.
   */
  state: ChatState | null
  /** A tool call is waiting on a human. Sharpens `needs-you` into "right now". */
  blocked: boolean
  /** Untouched for a while and still not closed. A flag, not a state. */
  stale: boolean
  verdict: ChatVerdict | null
}

/**
 * Chat-list order: what it costs to ignore, then how recent.
 *
 * `blocked` first because an agent is literally stopped on a click. `closed`
 * last because it is finished — that is the "all finished pushed down" rule.
 * An ordinary conversation sits between the two: it wants nothing, but it has
 * not been resolved either, because there was nothing to resolve.
 */
const CHAT_RANK: Record<string, number> = {
  "needs-you": 1,
  working: 2,
  ordinary: 3,
  closed: 4,
}

const chatRank = (s: ChatStatus): number =>
  s.blocked && s.state !== "closed" ? 0 : (CHAT_RANK[s.state ?? "ordinary"] ?? 3)

export function sortChats<T extends { status: ChatStatus; lastModified: number }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort(
    (a, b) => chatRank(a.status) - chatRank(b.status) || b.lastModified - a.lastModified,
  )
}
