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
import type { ChatMode, ChatModel, EffortLevel } from "./session.js"

/**
 * Which mode a draft keeps when its box is written to.
 *
 * A chat aide composed the words for carries the mode it must go out at —
 * `survey` asks for a plan and says not to write code yet, so sending it at a
 * mode that acts would be an instruction and its own contradiction in one
 * message. The composer writes the draft on every keystroke, which is what makes
 * this a rule rather than an assignment: the mode has to survive being edited,
 * and it has to be droppable when you pick a mode by hand.
 *
 * So absence and presence-as-undefined mean different things. `{}` is "say
 * nothing, keep what is there"; `{ mode: undefined }` is "clear it", which is
 * what the picker sends. `content.mode ?? held` cannot express that — it reads
 * the explicit clear as silence and puts the old value straight back, so a
 * survey you had switched to Auto would go out on Plan anyway.
 *
 * Here rather than in `drafts.ts` because that file reaches for
 * `window.indexedDB` and so cannot be imported by anything in Node — including
 * `pnpm smoke`, which is the only thing that would ever catch this going wrong.
 */
export function mergedMode(
  held: ChatMode | undefined,
  content: { mode?: ChatMode | undefined },
): ChatMode | undefined {
  return "mode" in content ? content.mode : held
}

/**
 * Everything a turn is sent with besides the words: how much rope the agent
 * gets, which model answers, whether it may think. One shape serves both the
 * defaults every chat starts on and what an individual chat resolves to.
 */
export interface ChatSettings {
  mode: ChatMode
  effort: EffortLevel
  thinking: boolean
  model: ChatModel
}

/**
 * What one chat has had picked in its own bar. A field is present only when a
 * human chose it FOR THIS CHAT; absent fields fall through to the defaults.
 */
export type ChatSettingsChoice = Partial<ChatSettings>

/**
 * What a chat's controls read, given everything that has an opinion.
 *
 * These four used to be one remembered value each, shared by every chat, so
 * switching to Haiku for one long mechanical turn silently switched every other
 * conversation with it. The controls are per chat now, and the precedence is a
 * rule worth pinning because every reading of it fails quietly:
 *
 * - `composed` (mode only) wins outright. Only a chat aide wrote the words for
 *   carries one — a survey sent at a mode that acts is an instruction and its
 *   own contradiction. It does not survive a pick by hand, but that is the
 *   picker's job (it clears the draft's copy), not this function's.
 * - `chosen` — this chat's own picks — beats `inherited`, because a pick is
 *   explicit and may not have been sent yet, and beats the defaults because
 *   that is the whole point of having one.
 * - `inherited` (mode only) beats the defaults: a chat last driven on Auto in
 *   VS Code must not start asking permission just because it was opened here.
 *
 * `??` and never `||` on `thinking`: false is a choice here, and `||` would
 * read "thinking off for this chat" as absence and put the default back.
 */
export function resolveChatSettings(args: {
  composed: ChatMode | null
  chosen: ChatSettingsChoice
  inherited: ChatMode | null
  defaults: ChatSettings
}): ChatSettings {
  const { composed, chosen, inherited, defaults } = args
  return {
    mode: composed ?? chosen.mode ?? inherited ?? defaults.mode,
    effort: chosen.effort ?? defaults.effort,
    thinking: chosen.thinking ?? defaults.thinking,
    model: chosen.model ?? defaults.model,
  }
}

/**
 * A chat that has just become a conversation, and is not in the fetched list yet.
 *
 * The handoff is two acts that cannot be made one. The unstarted record is
 * dropped the instant the SDK names the session — it has to be, or the record
 * and the conversation it turned into sit in the list side by side — and the
 * row that replaces it can only arrive on the next fetch of the daemon's list.
 * Between those two the chat is in NEITHER collection, so it left the list
 * entirely and came back a round trip later: press ▶, watch your chat vanish,
 * watch it reappear somewhere. Locally that is a flash; on a remote project the
 * conversation read costs seconds and the row is simply gone for them.
 *
 * So the list carries its own note of what just handed off, and stands a row on
 * it for exactly as long as the fetched rows do not have one. `bridgedChats`
 * decides that, and the retirement is the half worth pinning: a note kept after
 * the real row arrives is the SAME failure from the other end — one chat drawn
 * twice, under two keys, with a tick on one of them.
 *
 * Not solved by holding the draft back until the fetch lands: the box, the
 * chat's own picks and the URL all move to the session key on the same press,
 * and a record left behind under the old key is the strand this list already
 * has `startedRunId` to heal.
 */
export interface BridgedChat {
  sessionId: string
  /** What the row was called while it was parked, so the title does not change under you. */
  title: string
  /** The parked record's own dates, so the row does not move in the sort as it converts. */
  createdAt: number
  lastModified: number
}

/**
 * The notes that are still standing in for a chat, given what the daemon has
 * actually answered with.
 *
 * `known` is every session id in the fetched list. A note whose session is in it
 * has been overtaken and is dropped — the real row carries the title, the spend
 * and the tick, all of which this stand-in can only guess at.
 *
 * Pure, and here rather than in the component, for the reason `parseLocation`
 * gives: both ways of getting this wrong are silent. Keep a note too long and
 * one chat is drawn twice; drop it too early and the row blinks out, which is
 * the bug this exists to remove and which no error anywhere reports.
 */
export function bridgedChats<T extends { sessionId: string }>(
  notes: readonly T[],
  known: ReadonlySet<string>,
): T[] {
  return notes.filter((n) => !known.has(n.sessionId))
}

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
 * The two dates a list can be ordered by: when a chat was started, or when it
 * was last spoken to. A closed set rather than a comparator parameter, because
 * the choice is persisted in localStorage and read back across versions — a
 * string that has to be validated wants a type the validator can enumerate.
 */
export type ChatOrder = "created" | "activity"

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
 *
 * `by` IS a parameter, and "activity" is the one other order there is: last
 * spoken to first, which is the reading that answers "what just happened" at
 * the cost of rows moving when you speak to them. It is a choice a human makes
 * and keeps, never a default — "created" stays the default precisely because a
 * list you write into must put what you just wrote where you were looking, and
 * every caller that says nothing keeps that guarantee.
 */
export function sortChats<T extends { createdAt: number | null; lastModified: number }>(
  rows: readonly T[],
  by: ChatOrder = "created",
): T[] {
  const key = by === "activity" ? (r: T) => r.lastModified : born
  return [...rows].sort((a, b) => key(b) - key(a))
}
