import matter from "gray-matter"

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
 * readable description of the project" true — and because `parseTask` already
 * establishes the pattern of hand-edited frontmatter validated at parse time.
 */

/** Ten minutes. A cold `pnpm install` on a large monorepo is minutes, not seconds. */
export const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 600_000

export interface ProjectDoc {
  /**
   * Shell command run in each FRESH worktree before the agent starts, or null.
   *
   * Null by default and scaffolded commented-out, because aide manages arbitrary
   * repos and guessing a package manager is worse than doing nothing.
   */
  bootstrap: string | null
  bootstrapTimeoutMs: number
  /** The prose below the frontmatter. This is what reaches the agent. */
  body: string
}

export const EMPTY_PROJECT_DOC: ProjectDoc = {
  bootstrap: null,
  bootstrapTimeoutMs: DEFAULT_BOOTSTRAP_TIMEOUT_MS,
  body: "",
}

/**
 * Validated the same way task frontmatter is, and for the same reason: this file
 * is hand-edited, so a typo must fail loudly rather than silently becoming
 * `undefined` and quietly skipping the bootstrap on every run afterwards.
 *
 * A throw here surfaces as `run.error` at the start of a run, which is exactly
 * where a configuration mistake should appear.
 */
export function parseProjectDoc(raw: string): ProjectDoc {
  const { data, content } = matter(raw)

  const bootstrapRaw = data["bootstrap"]
  let bootstrap: string | null = null
  if (bootstrapRaw !== undefined && bootstrapRaw !== null) {
    if (typeof bootstrapRaw !== "string") {
      throw new Error(
        `project.md: \`bootstrap\` must be a string, got ${JSON.stringify(bootstrapRaw)}`,
      )
    }
    bootstrap = bootstrapRaw.trim() || null
  }

  const timeoutRaw = data["bootstrapTimeoutMs"]
  let bootstrapTimeoutMs = DEFAULT_BOOTSTRAP_TIMEOUT_MS
  if (timeoutRaw !== undefined && timeoutRaw !== null) {
    const n = Number(timeoutRaw)
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(
        `project.md: \`bootstrapTimeoutMs\` must be a positive number, got ${JSON.stringify(timeoutRaw)}`,
      )
    }
    bootstrapTimeoutMs = n
  }

  return { bootstrap, bootstrapTimeoutMs, body: content.trim() }
}
