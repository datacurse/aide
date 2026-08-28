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

/**
 * A short, filesystem- and ref-safe slug from arbitrary prose.
 *
 * Used for the readable half of a branch name. Capped, because this ends up in
 * a path and in `git log` forever, and a forty-word todo makes both unusable.
 */
export function slugify(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "")
  return s || "untitled"
}
