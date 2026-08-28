/**
 * The wire format between worker -> daemon -> browser.
 *
 * These are NORMALIZED events, not Agent SDK messages passed through. The SDK's
 * message union has ~30 members and grows with every release; the UI should never
 * have to know about `SDKMirrorErrorMessage`. The mapping SDK -> RunEvent lives in
 * exactly one place (daemon/src/agent.ts) so there is one file to update when the
 * SDK adds a message type.
 */

/** Terminal state of a run, derived from the SDK result subtype. */
export type RunStatus = "running" | "success" | "failed" | "cancelled"

/** Per-model token and cost totals. Cost is a client-side ESTIMATE, never billing. */
export interface ModelSpend {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  /** Client-side estimate from a price table bundled into the SDK at build time. */
  costUSD: number
}

/**
 * A screenshot the human attached to a message.
 *
 * Carried inline as base64, the same way it was pasted and the same way the
 * session store keeps it. That does mean a run log holds a second copy of the
 * bytes, which is a real cost and was weighed: the alternative — serving them
 * back out of the session file by reference — has no answer for the live turn,
 * because the browser is showing the message before the SDK has written the
 * transcript. One representation that works in both directions beats two that
 * each work half the time.
 */
export interface MessageImage {
  /** e.g. "image/png". */
  mediaType: string
  /** Base64, without the data: URL prefix. */
  data: string
}

/**
 * What a worker emits. The daemon stamps runId/seq/ts on append, so workers never
 * have to know their own sequence number.
 */
export type RunEventBody =
  /**
   * The working tree was snapshotted before the agent was let near it.
   *
   * Emitted BEFORE `run.started`, which stays where the SDK's system/init
   * message produces it — that event is the only carrier of `sessionId`, and
   * moving it would cost the resume handle.
   *
   * This is the event that replaced `bootstrap.started` / `bootstrap.finished`.
   * A run used to begin by checking out a worktree and installing into it,
   * because isolation was how an agent editing your repository was made
   * survivable. Runs work the project's own checkout now, and the snapshot is
   * what makes THAT survivable — so the slowest, most opaque step at the start
   * of a run became the cheapest, and it still gets an event because "what
   * happened to my uncommitted work" must be answerable from the log alone.
   *
   * `restore` is the literal command rather than something the UI assembles, so
   * there is one place that knows how to undo a run.
   */
  | {
      type: "checkpoint.taken"
      /** `refs/aide/checkpoints/<id>`. */
      ref: string
      /** The snapshot commit. */
      sha: string
      /** How many files were already uncommitted when the run started. */
      dirtyCount: number
      /**
       * What to type to put the tree back.
       *
       * Restores what the run changed and deleted; does NOT remove what it
       * created. See `restoreCommand` for why the wider sweep is not offered.
       */
      restore: string
    }
  /**
   * Where the tree stood when a turn ended.
   *
   * The checkpoint above is the conversation's baseline and never moves, because
   * the review measures against it. That leaves undo with one place to rewind
   * to, however long the conversation ran, so each turn that changed something
   * also records its own boundary and the transcript carries them inline — the
   * restore point for turn 3 sits directly under turn 3.
   *
   * Absent for a turn that changed nothing on disk, which is most questions. A
   * boundary identical to the one before it is not a place you can return to,
   * and printing one per message would bury the ones that are.
   */
  | {
      type: "turn.checkpoint"
      /** `refs/aide/turns/<session>/<n>`. */
      ref: string
      /** The snapshot commit. */
      sha: string
      /** 1-based, in the order the conversation's turns landed. */
      n: number
      /**
       * What to type to go back to how the tree stood here.
       *
       * The same command shape as a checkpoint's, and the same caveat: it puts
       * back what later turns changed or deleted, and leaves what they created.
       */
      restore: string
    }
  | {
      type: "run.started"
      taskId: string
      projectId: string
      model: string
      cwd: string
      sessionId: string | null
    }
  /**
   * What the human said.
   *
   * A task run has exactly one of these — the request — and it was invisible
   * until now: `task.prompt` was on the wire and rendered nowhere, so a
   * transcript read as an agent talking to itself. A replayed conversation has
   * one per turn, and they are most of what makes it a conversation.
   *
   * `images` is what was pasted alongside the text. Absent rather than empty
   * when there were none: every transcript written before attachments existed
   * is that case, and the reader has to keep working on them.
   */
  | { type: "user.message"; text: string; images?: MessageImage[] }
  /** `parentToolUseId` is non-null for subagent output, null for the main loop. */
  | { type: "assistant.text"; text: string; parentToolUseId: string | null }
  | { type: "assistant.thinking"; text: string; parentToolUseId: string | null }
  | {
      type: "tool.start"
      toolUseId: string
      name: string
      input: unknown
      parentToolUseId: string | null
    }
  | { type: "tool.end"; toolUseId: string; ok: boolean; summary: string }
  | { type: "tool.denied"; name: string; input: unknown; reason: string }
  /**
   * A chat turn is waiting for the human to approve a tool call.
   *
   * This is the difference between a chat and a task. A task run fails closed
   * because nobody is there to answer; a chat has someone at the keyboard, so
   * the SDK's "ask" decision becomes an event here and the turn blocks until a
   * decision arrives. Carried on the event stream rather than a side channel so
   * a reconnecting browser sees a pending request in the replay and can still
   * answer it.
   */
  | { type: "permission.request"; requestId: string; name: string; input: unknown }
  | { type: "permission.resolved"; requestId: string; allowed: boolean; reason: string }
  /** Context occupancy after a turn, for the composer's meter. */
  | { type: "context.usage"; totalTokens: number; maxTokens: number; percentage: number }
  | {
      type: "run.retry"
      attempt: number
      maxRetries: number
      retryDelayMs: number
      error: string
    }
  | {
      type: "run.finished"
      /** Raw SDK subtype, kept for diagnosis: success | error_max_turns | error_max_budget_usd | ... */
      subtype: string
      status: RunStatus
      /** Includes subagent spend. Prefer this over `usage` for accounting. */
      totalCostUsd: number
      modelUsage: Record<string, ModelSpend>
      numTurns: number
      durationMs: number
      permissionDenials: Array<{ tool: string; reason: string }>
    }
  /** The run never produced a result — process crash, spawn failure, bad config. */
  | { type: "run.error"; message: string }

