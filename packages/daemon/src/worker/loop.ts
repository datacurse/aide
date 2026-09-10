/**
 * The agent loop, with no opinion about how it is spoken to.
 *
 * `worker/main.ts` runs this over `process.send` as a forked child; `aide-agent`
 * runs the SAME code over stdin/stdout on another machine. Extracting it is what
 * keeps a remote run honest — the alternative is a second implementation of the
 * protocol that drifts from this one, and the drift would show up as a remote
 * conversation that renders subtly differently from a local one.
 *
 * Everything transport-specific is the two functions passed in: how a message
 * goes out, and how one comes in. Nothing below refers to a process, a pipe or a
 * socket.
 */
import type { RunDelta } from "@aide/protocol"
import { runAgent, type FollowUpTurn, type RunAgentOptions } from "../agent.js"
import type { FromWorker, ToWorker } from "./main.js"

/**
 * Follow-up messages, as an async iterable the SDK's input stream can pull from.
 *
 * A plain array plus a resolver rather than a stream library: the queue is
 * single-consumer, holds at most a handful of items, and the daemon's dependency
 * list is deliberately four entries long.
 */
class TurnQueue implements AsyncIterable<FollowUpTurn> {
  #queued: FollowUpTurn[] = []
  #wake: (() => void) | null = null
  #closed = false

  push(turn: FollowUpTurn): void {
    this.#queued.push(turn)
    this.#wake?.()
  }

  close(): void {
    this.#closed = true
    this.#wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<FollowUpTurn> {
    for (;;) {
      const next = this.#queued.shift()
      if (next) {
        yield next
        continue
      }
      if (this.#closed) return
      // Re-checks the array after waking rather than trusting the wake-up, so a
      // push that lands between the resolve and the next await is not lost.
      await new Promise<void>((resolve) => {
        this.#wake = resolve
      })
      this.#wake = null
    }
  }
}

export interface AgentLoop {
  /** Feed one inbound message in. */
  handle(msg: ToWorker): void
}

/**
 * Wire up an agent that talks through `send`, and exit through `exit`.
 *
 * `exit` is a parameter because the two hosts end differently: a forked worker
 * calls `process.exit` after letting IPC flush, while a stdio agent has to let
 * its stdout drain first or the last events are lost in the pipe.
 */
export function createAgentLoop(
  send: (msg: FromWorker) => void,
  exit: () => void,
): AgentLoop {
  const turns = new TurnQueue()
  let control: { interrupt: () => Promise<void> } | null = null
  let interrupted = false
  let started = false
  /** The turn events belong to. Updated by `onTurnStart` as each message goes in. */
  let currentRunId = ""

  async function main(job: RunAgentOptions): Promise<void> {
    currentRunId = job.runId

    try {
      const opts: RunAgentOptions = {
        ...job,
        onTurnStart: (runId) => {
          currentRunId = runId
          // Per turn, not per process: stopping one message must not leave every
          // later message in this conversation pre-cancelled.
          interrupted = false
        },
        followUps: turns,
        onControl: (c) => {
          control = c
          // An interrupt that arrived before the SDK was ready still applies.
          if (interrupted) void c.interrupt().catch(() => {})
        },
        onDelta: (delta: RunDelta) => send({ type: "delta", runId: currentRunId, body: delta }),
      }
      for await (const body of runAgent(opts)) {
        const runId = currentRunId
        send({ type: "event", runId, body })
        // Each turn is reported as it lands, and the session stays open for the
        // next message.
        if (body.type === "run.finished" || body.type === "run.error") {
          send({ type: "done", runId, interrupted })
        }
      }
    } catch (err) {
      send({
        type: "event",
        runId: currentRunId,
        body: { type: "run.error", message: err instanceof Error ? err.message : String(err) },
      })
    } finally {
      // `closed` rather than `done`: the parent has already been told about each
      // turn, and what it needs to learn here is that the warm session is gone
      // and the next message has to start one.
      send({ type: "closed" })
      exit()
    }
  }

  return {
    handle(msg: ToWorker): void {
      if (msg?.cmd === "interrupt") {
        interrupted = true
        // If the run has not reached the SDK yet there is nothing to interrupt;
        // the flag alone makes the eventual result read as cancelled.
        void control?.interrupt().catch(() => {})
        return
      }
      if (msg?.cmd === "turn") {
        turns.push(msg.turn)
        return
      }
      if (msg?.cmd === "close") {
        turns.close()
        return
      }
      if (msg?.cmd === "start" && !started) {
        started = true
        void main(msg.job)
      }
    },
  }
}
