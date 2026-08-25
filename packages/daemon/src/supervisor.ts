import { fork, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import type { Project, RunStatus, Task } from "@aide/protocol"
import type { RunAgentOptions } from "./agent.js"
import { CONFIG } from "./config.js"
import type { EventLog } from "./eventlog.js"
import { patchTask, setStatus } from "./tasks.js"
import type { FromWorker, ToWorker } from "./worker/main.js"
import { ensureWorktree } from "./worktree.js"

const WORKER = fileURLToPath(new URL("./worker/main.ts", import.meta.url))

/** How long a worker gets to honour an interrupt before we stop being polite. */
const INTERRUPT_GRACE_MS = 10_000

interface ActiveRun {
  runId: string
  taskId: string
  projectId: string
  child: ChildProcess
  interrupted: boolean
}

export class Supervisor {
  #active = new Map<string, ActiveRun>()
  #queue: Array<() => void> = []
  #running = 0

  constructor(private readonly log: EventLog) {}

  activeRuns(): Array<{ runId: string; taskId: string; projectId: string }> {
    return [...this.#active.values()].map(({ runId, taskId, projectId }) => ({
      runId,
      taskId,
      projectId,
    }))
  }

  runIdForTask(taskId: string): string | undefined {
    return [...this.#active.values()].find((r) => r.taskId === taskId)?.runId
  }

  /**
   * Queue a run. Resolves with the run id as soon as it is admitted, not when it
   * finishes, so the HTTP caller gets something to subscribe to immediately.
   */
  async enqueue(project: Project, task: Task): Promise<string> {
    const runId = randomUUID()
    await patchTask(project, task.id, { status: "queued", addRun: runId })

    void this.#slot(async () => {
      await this.#execute(project, task, runId)
    })
    return runId
  }

  /**
   * FIFO with a concurrency cap. Two concurrent Opus workers is a review-bandwidth
   * limit as much as a rate-limit one: six simultaneous diffs is worse than two.
   */
  async #slot(fn: () => Promise<void>): Promise<void> {
    if (this.#running >= CONFIG.maxConcurrentRuns) {
      await new Promise<void>((resolve) => this.#queue.push(resolve))
    }
    this.#running += 1
    try {
      await fn()
    } finally {
      this.#running -= 1
      this.#queue.shift()?.()
    }
  }

  async #execute(project: Project, task: Task, runId: string): Promise<void> {
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
      allowedTools: CONFIG.allowedTools,
      maxBudgetUsd: CONFIG.maxBudgetUsd,
    }

    const child = fork(WORKER, [], {
      // The daemon runs under tsx, so the child needs the same loader to import
      // a .ts entrypoint.
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    })

    const record: ActiveRun = {
      runId,
      taskId: task.id,
      projectId: project.id,
      child,
      interrupted: false,
    }
    this.#active.set(runId, record)

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

    this.#active.delete(runId)

    await setStatus(
      project,
      task.id,
      state.status === "success"
        ? "needs-review"
        : state.status === "cancelled"
          ? "cancelled"
          : "failed",
    )
  }

  /**
   * Stop a run.
   *
   * Step 2 is the whole reason this is not a signal. On Windows, Node maps
   * child.kill("SIGINT") to TerminateProcess, which is exactly the SIGTERM
   * behaviour the docs warn about: the turn ends unfinished and no result is
   * recorded. interrupt() is a control message over the SDK's stdin channel and
   * behaves identically on every platform.
   */
  async interrupt(runId: string): Promise<boolean> {
    const record = this.#active.get(runId)
    if (!record) return false

    record.interrupted = true
    record.child.send({ cmd: "interrupt" } satisfies ToWorker)

    setTimeout(() => {
      if (this.#active.has(runId)) {
        this.log.append(runId, {
          type: "run.error",
          message: `worker did not exit within ${INTERRUPT_GRACE_MS}ms; killed`,
        })
        record.child.kill()
      }
    }, INTERRUPT_GRACE_MS).unref()

    return true
  }
}
