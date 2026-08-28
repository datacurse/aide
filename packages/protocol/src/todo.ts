/**
 * What a conversation is, to the list that shows it.
 *
 * This file used to be the backlog: a parser for `.aide/todos.md`, a row type,
 * and an ordering over rows. All of it went. The backlog is now a chat you have
 * written and not sent — the browser holds those, because an unsent sentence is
 * not yet a fact about the project — so there is no file to parse and no row to
 * keep in step with the conversation working it.
 *
 * What is left is the one bit aide records about a chat and the order the list
 * puts them in.
 */

/** Running, finished, or neither. */
export type ChatState = "working" | "closed"

export interface ChatStatus {
  /**
   * Null for a chat that is just sitting there.
   *
   * Which is most of them. Giving every conversation a badge would drown the one
   * that is actually blocked on you in a list of ones that want nothing.
   */
  state: ChatState | null
  /** A tool call is waiting on a human. The only thing that is stopped ON you. */
  blocked: boolean
  /**
   * A human said this served its purpose.
   *
   * The one thing in aide an agent cannot set. It is a toggle rather than a
   * verdict because the transcript already says what happened — the only thing
   * the list needs is whether you are finished with it.
   */
  done: boolean
}

/**
 * Chat-list order: what it costs to ignore, then how recent.
 *
 * `blocked` first because an agent is literally stopped on a click. `closed`
 * last because you have said you are finished with it — that is the "all
 * finished pushed down" rule. Everything else sits between the two.
 */
const CHAT_RANK: Record<string, number> = {
  working: 1,
  ordinary: 2,
  closed: 3,
}

const chatRank = (s: ChatStatus): number =>
  s.blocked && s.state !== "closed" ? 0 : (CHAT_RANK[s.state ?? "ordinary"] ?? 2)

export function sortChats<T extends { status: ChatStatus; lastModified: number }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort(
    (a, b) => chatRank(a.status) - chatRank(b.status) || b.lastModified - a.lastModified,
  )
}
