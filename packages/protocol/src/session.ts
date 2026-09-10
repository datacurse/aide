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
 *
 * v2: `Attachment` grew `name` and non-image attachments became files on the
 * agent's disk. An old agent handed one would put its bytes in an image block,
 * which the API refuses — a turn that fails mid-flight instead of a mismatch
 * named up front.
 */
export const AGENT_PROTOCOL = 2

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
 * The models a turn can be sent to, and the only ones a picker offers.
 *
 * A closed list rather than a free-text box, for the same reason `CHAT_MODES` is
 * one: an id the API does not recognise fails at the START of a turn that has
 * already taken the project's checkout, and the error arrives as an SDK message
 * rather than as anything the composer could have refused. A typo in a text box
 * would be a held lock and a red line.
 *
 * `label` is what the picker shows and `hint` is what it is FOR, because the
 * choice being made here is a trade — speed against depth — and an id like
 * `claude-haiku-4-5-20251001` says nothing about which end of it you are picking.
 *
 * Ids and not aliases (`opus`, `sonnet`): an alias is resolved by whatever the
 * CLI happens to point it at, so a conversation's log would record a name whose
 * meaning changes under it, and `run.started.model` is the field the profile
 * bills against. Dated ids are used where the model has one.
 */
export const CHAT_MODELS = [
  {
    id: "claude-fable-5",
    label: "Fable 5",
    hint: "Deepest on a problem that has to be worked out. Billed against its own pool, so it does not eat the plan the others share",
  },
  {
    id: "claude-opus-5",
    label: "Opus 5",
    hint: "The most capable, and the slowest. What aide sends when nothing is chosen",
  },
  {
    id: "claude-sonnet-5",
    label: "Sonnet 5",
    hint: "Most of the ability at a fraction of the cost. The one to reach for on a long, mechanical turn",
  },
  {
    id: "claude-haiku-4-5-20251001",
    label: "Haiku 4.5",
    hint: "Fast and cheap, and out of its depth on anything it has to work out",
  },
] as const

export type ChatModel = (typeof CHAT_MODELS)[number]["id"]

export const isChatModel = (v: unknown): v is ChatModel =>
  typeof v === "string" && CHAT_MODELS.some((m) => m.id === v)

/** The label for an id, falling back to the id — a log may name a model this build does not list. */
export const chatModelLabel = (id: string): string =>
  CHAT_MODELS.find((m) => m.id === id)?.label ?? id

/**
 * A file attached in the composer — a pasted screenshot, or anything picked
 * from the clip button or dropped onto the box.
 *
 * Carried as base64 rather than written to disk HERE: it belongs to one turn,
 * and for an image the Messages API wants base64 anyway. An image rides the
 * message as a vision block; anything else has no block type to ride in, so
 * the worker writes it to a temp folder on the machine that RUNS the agent —
 * which for a remote project is the far machine, where a path written by the
 * browser's machine would name nothing — and the message text carries the
 * path. `isImageAttachment` is the split, shared so the web's chips, the log's
 * event and the worker's routing cannot each draw the line differently.
 */
export interface Attachment {
  /** Stable only within the composer, for removing one before sending. */
  id: string
  /** e.g. "image/png". "application/octet-stream" when the browser cannot tell. */
  mediaType: string
  /** Base64, without the data: URL prefix. */
  data: string
  bytes: number
  /**
   * The filename, when there was one. A picked or dropped file's is the handle
   * the human knows it by and the name it gets on the agent's disk; a pasted
   * screenshot's is browser noise. Optional because every draft saved before
   * non-image files existed has none.
   */
  name?: string
}

/** Which side of the wire an attachment takes: a vision block, or a file on the agent's disk. */
export const isImageAttachment = (a: { mediaType: string }): boolean =>
  a.mediaType.startsWith("image/")

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