/** A persisted, ordered event. `seq` is monotonic per run and starts at 1. */
export type RunEvent = RunEventBody & {
  runId: string
  seq: number
  /** epoch ms */
  ts: number
}

export type RunEventType = RunEventBody["type"]

// ---------------------------------------------------------------------------
// WebSocket protocol
// ---------------------------------------------------------------------------

export type ClientMessage =
  /** `fromSeq` replays everything after that seq, then live-tails. Use 0 for "from the start". */
  | { type: "subscribe"; runId: string; fromSeq: number }
  | { type: "unsubscribe"; runId: string }

/**
 * Token-by-token output, while a turn is still producing it.
 *
 * Deliberately NOT a `RunEventBody`, and deliberately never written to the event
 * log. A turn emits thousands of these; appending each one would turn an
 * append-only NDJSON file into a token stream and replay all of it to every
 * browser that subscribes. The durable record is the completed message that
 * follows — this is the same content arriving early, and it is fine to lose.
 *
 * Which is also why a reconnecting client misses nothing: it replays the events
 * and simply skips the animation.
 */
export type RunDelta =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  /** Cumulative for the message in flight, straight off the API's message_delta. */
  | { kind: "usage"; outputTokens: number }

export type ServerMessage =
  | { type: "events"; runId: string; events: RunEvent[] }
  /** Ephemeral; see RunDelta. Only ever sent live, never replayed. */
  | { type: "delta"; runId: string; delta: RunDelta }
  /** Sent once the replayed backlog is drained and the client is live. */
  | { type: "caught-up"; runId: string; seq: number }
  | { type: "error"; message: string }
