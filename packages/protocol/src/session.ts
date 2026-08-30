/**
 * The version of the daemon↔agent message protocol (`ToWorker`/`FromWorker`).
 *
 * A remote agent is deployed separately from the daemon that drives it, so the
 * two WILL be different versions eventually. Skew that half-works is the
 * dangerous kind — a field silently dropped, a checkpoint written by code that
 * disagrees about what a turn boundary is — so the version is stated and a
 * mismatch is refused out loud rather than discovered later.
 *
 * Here rather than beside those types in `daemon/src/worker/main.ts`, because
 * both files that could host it write to a stream the moment they are imported:
 * `deploy.ts` reading this constant from `stdio.ts` printed `{"type":"ready"}`
 * onto its own stdout and exited instead of deploying. A version number has to
 * be importable without starting an agent.
 *
 * Bump whenever those message types change shape.
 */
export const AGENT_PROTOCOL = 1

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
 * There were four. "Manual" (ask before every edit) and "Edit automatically"
 * (ask before every command) are gone, and what they cost was not clicks: a turn
 * that stops to ask needs somebody sitting in front of it, and not every turn
 * has one. The commit gate now hands a failed check back to the conversation by
 * itself — see `turnUnderHold` in the daemon's chat.ts — and under a mode that
 * asks, that turn blocks on a question nobody typed and nobody is watching for,
 * with the project's checkout held while it waits.
 *
 * So: two. Auto acts. Plan explores, asks once — for the plan — and then acts,
 * which is the same one decision Manual took twenty times over.
 *
 * `dontAsk` — what headless task runs use — is deliberately absent, and so is
 * `bypassPermissions`: neither is something a person should be able to pick from
 * a menu beside their own checkout.
 */
export const CHAT_MODES = ["plan", "auto"] as const
export type ChatMode = (typeof CHAT_MODES)[number]

export const CHAT_MODE_LABEL: Record<ChatMode, { label: string; hint: string }> = {
  plan: {
    label: "Plan",
    hint: "Claude explores and presents a plan. Approving it is the only question — what it asked for then runs unasked",
  },
  // The hint used to say "approves what passes a safety check". It no longer
  // does one: aide decides Auto's shell commands itself, because the check was a
  // model call in front of every command and cost seconds of every turn. See
  // `fastBashSettings` in the daemon's agent.ts for the numbers and the short
  // list that is still refused. The picker is where someone chooses this, so the
  // picker is where it has to say so.
  auto: { label: "Auto", hint: "Claude runs commands without asking. Fastest, and the least supervised" },
}

/**
 * An SDK permission mode back into aide's vocabulary.
 *
 * The session store is shared with the CLI and the VS Code extension, and every
 * user turn in it is stamped with the mode it was sent under. Reading that back
 * is what lets a conversation you had in VS Code on Auto stay on Auto when you
 * open it here, rather than silently reverting and asking permission for the
 * next command.
 *
 * Returns null for every mode aide has no picker entry for, which is now most of
 * them: `dontAsk` and `bypassPermissions` as before, and `default` and
 * `acceptEdits` since the two modes that mapped to them were removed. Null means
 * "no opinion", NOT a default — the caller keeps whatever the human last chose,
 * so a conversation last driven from the CLI in Manual arrives here on your own
 * setting rather than on a mode this product no longer has.
 */
export function chatModeFromSdk(value: unknown): ChatMode | null {
  switch (value) {
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
