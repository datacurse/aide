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
  /**
   * Commands that decide whether this project's tree is sound, run in order
   * before a commit is written.
   *
   * This is the half of "a gate on the code" that was missing. The agent already
   * runs a project's checks most of the time and then reports the result itself,
   * which makes the only evidence that a diff is sound a sentence written by the
   * thing being checked. These run outside the model, in aide, and what they
   * printed goes in the log — so "all four commands green" stops being a claim.
   *
   * Empty for a project that declares none, and an empty list means no gate
   * rather than a gate that always opens: nothing is asserted about a tree
   * nobody said how to check.
   *
   * Written WITHOUT an env prefix — `pnpm typecheck`, not `CI=true pnpm
   * typecheck`. `CONFIG.runEnv` supplies that to these the same way it supplies
   * it to an agent's shell, which is what keeps one command working on both a
   * POSIX shell and cmd.exe.
   */
  verify: string[]
}

export const EMPTY_PROJECT_DOC: ProjectDoc = {
  body: "",
  retired: [],
  verify: [],
}

/**
 * Frontmatter's `verify:` into the list a commit runs.
 *
 * Throws rather than falling back, which is the rule this file's validation
 * exists for and the reason it is worth having at all: a mistyped key that
 * silently becomes an empty list is a gate that quietly stopped being one, and
 * the failure is invisible — every commit goes through, exactly as it did
 * before, and nothing on screen says the checks are no longer running.
 *
 * A throw surfaces where the file is read, which is the start of a run and the
 * press of a commit — both places a configuration mistake should appear.
 */
export function parseVerify(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new Error("`verify:` in .aide/project.md must be a list of shell commands")
  }
  return value.map((entry) => {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error("every entry under `verify:` in .aide/project.md must be a command")
    }
    return entry.trim()
  })
}

/**
 * Validated the same way task frontmatter is, and for the same reason: this file
 * is hand-edited, so a typo must fail loudly rather than silently becoming
 * `undefined` and quietly skipping the bootstrap on every run afterwards.
 *
 * A throw here surfaces as `run.error` at the start of a run, which is exactly
 * where a configuration mistake should appear.
 */
