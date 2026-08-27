import type { RunEvent, TaskStatus } from "@aide/protocol"
import type { EventLog } from "./eventlog.js"
import { listProjects } from "./registry.js"
import { listTasks, setStatus, statusAfterRun } from "./tasks.js"

/**
 * Resolve tasks left mid-flight by a daemon that died.
 *
 * The premise is simple and worth stating, because everything here rests on it:
 * the daemon is the only thing that starts runs, so at boot nothing is running
 * BY CONSTRUCTION. Any task filed `running` is therefore wreckage, and no
 * pidfile or liveness probe is needed to know it.
 *
 * Without this pass, the wreckage is not merely untidy. `idle()` — the guard
 * that decides whether it is safe to commit — is purely in-memory, so after a
 * restart it reports a task with a dead run as idle and cheerfully offers the
 * commit button on a worktree its agent may have been halfway through writing.
 * That is exactly the race the guard exists to prevent, reintroduced by the
 * restart. And the task itself would sit at `running` forever, since nothing
 * else ever moves it.
 *
 * Worktrees are deliberately NOT removed. Whatever the agent managed to write
 * before the daemon died is precisely what the human needs to look at, and the
 * accept bar already handles `cancelled` — so the partial work stays
 * salvageable.
 */

export interface Stranded {
  projectName: string
  taskId: string
  title: string
  from: TaskStatus
  to: TaskStatus
  runId: string | null
}

/** The terminal event of a run, if it has one. */
function outcome(events: readonly RunEvent[]): RunEvent | undefined {
  // The LAST one: older logs carry a redundant run.error after their result, and
  // the result is the authoritative record.
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]
    if (e?.type === "run.finished") return e
  }
  return undefined
}

export async function reconcileStrandedTasks(log: EventLog): Promise<Stranded[]> {
  const found: Stranded[] = []

  for (const project of await listProjects()) {
    let tasks
    try {
      tasks = await listTasks(project)
    } catch {
      // A project directory that has moved or been deleted must not stop the
      // daemon from starting for every other project.
      continue
    }

    for (const task of tasks) {
      // `queued` is ambiguous — createTask seeds it, so a never-run task looks
      // identical to one that was admitted and then abandoned. `runs` is what
      // separates them.
      const abandoned = task.status === "running" || (task.status === "queued" && task.runs.length > 0)
      if (!abandoned) continue

      const runId = task.runs.at(-1) ?? null
      const events = runId ? log.read(runId) : []
      const finished = outcome(events)

      // The daemon died between the result arriving and the status being
      // written. The result is real; honour it rather than calling it cancelled.
      const to: TaskStatus = finished?.type === "run.finished"
        ? statusAfterRun(finished.status)
        : "cancelled"

      if (!finished && runId) {
        // Appending to the run's own log rather than only flipping the status is
        // what makes this need no UI work: the run pane already renders
        // run.error, so the transcript explains itself.
        log.append(runId, {
          type: "run.error",
          message: "the daemon stopped while this run was in flight; it did not finish",
        })
      }

      await setStatus(project, task.id, to)
      found.push({
        projectName: project.name,
        taskId: task.id,
        title: task.title,
        from: task.status,
        to,
        runId,
      })
    }
  }

  return found
}
