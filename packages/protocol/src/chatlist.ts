/**
 * What a conversation is, to the list that shows it.
 *
 * This file used to be the backlog and used to be called `todo.ts`: a parser for
 * `.aide/todos.md`, a row type, and an ordering over rows. All of it went. The
 * backlog is now a chat you have written and not sent — the browser holds those,
 * because an unsent sentence is not yet a fact about the project — so there is no
 * file to parse and no row to keep in step with the conversation working it.
 *
 * The NAME went last, and only once someone went looking in here for a backlog
 * parser and found a chat list. A file whose name describes what it used to hold
 * costs a reader the same wrong turn every time; the header explaining that it is
 * no longer a todo list is only read by someone who already opened it.
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
 * What a conversation cost, summed over the turns aide itself ran.
 *
 * Null on a row rather than zeroed: a chat held in the CLI or the VS Code
 * extension appears in the same list, and aide has no event log for it. Zeroes
 * would read as a conversation that was free.
 *
 * Every number here is an estimate. `costUsd` comes from a price table bundled
 * into the SDK at build time — good enough for a list, never for billing.
 */
export interface ChatSpend {
  /** Turns with a log, including the commit run, if there was one. */
  turns: number
  /**
   * The turns' own time, added up.
   *
   * Not the span from the first message to the last: that is mostly the hours
   * you were somewhere else, which is the one part of a conversation nobody
   * needs measured.
   */
  activeMs: number
  costUsd: number
  /** Input, output and cache, together. */
  tokens: number
  /** 0-1, this conversation's tokens against every token aide has logged. */
  usageShare: number
}

/**
 * When a row came into existence — the date the list is ordered by.
 *
 * `lastModified` used to be the key, and ordering by it meant the list
 * rearranged itself every time you spoke: a chat from last week jumped over ten
 * newer ones the moment you asked it one more thing, and the position you had
 * learned for everything below it moved with it. Where a row sits is now a fact
 * about the work rather than about which one you touched last.
 *
 * A null `createdAt` is a session whose first entry carried no timestamp, and
 * the file's mtime is the only date it has.
 *
 * Exported because the row PRINTS this date as well as being ordered by it, and
 * the two have to read the same field. Sorting on one and labelling with the
 * other gives you a list whose visible timestamps are out of order — which
 * looks like a broken sort rather than like two dates being shown.
 */
export const born = (r: { createdAt: number | null; lastModified: number }): number =>
  r.createdAt ?? r.lastModified

/**
 * Chat-list order: newest first, and nothing else.
 *
 * There used to be a status rank in front of the date — blocked, then running,
 * then ordinary, then closed — on the theory that the row an agent is stopped on
 * belongs nearest the top. What it did in practice was move the top of the list
 * out from under the thing you were adding to it: park two notes while a chat
 * from this morning is running and they land BELOW that chat, in an order that
 * reads as arbitrary unless you already knew a turn was in flight somewhere. A
 * list you write into has to put what you just wrote where you were looking.
 *
 * Dropping it costs nothing that was only being said by position. Which row
 * holds the checkout, and which one is stopped on a click, is on the row itself
 * and in colour; and the ticked-off chats are still last because the list draws
 * them as their own group under their own heading rather than leaning on this to
 * sink them.
 *
 * So `status` is deliberately not a parameter here. Half a rank is worse than
 * none — `blocked` is only ever true of the run in flight, so pinning that alone
 * would make one row jump to the top and back down as permission prompts came
 * and went.
 */
export function sortChats<T extends { createdAt: number | null; lastModified: number }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort((a, b) => born(b) - born(a))
}
