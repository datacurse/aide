/**
 * Names, not paths. Pure strings with no filesystem involved, so they stay on
 * the browser-safe side of the package.
 *
 * `paths.ts` builds real paths out of these with `node:path` and is Node-only;
 * these two are just vocabulary, and both ends need them — the web to recognise
 * a worktree, the daemon to create one.
 */

/**
 * The per-project state directory name. This lands in every repo aide manages,
 * so it is the one string in the codebase that is genuinely expensive to change.
 * Everything routes through it so a rename stays a one-line edit.
 *
 * Note: NOT `.claude` — that belongs to Claude Code itself.
 */
export const STATE_DIR = ".aide"

/** Branch name for a task's worktree. */
export const branchName = (taskId: string) => `aide/task-${taskId}`
