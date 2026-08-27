import { fork, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import type { Project, RunStatus, Task } from "@aide/protocol"
import type { RunAgentOptions } from "./agent.js"
import { CONFIG } from "./config.js"
import type { EventLog } from "./eventlog.js"
import { killTree } from "./proc.js"
import { patchTask, setStatus, statusAfterRun } from "./tasks.js"
import type { FromWorker, ToWorker } from "./worker/main.js"
import { ensureWorktree } from "./worktree.js"

/**
 * The worker entrypoint, overridable so the queue can be exercised without
 * spending money.
 *
 * `smoke-queue.ts` points this at a stub that speaks the same IPC protocol and
 * finishes on a timer. That tests the real fork, the real IPC handshake and the
 * real status transitions — which a hand-stubbed `#execute` would not — while
 * never reaching the Agent SDK.
 *
 * Note this is read at fork time, not at import time, which is also why landing
 * daemon changes without restarting can leave an old supervisor forking a new
 * worker. See the README.
 */
const WORKER =
  process.env["AIDE_WORKER"] ?? fileURLToPath(new URL("./worker/main.ts", import.meta.url))

/** How long a worker gets to honour an interrupt before we stop being polite. */
const INTERRUPT_GRACE_MS = 10_000

/** How long a whole shutdown waits for every run to end cleanly. */
const SHUTDOWN_GRACE_MS = 8_000

export type RunPhase = "queued" | "running"

export interface RunView {
  runId: string
  taskId: string
  projectId: string
  phase: RunPhase
  /** 1-based place in the FIFO while queued; 0 once running. */
  position: number
}

interface RunRecord {
  runId: string
  taskId: string
  projectId: string
  project: Project
  task: Task
  phase: RunPhase
  enqueuedAt: number
  /** Only once the worker has been forked. */
  child: ChildProcess | null
  /** An interrupt was asked for, so the eventual result reads as cancelled. */
  interrupted: boolean
  /** Cancelled before it ever got a slot; #pump drops it. */
  cancelled: boolean
}

export class Supervisor {
  /**
   * Every run, queued or running, in one map — and registered synchronously.
   *
   * The old shape kept running runs in a map and queued ones as anonymous
   * `() => void` resolvers, which caused two distinct bugs. A resolver cannot be
   * found, displayed, or cancelled, so a queued run was invisible and
   * un-stoppable. And because registration only happened once a concurrency slot
   * had been won — several microtasks after `enqueue` returned — two POSTs for
   * the same task arriving in the same tick BOTH passed the "is a run already in
   * flight" guard, forked two workers, and ran them in the same worktree on the
   * same branch. That was a registration-ordering race, so it happened even well
   * below the concurrency cap.
   */
  #runs = new Map<string, RunRecord>()
  /** Run ids in FIFO order, waiting for a slot. */
  #waiting: string[] = []
  #shuttingDown = false

  constructor(private readonly log: EventLog) {}

  /** Every run the daemon knows about, queued ones included. */
  runs(): RunView[] {
    return [...this.#runs.values()].map((r) => ({
      runId: r.runId,
      taskId: r.taskId,
      projectId: r.projectId,
      phase: r.phase,
      position: r.phase === "queued" ? this.#waiting.indexOf(r.runId) + 1 : 0,
    }))
  }

  /**
   * Searches queued runs too, which is the whole fix for double-enqueue: a task
   * waiting behind the cap is emphatically not idle.
   */
  runIdForTask(taskId: string): string | undefined {
    return [...this.#runs.values()].find((r) => r.taskId === taskId)?.runId
  }

  /**
   * Admit a run and return its id immediately, so the HTTP caller has something
   * to subscribe to before anything has happened.
   *
   * Synchronous up to registration, and that is not a style choice: an `async`
   * signature lets the caller interleave between the guard and the claim, which
   * is exactly the race described on `#runs`.
   */
  enqueue(project: Project, task: Task): string {
    const runId = randomUUID()

    this.#runs.set(runId, {
      runId,
      taskId: task.id,
      projectId: project.id,
      project,
      task,
      phase: "queued",
      enqueuedAt: Date.now(),
      child: null,
      interrupted: false,
      cancelled: false,
    })
    this.#waiting.push(runId)

    this.log.append(runId, {
      type: "run.queued",
      taskId: task.id,
      projectId: project.id,
      position: this.#waiting.length,
    })

    void patchTask(project, task.id, { status: "queued", addRun: runId })
      .then(() => this.#pump())
      .catch((err) => {
        // The task file is gone or unwritable. Fail the run here rather than
        // letting #execute discover it and throw out of a floating promise.
        this.log.append(runId, {
          type: "run.error",
          message: `could not record the run on the task: ${err instanceof Error ? err.message : String(err)}`,
        })
        this.#drop(runId)
      })

    return runId
  }

  /** FIFO with a concurrency cap. Replaces the old await-a-resolver scheme. */
  #pump(): void {
    if (this.#shuttingDown) return
    while (this.#runningCount() < CONFIG.maxConcurrentRuns && this.#waiting.length) {
      const runId = this.#waiting.shift()
      if (!runId) break
      const record = this.#runs.get(runId)
      // Cancelled while it waited: dropping costs nothing because no worker was
      // ever forked.
      if (!record || record.cancelled) continue
      record.phase = "running"
      void this.#execute(record).finally(() => {
        this.#runs.delete(runId)
        this.#pump()
      })
    }
  }

  #runningCount(): number {
    let n = 0
    for (const r of this.#runs.values()) if (r.phase === "running") n += 1
    return n
  }

  /** Remove a run that never reached a worker, without touching the task file. */
  #drop(runId: string): void {
    this.#runs.delete(runId)
    const at = this.#waiting.indexOf(runId)
    if (at !== -1) this.#waiting.splice(at, 1)
  }

  async #execute(record: RunRecord): Promise<void> {
    const { project, task, runId } = record

    let worktree: string
    try {
      worktree = await ensureWorktree(project.root, task.id)
    } catch (err) {
      this.log.append(runId, {
        type: "run.error",
        message: `worktree failed: ${err instanceof Error ? err.message : String(err)}`,
      })
      await setStatus(project, task.id, "failed")
      return
    }

    await setStatus(project, task.id, "running")

    const job: RunAgentOptions = {
      runId,
      taskId: task.id,
      projectId: project.id,
      prompt: task.prompt,
      cwd: worktree,
      worktree: task.worktree,
      model: CONFIG.taskModel,
      allowedTools: [...CONFIG.allowedTools],
      allowedBash: [...CONFIG.allowedBash],
      deniedBash: [...CONFIG.deniedBash],
      env: CONFIG.runEnv,
      maxBudgetUsd: CONFIG.maxBudgetUsd,
    }

    const child = fork(WORKER, [], {
      // The daemon runs under tsx, so the child needs the same loader to import
      // a .ts entrypoint.
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    })
    record.child = child

    // Assignments below happen inside event callbacks, which TS control-flow
    // analysis does not track: a plain `let` would stay narrowed to "failed".
    const state: { status: RunStatus; sawFinish: boolean } = {
      status: "failed",
      sawFinish: false,
    }

    await new Promise<void>((resolve) => {
      child.on("message", (raw: unknown) => {
        const msg = raw as FromWorker
        if (msg.type === "ready") {
          child.send({ cmd: "start", job } satisfies ToWorker)
          return
        }
        if (msg.type === "event") {
          if (msg.body.type === "run.finished") {
            state.sawFinish = true
            state.status = record.interrupted ? "cancelled" : msg.body.status
            // The worker cannot know an interrupt was requested by us, so the
            // status is corrected here where that fact lives.
            this.log.append(runId, { ...msg.body, status: state.status })
            return
          }
          this.log.append(runId, msg.body)
          return
        }
        if (msg.type === "done") {
          resolve()
        }
      })

      child.on("error", (err) => {
        this.log.append(runId, { type: "run.error", message: `worker error: ${err.message}` })
        resolve()
      })

      child.on("exit", (code, signal) => {
        if (!state.sawFinish) {
          this.log.append(runId, {
            type: "run.error",
            message: `worker exited without a result (code ${code}, signal ${signal ?? "none"})`,
          })
          state.status = record.interrupted ? "cancelled" : "failed"
        }
        resolve()
      })
    })

    await setStatus(project, task.id, statusAfterRun(state.status))
  }

  /**
   * Stop a run, queued or running.
   *
   * For a RUNNING run, step 2 is the whole reason this is not a signal. On
   * Windows, Node maps child.kill("SIGINT") to TerminateProcess, which is
   * exactly the SIGTERM behaviour the docs warn about: the turn ends unfinished
   * and no result is recorded. interrupt() is a control message over the SDK's
   * stdin channel and behaves identically on every platform.
   *
   * For a QUEUED run there is no worker to talk to, so it is resolved here and
   * given a terminal event of its own — see #finishQueued.
   */
  async interrupt(runId: string): Promise<boolean> {
    const record = this.#runs.get(runId)
    if (!record) return false

    if (record.phase === "queued") {
      await this.#finishQueued(record, "cancelled_while_queued")
      return true
    }

    record.interrupted = true
    record.child?.send({ cmd: "interrupt" } satisfies ToWorker)

    setTimeout(() => {
      const still = this.#runs.get(runId)
      if (still?.child) {
        this.log.append(runId, {
          type: "run.error",
          message: `worker did not exit within ${INTERRUPT_GRACE_MS}ms; killed`,
        })
        killTree(still.child)
      }
    }, INTERRUPT_GRACE_MS).unref()

    return true
  }

  /**
   * Cancel whatever is in flight for a task. Used before deleting a task file:
   * otherwise a queued run wakes up later, calls setStatus on a file that no
   * longer exists, and throws out of a floating promise as an unhandled
   * rejection that takes nothing with it but is invisible.
   */
  async cancelForTask(taskId: string): Promise<void> {
    for (const record of [...this.#runs.values()]) {
      if (record.taskId === taskId) await this.interrupt(record.runId)
    }
  }

  /**
   * A queued run still has to end the way every other run ends.
   *
   * Deliberately `run.finished` rather than a new event type: four separate
   * consumers — the run pane's outcome line, its "drop errors after the result"
   * filter, the footer, and the journal — all assume a log ends in exactly one
   * `run.finished` or `run.error`. A bespoke `run.cancelled` would mean teaching
   * all four about a third terminal shape to say something they already
   * understand. The supervisor already rewrites a `run.finished` it did not
   * author, so authoring one here is the same move.
   */
  async #finishQueued(record: RunRecord, subtype: string): Promise<void> {
    this.#drop(record.runId)
    this.log.append(record.runId, {
      type: "run.finished",
      subtype,
      status: "cancelled",
      totalCostUsd: 0,
      modelUsage: {},
      numTurns: 0,
      durationMs: Date.now() - record.enqueuedAt,
      permissionDenials: [],
    })
    await setStatus(record.project, record.taskId, "cancelled").catch(() => {
      // The task file may already be gone — that is the case this is called for.
    })
  }

  /**
   * End every run and return once they are all done.
   *
   * This exists because `fork()` is not job-object containment: workers are
   * grandchildren of the daemon, nothing signals them when the daemon dies, and
   * on Windows `taskkill /T /F` delivers no signal at all. Without this, every
   * restart left orphaned SDK subprocesses still editing worktrees and still
   * spending against maxBudgetUsd, with their IPC parent gone and their events
   * going nowhere.
   *
   * Interrupt first rather than killing, because an interrupted run ends with a
   * result and a cost figure while a killed one ends with a hole in the log.
   */
  async shutdown(): Promise<void> {
    this.#shuttingDown = true

    for (const record of [...this.#runs.values()]) {
      if (record.phase === "queued") await this.#finishQueued(record, "cancelled_at_shutdown")
      else void this.interrupt(record.runId)
    }

    const deadline = Date.now() + SHUTDOWN_GRACE_MS
    while (this.#runs.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
    }

    for (const record of this.#runs.values()) {
      this.log.append(record.runId, {
        type: "run.error",
        message: "the daemon shut down before this run finished",
      })
      if (record.child) killTree(record.child)
    }
    this.#runs.clear()
    this.#waiting.length = 0
  }
}
