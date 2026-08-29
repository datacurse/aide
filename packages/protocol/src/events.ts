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
  /**
   * This turn left the daemon running code that no longer exists on disk.
   *
   * The one question this repository's own logs show being asked over and over —
   * "do i have to restart aide, or start new chat?" — and until now the only
   * answer was a badge in the daemon rail, panes away from where it was asked. A
   * run that edits the daemon leaves a process serving code from before it, and
   * nothing in the transcript said so: the turn reported success, the browser
   * looked unchanged, and the obvious reading was that the agent had not done
   * the work. Three separate conversations here go on to ask whether the fix was
   * real.
   *
   * Appended only when the fingerprint actually moved across the turn, so it is
   * silent for every run on a project that is not aide's own checkout — which is
   * why there is no path matching here and nothing that knows the name of a
   * directory. `source.ts` compares what this process loaded against what is on
   * disk, and a run that never touched the daemon cannot move that answer.
   *
   * Sits before `run.finished`, like `turn.checkpoint`, because a run log ends in
   * exactly one terminal event and the rest of the daemon leans on that.
   *
   * The renderer says what happens NEXT rather than what is true now, because
   * this does not stay true: a supervised daemon restarts itself within seconds
   * of the turn ending, which is exactly when the row is being read.
   */
  | {
      type: "turn.stale"
      /** What this process loaded at boot, and what is on disk now. */
      bootSourceId: string
      sourceId: string
      /**
       * Something will restart it without being asked — the dev server that
       * started it. False for a daemon started by hand, which nothing else will
       * touch and which the human has to restart where they started it.
       */
      supervised: boolean
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
  /**
   * The API began an assistant message. Carries nothing to draw.
   *
   * It exists for its timestamp. Every other event here is stamped when it is
   * APPENDED, and an assistant message is appended once it is complete — so the
   * only two stamps around a reply are "the last tool result came back" and "the
   * whole reply arrived", and the gap between them is queueing, thinking and
   * generation added together. A receipt reading that log has to bill all of it
   * to the model's reasoning, which is how "thought for 40s" gets printed over a
   * turn that spent 38 of those seconds waiting for a slot.
   *
   * The one partial message worth keeping, and kept only because it is one per
   * message rather than one per token — see `RunDelta` for why the rest are
   * never written down. Which also means it only exists when someone is
   * watching: a headless task run has no partial stream, and a receipt for one
   * reports model time as a single bucket rather than inventing the split.
   */
  | { type: "assistant.start" }
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
  /**
   * A step of a commit, as it starts.
   *
   * Committing is not an agent and has no tool calls to watch, but it does spend
   * ten seconds of model time drafting a message — and a commit you cannot watch
   * is one you press twice. So it runs as a run of its own, and these are what
   * it has instead of `tool.start`.
   *
   * Emitted when the step BEGINS and never closed: a step is over once anything
   * else is in the log after it, which the reader can see for itself. A second
   * event per step would say nothing the ordering does not.
   */
  | { type: "commit.step"; label: string }
  /**
   * A check is about to be spawned.
   *
   * Its own event rather than another `commit.step`, because the row this opens
   * is the row `verify.result` closes — one line per check that appears when the
   * check starts and settles in place, instead of materialising after the fact.
   *
   * It exists because the checks were the one stretch of a commit that emitted
   * nothing at all. `pnpm build` is half a minute during which the last thing
   * written was "reading what is uncommitted", so the screen both said nothing
   * new and named the wrong phase. A commit that looks wedged gets pressed
   * again, which is the failure this is here to prevent.
   */
  | { type: "verify.started"; command: string }
  /**
   * One of the project's own checks, and what it did.
   *
   * The evidence half of "a verified diff". Until this existed, whether a change
   * was sound came from the agent saying so at the end of its turn — a summary
   * written by the thing being checked, in a run where 36% of the time no check
   * had been run at all. These are spawned by aide, outside the model, and this
   * event carries what the command actually printed.
   *
   * `output` is the TAIL, and is kept whether it passed or failed. Keeping it on
   * success too costs a few lines and answers "green against what?" — a check
   * that silently matched nothing reads exactly like a check that passed, and
   * the log is the only place that difference is visible.
   *
   * `exitCode` is null when the command never produced one: killed on a timeout,
   * or stopped by the human. `ok` is the field to branch on; the code is for
   * reading afterwards.
   */
  | {
      type: "verify.result"
      command: string
      ok: boolean
      exitCode: number | null
      durationMs: number
      output: string
    }
  /**
   * The message the helper model wrote.
   *
   * Shown rather than swallowed. Nobody typed this message, so the transcript is
   * the only place it can be read — and reading it is the whole of the review
   * that is left once the commit has already happened.
   */
  | { type: "commit.drafted"; message: string; model: string }
  /**
   * What landed. `paths` is exactly what was staged, so the log answers "what
   * did that button take" without a second call to git.
   */
  | { type: "commit.landed"; sha: string; paths: string[] }
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
      /**
       * Why it failed, in the SDK's own words.
       *
       * `SDKResultError` carries an `errors` array and aide threw it away, so a
       * run that spent thirteen minutes and $9.59 across 62 turns ended with the
       * word "failed" and nothing else — and the next thing in this machine's
       * logs is the human retyping their message into a fresh chat. The subtype
       * says which wall was hit; this says what actually went wrong.
       *
       * Absent rather than empty, the same way `user.message.images` is: every
       * outcome written before this existed has no errors field, and a reader
       * has to keep working on those.
       */
      errors?: string[]
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
