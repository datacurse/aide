import { existsSync } from "node:fs"
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Project, RunStatus, Task, TaskStatus } from "@aide/protocol"
import { branchName, nextTaskId, taskFileName, STATE_DIR } from "@aide/protocol"
import { parseTask, serializeTask, tasksDir } from "@aide/protocol/node"

/**
 * Tasks live as markdown in the project repo, not in a daemon-side database.
 * One file per task merges cleanly, greps usefully, and stays hand-editable when
 * the daemon is not running.
 */
export async function listTasks(project: Project): Promise<Task[]> {
  const dir = tasksDir(project.root)
  if (!existsSync(dir)) return []

  const tasks: Task[] = []
  for (const file of await readdir(dir)) {
    if (!file.endsWith(".md")) continue
    const raw = await readFile(join(dir, file), "utf8")
    try {
      tasks.push(parseTask(file, raw))
    } catch (err) {
      // One malformed file must not blank the whole list. Surface it as a failed
      // task so it is visible and fixable rather than silently missing.
      tasks.push({
        id: file.slice(0, 4),
        title: `${file} (unreadable: ${err instanceof Error ? err.message : String(err)})`,
        status: "failed",
        branch: "",
        worktree: "",
        runs: [],
        commits: [],
        created: new Date(0).toISOString(),
        prompt: "",
        file,
      })
    }
  }
  return tasks.sort((a, b) => a.id.localeCompare(b.id))
}

export async function getTask(project: Project, id: string): Promise<Task | undefined> {
  return (await listTasks(project)).find((t) => t.id === id)
}

export async function createTask(
  project: Project,
  title: string,
  prompt: string,
): Promise<Task> {
  const dir = tasksDir(project.root)
  await mkdir(dir, { recursive: true })

  const existing = await listTasks(project)
  const id = nextTaskId(existing.map((t) => t.id))
  const task: Task = {
    id,
    title,
    status: "queued",
    branch: branchName(id),
    worktree: `${STATE_DIR}/worktrees/task-${id}`,
    runs: [],
    commits: [],
    created: new Date().toISOString(),
    prompt,
    file: taskFileName(id, title),
  }
  await writeFile(join(dir, task.file), serializeTask(task), "utf8")
  return task
}

export async function writeTask(project: Project, task: Task): Promise<Task> {
  const dir = tasksDir(project.root)
  const wanted = taskFileName(task.id, task.title)

  await writeFile(join(dir, task.file), serializeTask(task), "utf8")

  // Keep the filename in step with the title so the directory stays readable.
  if (wanted !== task.file) {
    await rename(join(dir, task.file), join(dir, wanted))
    return { ...task, file: wanted }
  }
  return task
}

export async function patchTask(
  project: Project,
  id: string,
  patch: Partial<Pick<Task, "status" | "title" | "prompt">> & {
    addRun?: string
    addCommit?: string
  },
): Promise<Task> {
  const task = await getTask(project, id)
  if (!task) throw new Error(`no such task: ${id}`)

  const next: Task = {
    ...task,
    ...(patch.status ? { status: patch.status } : {}),
    ...(patch.title ? { title: patch.title } : {}),
    ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
    runs: patch.addRun ? [...task.runs, patch.addRun] : task.runs,
    commits: patch.addCommit ? [...task.commits, patch.addCommit] : task.commits,
  }
  return writeTask(project, next)
}

export async function setStatus(
  project: Project,
  id: string,
  status: TaskStatus,
): Promise<Task> {
  return patchTask(project, id, { status })
}

/**
 * Where a task lands when its run stops.
 *
 * Shared by the supervisor and by boot reconciliation on purpose: a task the
 * daemon watched finish and one recovered from a crashed daemon's log must be
 * filed the same way, or "cancelled" quietly means two different things
 * depending on whether anyone was watching.
 */
export function statusAfterRun(status: RunStatus): TaskStatus {
  if (status === "success") return "needs-review"
  if (status === "cancelled") return "cancelled"
  return "failed"
}

export async function deleteTask(project: Project, id: string): Promise<void> {
  const task = await getTask(project, id)
  if (!task) return
  await unlink(join(tasksDir(project.root), task.file))
}
