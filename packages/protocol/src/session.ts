/**
 * Conversations.
 *
 * A conversation is a Claude session, and aide did not invent the concept — the
 * Agent SDK already persists every session under `~/.claude/projects/<dir>/` as
 * JSONL, keyed by the directory it ran in. That is the same store the VS Code
 * extension's session picker reads, which is why a chat you had there shows up
 * here without importing anything.
 *
 * The useful consequence: aide's own task runs and your interactive chats are
 * the same kind of object. A task run is a session whose cwd is a worktree; a
 * chat is a session whose cwd is the project root. `kind` is derived from that,
 * not stored, so it stays true for sessions aide never created.
 */

export type ConversationKind = "chat" | "task"

/**
 * What a chat turn is allowed to do without asking, mapped 1:1 onto the SDK's
 * `permissionMode`. The names are the ones the Claude Code UI uses, because a
 * mode picker that renames them would be a second vocabulary for one concept.
 *
 * `manual` is the only one that needs a human at the keyboard mid-turn: the SDK
 * routes an "ask" decision to `canUseTool`, which aide turns into a
 * `permission.request` event and waits on. The others resolve without a round
 * trip. `dontAsk` — what task runs use — is deliberately absent: a chat with a
 * human present should ask rather than fail closed.
 */
export const CHAT_MODES = ["manual", "acceptEdits", "plan", "auto"] as const
export type ChatMode = (typeof CHAT_MODES)[number]

export const CHAT_MODE_LABEL: Record<ChatMode, { label: string; hint: string }> = {
  manual: { label: "Manual", hint: "Claude will ask for approval before making each edit" },
  acceptEdits: { label: "Edit automatically", hint: "Claude will edit files without asking" },
  plan: { label: "Plan", hint: "Claude will explore and present a plan before editing" },
  auto: { label: "Auto", hint: "Claude approves what passes a safety check, pauses for anything risky" },
}

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

/**
 * An image pasted into the composer.
 *
 * Carried as base64 rather than written to disk: it belongs to one turn, the
 * Messages API wants base64 anyway, and a file on disk would be one more thing
 * to clean up when the turn is cancelled.
 */
export interface Attachment {
  /** Stable only within the composer, for removing one before sending. */
  id: string
  /** e.g. "image/png". */
  mediaType: string
  /** Base64, without the data: URL prefix. */
  data: string
  bytes: number
}

/** How full the model's context is, as of the end of a turn. */
export interface ContextUsage {
  totalTokens: number
  maxTokens: number
  /** 0-100, as the SDK reports it. */
  percentage: number
}

export interface ConversationSummary {
  sessionId: string
  kind: ConversationKind
  /** Set when `kind` is "task": the task whose worktree this ran in. */
  taskId: string | null
  /** Custom title, else the SDK's generated summary, else the first prompt. */
  title: string
  /** The opening user message, for a preview line. */
  firstPrompt: string
  /** Absolute path the session ran in. This is what `kind` is derived from. */
  cwd: string
  gitBranch: string | null
  /** epoch ms */
  lastModified: number
  /** epoch ms, or null for sessions whose first entry carried no timestamp. */
  createdAt: number | null
  /** JSONL size on disk. Some transcripts are megabytes; the UI warns before loading one. */
  bytes: number
}

/**
 * A conversation's transcript, normalized into the same `RunEvent` shape the
 * live run stream uses — so the transcript renderer is shared rather than
 * reimplemented, and a replayed session reads exactly like a live one.
 *
 * `seq` is assigned on read and is stable only within one response; these
 * events are derived from the session file, not from aide's own event log.
 */
export interface ConversationTranscript {
  summary: ConversationSummary
  /** True when the transcript was cut short by the message cap. */
  truncated: boolean
  /** How many messages the session actually holds. */
  totalMessages: number
}
