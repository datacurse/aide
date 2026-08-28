import { mkdir, readFile, writeFile } from "node:fs/promises"
import type { BoardRow, ChatStatus, ChatVerdict, Project } from "@aide/protocol"
import { isChatVerdict, sortBoard } from "@aide/protocol"
import { aideHome, boardPath } from "@aide/protocol/node"
import { readCheckpoint, restoreCommand } from "./checkpoint.js"
import { CONFIG } from "./config.js"
import { deleteTodo, listTodos } from "./todos.js"

/**
 * The board: `todos.md` joined to the conversations working it.
 *
 * Only ONE fact is stored here — which session is on which row. Everything else
 * a row shows is derived on read: the text comes from `todos.md`, and the state
 * comes from asking the chat lane whether that session is mid-turn. Nothing is
 * written when a chat starts thinking or stops, so there is no status field that
 * can be left saying `working` by a daemon that died.
 *
 * It lives in `~/.aide/` rather than the repo because it churns and because it
 * names session ids that only exist under `~/.claude/projects/` on this machine.
 * Lose this file and you lose the ability to click a row and land in the
 * conversation that worked it — the todo, the spec, the branch, the commits and
 * the code are all still there.
 */

interface ProjectBoard {
  /** Row id to session id. */
  rows: Record<string, string>
  /**
   * Session id to how its work ended.
   *
   * The board itself needs none of this — closing a row removes the row — but
   * the CHAT list does: "this one is finished" is what pushes a conversation to
   * the bottom, and once the row is gone nothing in the repo says so any more.
   */
  verdicts: Record<string, { verdict: ChatVerdict; at: number }>
}

/** `{ "<projectId>": { rows, verdicts } }` */
type LinkFile = Record<string, ProjectBoard>

/** Tolerant on every field: this file is machine-local and hand-editable. */
const boardFor = (links: LinkFile, projectId: string): ProjectBoard => {
  const held = links[projectId]
  return {
    rows: held?.rows && typeof held.rows === "object" ? held.rows : {},
    verdicts: held?.verdicts && typeof held.verdicts === "object" ? held.verdicts : {},
  }
}

async function readLinks(): Promise<LinkFile> {
  try {
    const parsed: unknown = JSON.parse(await readFile(boardPath(), "utf8"))
    // Hand-editable and machine-local, so a corrupt file must degrade to an
    // unlinked board rather than take the daemon down on boot.
    return parsed && typeof parsed === "object" ? (parsed as LinkFile) : {}
  } catch {
    return {}
  }
}

async function writeLinks(links: LinkFile): Promise<void> {
  await mkdir(aideHome(), { recursive: true })
  await writeFile(boardPath(), `${JSON.stringify(links, null, 2)}\n`, "utf8")
}

/** Which conversation is working this row, if any. */
export async function linkedSession(projectId: string, rowId: string): Promise<string | null> {
  return boardFor(await readLinks(), projectId).rows[rowId] ?? null
}

/** Which row this conversation is working, if any. Used to close a row out. */
export async function rowForSession(projectId: string, sessionId: string): Promise<string | null> {
  const { rows } = boardFor(await readLinks(), projectId)
  return Object.entries(rows).find(([, s]) => s === sessionId)?.[0] ?? null
}

export async function linkSession(
  projectId: string,
  rowId: string,
  sessionId: string,
): Promise<void> {
  const links = await readLinks()
  const board = boardFor(links, projectId)
  board.rows[rowId] = sessionId
  links[projectId] = board
  await writeLinks(links)
}

export async function unlinkRow(projectId: string, rowId: string): Promise<void> {
  const links = await readLinks()
  const board = boardFor(links, projectId)
  if (!board.rows[rowId]) return
  delete board.rows[rowId]
  links[projectId] = board
  await writeLinks(links)
}

/** What the chat lane knows about a conversation. Null when it has no live turn. */
export interface LiveChat {
  /** A turn is in flight. */
  working: boolean
  /** A tool call is waiting on a human. */
  blocked: boolean
}

/**
 * Every row, with its state derived and sorted by what it costs to ignore.
 *
 * Links to rows that no longer exist are filtered out rather than deleted: a row
 * can vanish because someone edited `todos.md` in an editor mid-run, and pruning
 * the file on every read would race that edit. They cost nothing left alone.
 */
export async function boardRows(
  project: Project,
  live: (sessionId: string) => LiveChat | null,
): Promise<BoardRow[]> {
  const [todos, links] = await Promise.all([listTodos(project), readLinks()])
  const forProject = boardFor(links, project.id).rows

  const rows = todos.map((todo): BoardRow => {
    const sessionId = forProject[todo.id] ?? null
    const chat = sessionId ? live(sessionId) : null
    return {
      id: todo.id,
      text: todo.text,
      sessionId,
      state: !sessionId ? "idle" : chat?.working ? "working" : "needs-you",
      blocked: chat?.blocked ?? false,
    }
  })

  return sortBoard(rows)
}

