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
