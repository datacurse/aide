
// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export const TASK_STATUSES = [
  "queued",
  "running",
  "needs-review",
  "committed",
  "done",
  "failed",
  "cancelled",
] as const

export type TaskStatus = (typeof TASK_STATUSES)[number]

/**
 * The lifecycle, in order:
 *
 *   queued -> running -> needs-review -> committed -> done
 *                     \-> failed | cancelled
 *
 * Two human gates, not one. `needs-review` means the agent stopped and the diff
 * is unread. `committed` means you read it and the work is on the task branch,
 * which is a safe resting state: nothing has touched the main branch yet.
 * `done` means it landed. Splitting the gates matters because committing is
 * recoverable and merging is the step that changes what everyone else sees.
 */

/**
 * The one place aide does runtime validation, and the reason it needs no schema
 * library: task files are hand-edited, so a typo in `status:` must fail loudly
 * instead of silently becoming `undefined` and stranding the task forever.
 */
export function asStatus(v: unknown): TaskStatus {
  if (typeof v === "string" && (TASK_STATUSES as readonly string[]).includes(v)) {
    return v as TaskStatus
  }
  throw new Error(
    `bad task status ${JSON.stringify(v)} — expected one of ${TASK_STATUSES.join(", ")}`,
  )
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface Task {
  id: string
  title: string
  status: TaskStatus
  branch: string
  /** Path relative to the project root. */
  worktree: string
  /** Run ids, oldest first. */
  runs: string[]
  /** Commit shas on the task branch, oldest first. A re-run can add another. */
  commits: string[]
  /** ISO 8601. */
  created: string
  /** The markdown body. This IS the prompt handed to the agent. */
  prompt: string
  /** Filename within `.aide/tasks/`, e.g. `0004-fix-queue.md`. */
  file: string
}

export interface Project {
  id: string
  name: string
  /** Absolute path to the git repo root. */
  root: string
  /** ISO 8601. */
  addedAt: string
}

// ---------------------------------------------------------------------------
// Frontmatter <-> Task
// ---------------------------------------------------------------------------

/** YAML turns unquoted dates into Date objects and `0004` into a number. Normalize. */
export const asText = (v: unknown, field: string): string => {
  if (v instanceof Date) return v.toISOString()
  if (typeof v === "string") return v
  if (typeof v === "number") return String(v)
  throw new Error(`task frontmatter: \`${field}\` must be a string, got ${JSON.stringify(v)}`)
}

export const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x)) : []

export function slugify(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "")
  return s || "task"
}

export const taskFileName = (id: string, title: string) => `${id}-${slugify(title)}.md`

/** Next zero-padded id given the ids already present. */
export function nextTaskId(existing: readonly string[]): string {
  const max = existing.reduce((n, id) => Math.max(n, Number.parseInt(id, 10) || 0), 0)
  return String(max + 1).padStart(4, "0")
}
