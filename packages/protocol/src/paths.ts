import { homedir } from "node:os"
import { join } from "node:path"

/**
 * The per-project state directory name. This lands in every repo aide manages,
 * so it is the one string in the codebase that is genuinely expensive to change.
 * Everything routes through the helpers below so a rename stays a one-line edit.
 *
 * Note: NOT `.claude` — that belongs to Claude Code itself.
 */
export const STATE_DIR = ".aide"

/** `<project>/.aide` */
export const stateDir = (root: string) => join(root, STATE_DIR)
/** `<project>/.aide/tasks` — one markdown file per task */
export const tasksDir = (root: string) => join(stateDir(root), "tasks")
/** `<project>/.aide/worktrees` — gitignored; one worktree per running task */
export const worktreesDir = (root: string) => join(stateDir(root), "worktrees")
/** `<project>/.aide/specs` — slice 3 */
export const specsDir = (root: string) => join(stateDir(root), "specs")
/** `<project>/.aide/journal` — one entry per committed task */
export const journalDir = (root: string) => join(stateDir(root), "journal")
/** `<project>/.aide/journal/<file>` */
export const journalEntryPath = (root: string, file: string) => join(journalDir(root), file)
/** `<project>/.aide/decisions` — later */
export const decisionsDir = (root: string) => join(stateDir(root), "decisions")

export const projectDocPath = (root: string) => join(stateDir(root), "project.md")
export const inboxPath = (root: string) => join(stateDir(root), "inbox.md")
export const taskPath = (root: string, file: string) => join(tasksDir(root), file)
export const worktreePath = (root: string, taskId: string) =>
  join(worktreesDir(root), `task-${taskId}`)

/** Daemon-global state, outside any project: `~/.aide` */
export const aideHome = () => join(homedir(), STATE_DIR)
export const registryPath = () => join(aideHome(), "registry.json")
export const runsDir = () => join(aideHome(), "runs")
export const runLogPath = (runId: string) => join(runsDir(), `${runId}.ndjson`)

/** Branch name for a task's worktree. */
export const branchName = (taskId: string) => `aide/task-${taskId}`
