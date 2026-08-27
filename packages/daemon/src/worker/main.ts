/**
 * One child process per run.
 *
 * The isolation is the point: an agent run that crashes, wedges, or eats memory
 * takes down a worker, not the daemon holding every other project's state.
 */
import type { RunEventBody } from "@aide/protocol"
import { runAgent, type RunAgentOptions } from "../agent.js"

/** The job needs `chatMode` set for the worker to ask instead of failing closed. */
export type ToWorker =
  | { cmd: "start"; job: RunAgentOptions }
  | { cmd: "interrupt" }
  | { cmd: "permission"; requestId: string; allowed: boolean }

export type FromWorker =
  | { type: "ready" }
  | { type: "event"; body: RunEventBody }
  | { type: "permission"; requestId: string; name: string; input: unknown }
  | { type: "done"; interrupted: boolean }

const send = (msg: FromWorker) => {
  process.send?.(msg)
}

let control: { interrupt: () => Promise<void> } | null = null
let interrupted = false
let started = false

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
  if (msg?.cmd === "start" && !started) {
    started = true
    void main(msg.job)
  }
})

async function main(job: RunAgentOptions): Promise<void> {
  try {
    const opts: RunAgentOptions = {
      ...job,
      onControl: (c) => {
        control = c
        // An interrupt that arrived before the SDK was ready still applies.
        if (interrupted) void c.interrupt().catch(() => {})
      },
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
                  requestId: req.requestId,
                  name: req.name,
                  input: req.input,
                })
              }),
          }
        : {}),
    }
    for await (const body of runAgent(opts)) {
      send({ type: "event", body })
    }
  } catch (err) {
    send({
      type: "event",
      body: { type: "run.error", message: err instanceof Error ? err.message : String(err) },
    })
  } finally {
    settleAll(false)
    send({ type: "done", interrupted })
    // Give the IPC channel a tick to flush before the process goes away.
    setTimeout(() => process.exit(0), 50)
  }
}

// The job arrives over IPC rather than argv: a task prompt can exceed the
// ~32k Windows command-line limit.
send({ type: "ready" })
