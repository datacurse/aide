/**
 * Names, not paths. Pure strings with no filesystem involved, so they stay on
 * the browser-safe side of the package.
 *
 * `paths.ts` builds real paths out of these with `node:path` and is Node-only;
 * this is just vocabulary, and both ends need it.
 *
 * It used to hold `slugify` as well, for the readable half of a branch name.
 * Runs work the project's own checkout and aide creates no branches, so it had
 * no callers left — see the brief.
 */

/**
 * The per-project state directory name. This lands in every repo aide manages,
 * so it is the one string in the codebase that is genuinely expensive to change.
 * Everything routes through it so a rename stays a one-line edit.
 *
 * Note: NOT `.claude` — that belongs to Claude Code itself.
 */
export const STATE_DIR = ".aide"

