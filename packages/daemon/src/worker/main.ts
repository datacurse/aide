/**
 * One child process per run — and, for a chat, per conversation rather than per
 * turn.
 *
 * The isolation is the point: an agent run that crashes, wedges, or eats memory
 * takes down a worker, not the daemon holding every other project's state.
 *
 * A task run is one turn and exits. A chat holds the SDK session open and takes
 * follow-ups over IPC, because the alternative — a fork and a CLI boot per
 * message — costs about 1.4 seconds on Windows before the model sees a token,
 * and re-reads the transcript from disk every time to learn what it already
 * knew.
 *
 * The loop itself lives in `loop.ts`, because `aide-agent` runs the same one
 * over stdio on another machine. This file is what makes it a forked child: the
 * IPC binding, and nothing else. The message TYPES stay here — they are the
 * protocol, and both transports and `chat.ts` import them from this path.
 */
import type { RunDelta, RunEventBody } from "@aide/protocol"
import type { FollowUpTurn, RunAgentOptions } from "../agent.js"
import { createAgentLoop } from "./loop.js"

/** The job needs `chatMode` set for the worker to ask instead of failing closed. */
export type ToWorker =
  | { cmd: "start"; job: RunAgentOptions }
  /** Chat only: another message for a session that is already open. */
  | { cmd: "turn"; turn: FollowUpTurn }
  | { cmd: "interrupt" }
  /** Chat only: end the conversation and let the process exit. */
  | { cmd: "close" }
  | { cmd: "permission"; requestId: string; allowed: boolean }

/**
 * `runId` is on every message because a chat worker outlives a turn: the parent
 * writes each event to that turn's log, and "whichever turn the parent thinks is
 * current" is a guess that goes wrong exactly when a turn's trailing events
 * overlap the next one's start.
 */
export type FromWorker =
  /**
   * `protocol` is present only from a REMOTE agent, which is deployed
   * separately and can therefore be a different version. A forked worker is
   * this same checkout by construction, so it has nothing to declare.
   */
  | { type: "ready"; protocol?: number }
  | { type: "event"; runId: string; body: RunEventBody }
  /** Ephemeral live output; never written to the event log. */
  | { type: "delta"; runId: string; body: RunDelta }
  | { type: "permission"; runId: string; requestId: string; name: string; input: unknown }
  /** One turn finished. In a chat the process stays up for the next one. */
  | { type: "done"; runId: string; interrupted: boolean }
  /** The session is over and the process is going away. Chat only. */
  | { type: "closed" }

const send = (msg: FromWorker) => {
  process.send?.(msg)
}

const loop = createAgentLoop(send, () => {
  // Give the IPC channel a tick to flush before the process goes away.
  setTimeout(() => process.exit(0), 50)
})

process.on("message", (raw: unknown) => {
  loop.handle(raw as ToWorker)
})

// The job arrives over IPC rather than argv: a task prompt can exceed the
// ~32k Windows command-line limit.
send({ type: "ready" })
