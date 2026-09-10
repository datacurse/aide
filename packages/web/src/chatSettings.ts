import { useCallback, useSyncExternalStore } from "react"
import {
  CHAT_MODES,
  EFFORT_LEVELS,
  isChatModel,
  type ChatMode,
  type ChatModel,
  type ChatSettings,
  type ChatSettingsChoice,
  type EffortLevel,
} from "@aide/protocol"
import { useRemembered } from "./useRemembered.js"

/**
 * Which mode, model, effort and thinking a chat runs at — per chat, with a
 * settable default.
 *
 * These four were one remembered value each, shared by every chat: switch to
 * Sonnet for a long mechanical turn in one conversation and every other
 * conversation was quietly on Sonnet too, with nothing on screen saying so
 * except the picker in whichever chat you happened to open next. Two stores
 * now. The DEFAULTS are what every chat starts on, edited only from the
 * settings panel in the rail's foot. A CHOICE is what one chat's own bar has
 * picked over them, keyed by the same draft key the composer already scopes its
 * text to — which covers a chat before and after it has a session id, and lets
 * `carryChatSettings` move the picks the same moment `carryDraft` moves the
 * words.
 *
 * Who wins is not decided here: `resolveChatSettings` in protocol holds the
 * precedence, where `pnpm smoke:queue` can pin it.
 */

export const isChatMode = (v: unknown): v is ChatMode =>
  typeof v === "string" && (CHAT_MODES as readonly string[]).includes(v)
export const isEffort = (v: unknown): v is EffortLevel =>
  typeof v === "string" && (EFFORT_LEVELS as readonly string[]).includes(v)
const isBool = (v: unknown): v is boolean => typeof v === "boolean"

/**
 * The keys are the ones the composer used when these were global, deliberately:
 * the preference somebody had built up IS their default, and a rename would
 * reset all four on the day this shipped.
 */
const DEFAULTS: ChatSettings = {
  mode: "auto",
  effort: "high",
  thinking: true,
  // The daemon's default named again rather than imported: the daemon reads
  // `AIDE_TASK_MODEL` and this is a browser. If the two ever disagree the
  // picker is the honest one, because it is what somebody read before sending.
  model: "claude-opus-5",
}

/** The defaults every chat starts on. What the settings panel edits. */
export function useChatDefaults(): [ChatSettings, (patch: ChatSettingsChoice) => void] {
  const [mode, setMode] = useRemembered<ChatMode>("aide.chat.mode", DEFAULTS.mode, isChatMode)
  const [effort, setEffort] = useRemembered<EffortLevel>(
    "aide.chat.effort",
    DEFAULTS.effort,
    isEffort,
  )
  const [thinking, setThinking] = useRemembered<boolean>(
    "aide.chat.thinking",
    DEFAULTS.thinking,
    isBool,
  )
  const [model, setModel] = useRemembered<ChatModel>("aide.chat.model", DEFAULTS.model, isChatModel)
  const set = useCallback(
    (patch: ChatSettingsChoice) => {
      if (patch.mode !== undefined) setMode(patch.mode)
      if (patch.effort !== undefined) setEffort(patch.effort)
      if (patch.thinking !== undefined) setThinking(patch.thinking)
      if (patch.model !== undefined) setModel(patch.model)
    },
    [setMode, setEffort, setThinking, setModel],
  )
  return [{ mode, effort, thinking, model }, set]
}

const CHOICES_KEY = "aide.chat.choices"

/** `at` is when the chat last picked anything — what the prune keeps by. */
type StoredChoice = ChatSettingsChoice & { at: number }

/**
 * A choice is a few dozen bytes, but chats are made forever and localStorage is
 * not. Pruned oldest-first well above the count anybody scrolls back through;
 * the entry being written is by definition the newest, so it always survives.
 */
const MAX_CHOICES = 300
const KEEP_CHOICES = 200

/**
 * Lazy rather than read at module load: touching `window` on import is what
 * keeps a file out of Node's reach — the trap `drafts.ts` is already in and
 * this file does not need to join.
 */
let cache: Map<string, StoredChoice> | null = null
const listeners = new Set<() => void>()
const NO_CHOICE: ChatSettingsChoice = {}

function load(): Map<string, StoredChoice> {
  const held = new Map<string, StoredChoice>()
  try {
    const raw = window.localStorage.getItem(CHOICES_KEY)
    if (raw === null) return held
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) return held
    // Field by field rather than shape-whole, for the reason every reader in
    // this codebase does it: a value that was legal last month can be garbage
    // today, and one retired model id must not throw away the chat's mode.
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "object" || value === null) continue
      const v = value as Record<string, unknown>
      const entry: StoredChoice = { at: typeof v["at"] === "number" ? v["at"] : 0 }
      if (isChatMode(v["mode"])) entry.mode = v["mode"]
      if (isEffort(v["effort"])) entry.effort = v["effort"]
      if (isBool(v["thinking"])) entry.thinking = v["thinking"]
      if (isChatModel(v["model"])) entry.model = v["model"]
      held.set(key, entry)
    }
  } catch {
    // Private mode, disabled storage, or malformed JSON. Every chat then runs
    // on the defaults, which is safe.
  }
  return held
}

const ensure = (): Map<string, StoredChoice> => (cache ??= load())

function persist(held: Map<string, StoredChoice>): void {
  try {
    window.localStorage.setItem(CHOICES_KEY, JSON.stringify(Object.fromEntries(held)))
  } catch {
    /* the choice still applies for this page */
  }
}

function publish(): void {
  for (const notify of listeners) notify()
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify)
  return () => {
    listeners.delete(notify)
  }
}

// Entry objects are replaced on write, never mutated, so handing one straight
// out of the map is the stable snapshot useSyncExternalStore compares by
// identity — a fresh object per read is the render loop `PerProjectMemo` exists
// to explain.
const readChoice = (key: string): ChatSettingsChoice => ensure().get(key) ?? NO_CHOICE

function writeChoice(key: string, patch: ChatSettingsChoice): void {
  const next = new Map(ensure())
  next.set(key, { ...next.get(key), ...patch, at: Date.now() })
  if (next.size > MAX_CHOICES) {
    const keep = [...next.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, KEEP_CHOICES)
    next.clear()
    for (const [k, v] of keep) next.set(k, v)
  }
  cache = next
  persist(next)
  publish()
}

/**
 * A draft became a real conversation, so its picks follow it to its new key —
 * called by `carryDraft`, which is the one place a chat changes keys. Without
 * this, picking Sonnet on a parked chat and pressing ▶ would land the second
 * message back on the default, on the very turn after the one that honoured it.
 */
export function carryChatSettings(from: string, to: string): void {
  const held = ensure()
  const row = held.get(from)
  if (!row) return
  const next = new Map(held)
  next.delete(from)
  next.set(to, row)
  cache = next
  persist(next)
  publish()
}

/** What this chat has picked over the defaults, and how it picks more. */
export function useChatChoice(
  key: string,
): [ChatSettingsChoice, (patch: ChatSettingsChoice) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => readChoice(key),
    // A server snapshot, for the same reason `drafts.ts` carries one: nothing
    // here server-renders, but without it the component cannot be driven from
    // Node at all.
    () => NO_CHOICE,
  )
  const choose = useCallback((patch: ChatSettingsChoice) => writeChoice(key, patch), [key])
  return [value, choose]
}
