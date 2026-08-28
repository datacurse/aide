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
 */
import type { RunDelta, RunEventBody } from "@aide/protocol"
import { runAgent, type FollowUpTurn, type RunAgentOptions } from "../agent.js"

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
  | { type: "ready" }
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

let control: { interrupt: () => Promise<void> } | null = null
let interrupted = false
let started = false
/** The turn events belong to. Updated by `onTurnStart` as each message goes in. */
let currentRunId = ""

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

const turns = new TurnQueue()

/**
 * Tool calls waiting on a human.
 *
 * The turn is genuinely blocked while one of these is outstanding — that is the
 * point of a manual mode — so an interrupt has to settle them too, or the SDK
 * sits forever on a promise nobody will resolve and the worker never exits.
 */
const waiting = new Map<string, (allowed: boolean) => void>()

function settleAll(allowed: boolean): void {
  for (const resolve of waiting.values()) resolve(allowed)
  waiting.clear()
}

process.on("message", (raw: unknown) => {
  const msg = raw as ToWorker
  if (msg?.cmd === "interrupt") {
    interrupted = true
    // Deny anything outstanding: an interrupted turn must not go on to run a
    // tool call the human never got round to approving.
    settleAll(false)
    // If the run has not reached the SDK yet there is nothing to interrupt;
    // the flag alone makes the eventual result read as cancelled.
    void control?.interrupt().catch(() => {})
    return
  }
  if (msg?.cmd === "permission") {
    waiting.get(msg.requestId)?.(msg.allowed)
    waiting.delete(msg.requestId)
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
})

async function main(job: RunAgentOptions): Promise<void> {
  // A chat keeps its session; a task run is one turn and has nothing to follow
  // it up with. This is the whole difference between the two lifetimes.
  const session = Boolean(job.chatMode)
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
      ...(session ? { followUps: turns } : {}),
      onControl: (c) => {
        control = c
        // An interrupt that arrived before the SDK was ready still applies.
        if (interrupted) void c.interrupt().catch(() => {})
      },
      // Only a chat streams deltas — a headless task has nobody watching.
      ...(job.chatMode
        ? { onDelta: (delta: RunDelta) => send({ type: "delta", runId: currentRunId, body: delta }) }
        : {}),
      // Only chat turns ask. A task run leaves chatMode unset and keeps the
      // fail-closed path in agent.ts, because nobody is there to answer.
      ...(job.chatMode
        ? {
            onPermission: (req) =>
              new Promise<boolean>((resolve) => {
                if (interrupted) return resolve(false)
                waiting.set(req.requestId, resolve)
                send({
                  type: "permission",
                  runId: currentRunId,
                  requestId: req.requestId,
                  name: req.name,
                  input: req.input,
                })
              }),
          }
        : {}),
    }
    for await (const body of runAgent(opts)) {
      const runId = currentRunId
      send({ type: "event", runId, body })
      // A session reports each turn as it lands and keeps going. A task run has
      // one turn, and reports it from the `finally` below.
      if (session && (body.type === "run.finished" || body.type === "run.error")) {
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
    settleAll(false)
    // `closed` rather than `done`: the parent has already been told about each
    // turn, and what it needs to learn here is that the warm session is gone and
    // the next message has to start one.
    if (session) send({ type: "closed" })
    else send({ type: "done", runId: currentRunId, interrupted })
    // Give the IPC channel a tick to flush before the process goes away.
    setTimeout(() => process.exit(0), 50)
  }
}

// The job arrives over IPC rather than argv: a task prompt can exceed the
// ~32k Windows command-line limit.
send({ type: "ready" })
