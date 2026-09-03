/**
 * A worker that speaks the real IPC protocol and never contacts a model.
 *
 * Used by `smoke-queue.ts`, pointed at via AIDE_WORKER. It exists so the queue
 * and the chat lane can be tested through the real fork and the real handshake —
 * the parts that actually broke — rather than through a stubbed-out `#execute`
 * that would prove the test harness works and nothing else.
 *
 * It mirrors the real worker's two lifetimes: a task job (no `chatMode`) reports
 * one turn and exits, and a chat job stays up taking follow-ups until it is
 * closed. Getting that wrong here would make the chat-lane cases pass against a
 * shape the real worker does not have.
 *
 * AIDE_SMOKE_WORK_MS controls how long a "run" takes, which is what lets a test
 * observe the concurrency cap holding.
 */
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import type { RunAgentOptions } from "./agent.js"
import type { FromWorker, ToWorker } from "./worker/main.js"

const WORK_MS = Number(process.env["AIDE_SMOKE_WORK_MS"] ?? 300)

/**
 * A UUID, because a real session id is one.
 *
 * This used to be `smoke-session-<pid>`, which read fine and was not the shape
 * of the thing it stood in for. That mattered the moment session ids started
 * naming git refs: the daemon refuses a key it cannot safely put in a ref name,
 * so the stub was exercising a rejection path that no real session can reach.
 *
 * Derived from the pid rather than random, so it stays stable across the turns
 * of one stub process — which is what lets a test assert a follow-up landed in
 * the session that was already open.
 */
const stubSessionId = (): string =>
  `00000000-0000-4000-8000-${String(process.pid).padStart(12, "0").slice(-12)}`

const send = (msg: FromWorker) => {
  process.send?.(msg)
}

let interrupted = false
let session = false
let runId = ""
let cwd = ""
/** What the job asked for, so a follow-up can restate it the way the SDK does. */
let job: RunAgentOptions | null = null
/** The id this session reports. Minted once and repeated on every turn. */
let named = ""
/** Turns the stub has been given, so a test can assert the session was reused. */
let turnsTaken = 0
let timer: ReturnType<typeof setTimeout> | undefined

/**
 * Leave a mark on the working tree, the way an agent that did anything would.
 *
 * A stub that only talked would make every turn boundary a no-op — the daemon
 * skips a snapshot when the tree is unchanged — and the queue smoke would pass
 * without ever exercising the path. The content changes per turn so consecutive
 * boundaries are genuinely different trees.
 */
function work(): void {
  if (!cwd) return
  writeFileSync(join(cwd, "smoke-work.txt"), `turn ${turnsTaken}\n`, "utf8")
}

/** The SDK's init message, as this stub sends it: once per turn, same id. */
function announce(): void {
  send({
    type: "event",
    runId,
    body: {
      type: "run.started",
      projectId: job?.projectId ?? "",
      model: job?.model ?? "",
      cwd,
      sessionId: named,
    },
  })
}

process.on("message", (raw: unknown) => {
  const msg = raw as ToWorker
  if (msg?.cmd === "interrupt") {
    interrupted = true
    if (timer) clearTimeout(timer)
    finish()
    return
  }
  if (msg?.cmd === "start") {
    job = msg.job as RunAgentOptions
    session = Boolean(job.chatMode)
    runId = job.runId
    cwd = job.cwd
    named = job.resume ?? stubSessionId()
    turnsTaken = 1
    work()
    // A chat session reports its id the way the SDK's init message does, or the
    // lane has nothing to key a warm session by and every follow-up cold-starts.
    if (session) announce()
    timer = setTimeout(finish, WORK_MS)
    return
  }
  if (msg?.cmd === "turn") {
    runId = msg.turn.runId
    turnsTaken += 1
    interrupted = false
    work()
    // A follow-up reports the session too. The SDK sends its init message on
    // every turn of an open session, not only on the first, and that repetition
    // is load bearing: a run log is the only record of which conversation a turn
    // belonged to, so a stub that announced it once left every turn after the
    // first unattributable — and a profile, which finds a conversation's runs by
    // exactly this event, read a four-turn chat as a one-turn chat.
    announce()
    timer = setTimeout(finish, WORK_MS)
    return
  }
  if (msg?.cmd === "close") {
    send({ type: "closed" })
    setTimeout(() => process.exit(0), 20)
  }
})

function finish(): void {
  send({
    type: "event",
    runId,
    body: {
      type: "run.finished",
      subtype: interrupted ? "interrupted" : "success",
      status: interrupted ? "cancelled" : "success",
      // Turn count doubles as the assertion that a follow-up reached a session
      // that was already open rather than a freshly forked one.
      totalCostUsd: turnsTaken,
      modelUsage: {},
      numTurns: turnsTaken,
      durationMs: WORK_MS,
      permissionDenials: [],
    },
  })
  send({ type: "done", runId, interrupted })
  // A chat session outlives its turn; a task run is done and goes away.
  if (!session) setTimeout(() => process.exit(0), 20)
}

send({ type: "ready" })
