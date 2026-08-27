import matter from "gray-matter"
import { branchName } from "./names.js"
import { asStatus, asStringArray, asText, taskFileName, type Task } from "./task.js"

/**
 * Reading and writing task files. Node-only, because gray-matter is.
 *
 * Split out of `task.ts` so the browser can import the Task TYPES and the status
 * vocabulary without dragging gray-matter — and through it `fs` and `Buffer` —
 * into the bundle. That is not hypothetical: it blanked the page the first time
 * the web imported a runtime value from the shared barrel.
 */
export function parseTask(file: string, raw: string): Task {
  const { data, content } = matter(raw)
  const id = asText(data["id"], "id").padStart(4, "0")
  return {
    id,
    title: asText(data["title"], "title"),
    status: asStatus(data["status"]),
    branch: data["branch"] ? asText(data["branch"], "branch") : branchName(id),
    worktree: asText(data["worktree"], "worktree"),
    runs: asStringArray(data["runs"]),
    commits: asStringArray(data["commits"]),
    created: asText(data["created"], "created"),
    prompt: content.trim(),
    file,
  }
}

export function serializeTask(task: Task): string {
  // Quote id and created so YAML keeps them as strings on the next read.
  return matter.stringify(`${task.prompt}\n`, {
    id: task.id,
    title: task.title,
    status: task.status,
    branch: task.branch,
    worktree: task.worktree,
    runs: task.runs,
    commits: task.commits,
    created: task.created,
  })
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------
