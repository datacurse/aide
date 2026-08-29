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
  // The hint used to say "approves what passes a safety check". It no longer
  // does one: aide decides Auto's shell commands itself, because the check was a
  // model call in front of every command and cost seconds of every turn. See
  // `fastBashSettings` in the daemon's agent.ts for the numbers and the short
  // list that is still refused. The picker is where someone chooses this, so the
  // picker is where it has to say so.
  auto: { label: "Auto", hint: "Claude runs commands without asking. Fastest, and the least supervised" },
}

/**
 * Plan's companion switch: what happens AFTER you approve the plan.
 *
 * Not a fifth mode, and deliberately not — the four above map 1:1 onto the SDK's
 * `permissionMode`, which is what lets `chatModeFromSdk` read a mode back out of
 * a session file without guessing. This rides alongside instead, and it means
 * nothing unless the mode is `plan`.
 *
 * What it is for: plan mode's whole shape is one decision — you read the plan
 * and you say yes — and then the SDK drops to `default` and asks again for every
 * single edit that carries the plan out. One approved plan in this repository's
 * own logs was followed by twelve Edits, seven Bash calls and a Write, each one
 * a click. Approving a plan and then approving its every consequence is the same
 * decision taken twenty times.
 */
export const AUTO_AFTER_PLAN_LABEL = {
  label: "Carry the plan out on Auto",
  hint: "Approving the plan is the only question. What it asked for then runs unasked",
}

/**
 * An SDK permission mode back into aide's vocabulary.
 *
 * The session store is shared with the CLI and the VS Code extension, and every
 * user turn in it is stamped with the mode it was sent under. Reading that back
 * is what lets a conversation you had in VS Code on Auto stay on Auto when you
 * open it here, rather than silently reverting to Manual and asking permission
 * for the next command.
 *
 * Returns null for modes aide has no picker entry for — `dontAsk` (what task
 * runs use) and `bypassPermissions`. Null means "no opinion", not "manual": the
 * caller falls back to whatever the human last chose, which is never an
 * escalation.
 */
export function chatModeFromSdk(value: unknown): ChatMode | null {
  switch (value) {
    case "default":
      return "manual"
    case "acceptEdits":
      return "acceptEdits"
    case "plan":
      return "plan"
    case "auto":
      return "auto"
    default:
      return null
  }
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
  /**
   * The run id of a turn currently in flight for this conversation, if any.
   *
   * This is what makes a reload survivable. The browser holds the run it is
   * watching in component state, so refreshing mid-turn loses it and the page
   * goes quiet while the daemon carries on working — leaving you to reload
   * repeatedly to find out whether anything happened. The daemon knows perfectly
   * well what is running; it just had no way to say so.
   */
  activeRunId: string | null
  /**
   * The mode the last turn was sent under, when it can be read.
   *
   * Only populated when a single conversation is fetched — see `sessionMode`.
   * Null means the file did not say, and the browser should keep the mode the
   * human last picked.
   */
  lastMode: ChatMode | null
}

/**
 * What a conversation cost, where its time went, and what went wrong in it.
 *
 * Derived from the event log by `daemon/src/profile.ts`. It lives here rather
 * than in that file because it crosses the wire, and a second copy of the shape
 * declared browser-side is one the compiler cannot hold to the daemon's — which
 * is the whole reason this package has no schema library.
 *
 * Carried as one markdown document rather than as a tree the browser lays out:
 * the artifact exists to be pasted into a question about how the conversation
 * could have gone better, so the pasteable form IS the form.
 */
export interface Profile {
  sessionId: string
  /**
   * Runs aide's event log holds for this conversation. Zero is a real answer,
   * not a failure — a chat held in the CLI or the VS Code extension shows up in
   * the same list and has no log behind it to measure.
   */
  runs: number
  markdown: string
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
