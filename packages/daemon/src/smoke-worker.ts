/**
 * A worker that speaks the real IPC protocol and never contacts a model.
 *
 * Used only by `smoke-queue.ts`, pointed at via AIDE_WORKER. It exists so the
 * queue can be tested through the real fork and the real handshake — the parts
 * that actually broke — rather than through a stubbed-out `#execute` that would
 * prove the test harness works and nothing else.
 *
 * AIDE_SMOKE_WORK_MS controls how long a "run" takes, which is what lets a test
 * observe the concurrency cap holding.
 */
import type { FromWorker, ToWorker } from "./worker/main.js"

const WORK_MS = Number(process.env["AIDE_SMOKE_WORK_MS"] ?? 300)

const send = (msg: FromWorker) => {
  process.send?.(msg)
}

let interrupted = false
let timer: ReturnType<typeof setTimeout> | undefined

process.on("message", (raw: unknown) => {
  const msg = raw as ToWorker
  if (msg?.cmd === "interrupt") {
    interrupted = true
    if (timer) clearTimeout(timer)
    finish()
    return
  }
  if (msg?.cmd === "start") {
    timer = setTimeout(finish, WORK_MS)
  }
})

function finish(): void {
  send({
    type: "event",
    body: {
      type: "run.finished",
      subtype: interrupted ? "interrupted" : "success",
      status: interrupted ? "cancelled" : "success",
      totalCostUsd: 0,
      modelUsage: {},
      numTurns: 1,
      durationMs: WORK_MS,
      permissionDenials: [],
    },
  })
  send({ type: "done", interrupted })
  setTimeout(() => process.exit(0), 20)
}

send({ type: "ready" })
