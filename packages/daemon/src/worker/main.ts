/**
 * One child process per run.
 *
 * The isolation is the point: an agent run that crashes, wedges, or eats memory
 * takes down a worker, not the daemon holding every other project's state.
 */
import type { RunEventBody } from "@aide/protocol"
import { runAgent, type RunAgentOptions } from "../agent.js"

export type ToWorker = { cmd: "start"; job: RunAgentOptions } | { cmd: "interrupt" }
export type FromWorker =
  | { type: "ready" }
  | { type: "event"; body: RunEventBody }
  | { type: "done"; interrupted: boolean }

const send = (msg: FromWorker) => {
  process.send?.(msg)
}

let control: { interrupt: () => Promise<void> } | null = null
let interrupted = false
let started = false

process.on("message", (raw: unknown) => {
  const msg = raw as ToWorker
  if (msg?.cmd === "interrupt") {
    interrupted = true
    // If the run has not reached the SDK yet there is nothing to interrupt;
    // the flag alone makes the eventual result read as cancelled.
    void control?.interrupt().catch(() => {})
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
    send({ type: "done", interrupted })
    // Give the IPC channel a tick to flush before the process goes away.
    setTimeout(() => process.exit(0), 50)
  }
}

// The job arrives over IPC rather than argv: a task prompt can exceed the
// ~32k Windows command-line limit.
send({ type: "ready" })