// ---------------------------------------------------------------------------
// Closing a conversation out
// ---------------------------------------------------------------------------

/**
 * The human's verdict, and what it does to the backlog.
 *
 * This is the gate the whole design rests on. An agent may write the spec, the
 * todo file and the code; it may not decide that any of it is finished. Which is
 * why nothing here is reachable from a run — only from a person pressing a
 * button.
 *
 * The verdict expresses itself as the SHAPE of the backlog rather than a status
 * field on the row: closing a conversation removes its line, either way. So
 * there is no second record of "is this finished" to drift out of step with what
 * the file actually says.
 *
 * Both verdicts remove it because both mean the row is settled — finished, or
 * not wanted. Work that went wrong does not get a button: you say the next thing
 * in the conversation, and the row stays open because nobody closed it.
 */
export async function closeChat(
  project: Project,
  sessionId: string,
  verdict: ChatVerdict,
): Promise<{ rowId: string | null; rowRemoved: boolean; warning: string | null }> {
  const rowId = await rowForSession(project.id, sessionId)

  const rowRemoved = rowId !== null
  if (rowId) {
    // Tolerated rather than fatal. Someone may have deleted the line by hand
    // between starting the chat and closing it, and refusing to record the
    // verdict over that would strand the conversation as permanently unresolved.
    await deleteTodo(project, rowId).catch(() => {})
  }
  const warning = await checkpointNotice(project, sessionId)
  if (rowId) await unlinkRow(project.id, rowId)

  const links = await readLinks()
  const board = boardFor(links, project.id)
  board.verdicts[sessionId] = { verdict, at: Date.now() }
  links[project.id] = board
  await writeLinks(links)

  return { rowId, rowRemoved, warning }
}

/**
 * Where this conversation's undo lives, said out loud as it closes.
 *
 * This slot used to report a checkout that could not be reclaimed. There is no
 * checkout now, and the thing worth saying at exactly this moment instead is
 * that the snapshot taken before the conversation started is still there — a
 * verdict is the point at which someone decides whether the work was any good,
 * and "not good" wants a command rather than a shrug.
 *
 * The ref is KEPT, deliberately, and not cleaned up here. A checkpoint is a few
 * bytes of ref plus objects git already had; deleting it the moment someone
 * presses a button would make the one irreversible thing in this flow the button
 * labelled "done".
 */
async function checkpointNotice(project: Project, sessionId: string): Promise<string | null> {
  const found = await readCheckpoint(project.root, sessionId).catch(() => null)
  if (!found) return null
  return `the tree as it was before this conversation is kept at ${found.ref} — undo with \`${restoreCommand(found.ref)}\``
}

/** Undo a verdict, for when it was the wrong button. The row does not come back. */
export async function reopenChat(project: Project, sessionId: string): Promise<void> {
  const links = await readLinks()
  const board = boardFor(links, project.id)
  if (!board.verdicts[sessionId]) return
  delete board.verdicts[sessionId]
  links[project.id] = board
  await writeLinks(links)
}

/**
 * A status per conversation, for the chat list.
 *
 * Only conversations the board knows about get a lifecycle. An ordinary chat — a
 * question, with no row — reports `state: null`, because calling something you
 * asked last week "needs you" would bury the two that genuinely do.
 */
export async function chatStatuses(
  project: Project,
  sessions: readonly { sessionId: string; lastModified: number }[],
  live: (sessionId: string) => LiveChat | null,
): Promise<Record<string, ChatStatus>> {
  const board = boardFor(await readLinks(), project.id)
  const rowOf = new Map(Object.entries(board.rows).map(([rowId, s]) => [s, rowId]))
  const now = Date.now()

  const out: Record<string, ChatStatus> = {}
  for (const { sessionId, lastModified } of sessions) {
    // Validated on the way out, not trusted. `board.json` on a machine that ran
    // an older aide holds `failed` verdicts, and under the vocabulary that
    // replaced it those conversations are not closed at all — the work was left
    // unfinished, which is the same thing as never having pressed a button.
    // Reading one back as a closed state would show a verdict that no longer
    // exists and offer only "reopen" to get out of it.
    const stored = board.verdicts[sessionId]?.verdict
    const verdict = isChatVerdict(stored) ? stored : null
    const rowId = rowOf.get(sessionId) ?? null
    const chat = live(sessionId)
    out[sessionId] = {
      rowId,
      state: verdict ? "closed" : rowId ? (chat?.working ? "working" : "needs-you") : null,
      blocked: chat?.blocked ?? false,
      // Only meaningful for work that is still open. A finished conversation is
      // not going stale, it is done.
      stale: !verdict && rowId !== null && now - lastModified > CONFIG.chatStaleMs,
      verdict,
    }
  }
  return out
}
