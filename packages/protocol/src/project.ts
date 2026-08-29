/**
 * `.aide/project.md` — one file with two readers.
 *
 * The frontmatter is configuration the daemon acts on; the prose below it is
 * context the agent reads. gray-matter strips the frontmatter from `content`, so
 * neither half ever sees the other's, and the file stays a single hand-editable
 * markdown document rather than a config file plus a doc file that drift apart.
 *
 * Frontmatter rather than a new `.aide/config.json` because `.aide/` being
 * markdown-only is what makes "if aide disappears, this directory is still a
 * readable description of the project" true.
 */

/** A git repository aide has been pointed at. */
export interface Project {
  id: string
  name: string
  /** Absolute path to the git repo root. */
  root: string
  /** ISO 8601. */
  addedAt: string
}

/**
 * What the machine's own folder dialog came back with.
 *
 * Three outcomes in two fields, and a caller that collapses any two of them gets
 * it wrong. A path is a pick. Both null is a cancel, which is not an error and
 * must put nothing on screen. `unavailable` is "there was no dialog to open
 * here" — the only case where falling back to typing a path is the right answer,
 * and the reason it is a sentence rather than a boolean.
 */
export interface FolderPick {
  path: string | null
  unavailable: string | null
}

/**
 * Frontmatter keys aide used to act on and no longer does.
 *
 * `bootstrap` ran a project's setup command in each fresh worktree, because
 * `git worktree add` checks out tracked files only and left the agent with no
 * `node_modules`. Runs work the project's own checkout now, which already has
 * its dependencies, so there is nothing left for the command to do.
 *
 * Named rather than deleted, because silently ignoring a line someone wrote is
 * the failure mode this file's validation exists to prevent. A project.md that
 * still sets one gets a warning on the board until it is cleaned up.
 */
export const RETIRED_DOC_KEYS = ["bootstrap", "bootstrapTimeoutMs"] as const

export interface ProjectDoc {
  /** The prose below the frontmatter. This is what reaches the agent. */
  body: string
  /** Retired keys this file still sets. Empty for every up-to-date project. */
  retired: string[]
}

export const EMPTY_PROJECT_DOC: ProjectDoc = {
  body: "",
  retired: [],
}

/**
 * Validated the same way task frontmatter is, and for the same reason: this file
 * is hand-edited, so a typo must fail loudly rather than silently becoming
 * `undefined` and quietly skipping the bootstrap on every run afterwards.
 *
 * A throw here surfaces as `run.error` at the start of a run, which is exactly
 * where a configuration mistake should appear.
 */
