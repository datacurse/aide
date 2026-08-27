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
   * Admitted, but waiting behind the concurrency cap.
   *
   * Without this a queued run's log is empty, and the run pane — which switches
   * to the newest run the moment you press run — shows "Waiting for the first
   * event…" for as long as the wait lasts. That is indistinguishable from a run
   * that started and wedged.
   *
   * `position` is a historical fact (it was N-deep when admitted), not a live
   * one. The live position comes from the task list, which is polled.
   */
  | { type: "run.queued"; taskId: string; projectId: string; position: number }
  /**
   * The project's `bootstrap` command, run in a freshly created worktree before
   * the agent starts. Emitted BEFORE `run.started`, which stays where the SDK's
   * system/init message produces it — that event is the only carrier of
   * `sessionId`, and moving it would cost the resume handle.
   */
  | { type: "bootstrap.started"; command: string; cwd: string }
  | {
      type: "bootstrap.finished"
      ok: boolean
      /** null when the process was killed by a signal or timed out. */
      exitCode: number | null
      durationMs: number
      /**
       * Tail of the combined output, capped. A tail rather than a stream because
       * `pnpm install` emits thousands of progress lines and the whole NDJSON log
       * is replayed on every browser subscribe — and because the reason a build
       * failed is at the end.
       */
      output: string
    }
  | {
      type: "run.started"
      taskId: string
      projectId: string
      model: string
      cwd: string
      worktree: string
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
