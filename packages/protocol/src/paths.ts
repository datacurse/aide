import { homedir } from "node:os"
import { join } from "node:path"
import { STATE_DIR } from "./names.js"



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

