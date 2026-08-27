const num = (name: string, fallback: number): number => {
  const raw = process.env[name]
  const parsed = raw === undefined ? Number.NaN : Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

const list = (name: string, fallback: string[]): string[] => {
  const raw = process.env[name]
  if (!raw) return fallback
  return raw.split(",").map((s) => s.trim()).filter(Boolean)
}

export const CONFIG = {
  port: num("AIDE_PORT", 4317),

  /** Where the Vite dev server runs. Only used to allow it as a browser origin. */
  webPort: num("AIDE_WEB_PORT", 5173),

  /**
   * Extra browser origins permitted to call this daemon, beyond loopback and
   * the dev server. Comma-separated. Almost nobody should need this.
   */
  extraOrigins: list("AIDE_ALLOWED_ORIGINS", []),

  /** Opus for the work itself. */
  taskModel: process.env["AIDE_TASK_MODEL"] ?? "claude-opus-5",
  /** Sonnet for commit messages, journal entries, intake classification (slice 2+). */
  helperModel: process.env["AIDE_HELPER_MODEL"] ?? "claude-sonnet-5",

  /**
   * Two is a review-bandwidth limit as much as a rate-limit one. Raising this
   * mostly buys you more diffs than you can actually read.
   */
  maxConcurrentRuns: num("AIDE_MAX_CONCURRENT", 2),

  /** Per run. Ends the run with subtype error_max_budget_usd rather than a surprise. */
  maxBudgetUsd: num("AIDE_MAX_BUDGET_USD", 5),

  /**
   * Fail closed. Anything not listed is denied, because a headless run has nobody
   * to answer a permission prompt.
   *
   * The space in "git diff *" is load-bearing: "git diff*" would also match
   * git diff-index. No push, no remote, no commit — slice 1 leaves changes
   * uncommitted in the worktree so the human gate is the review.
   */
  allowedTools: (process.env["AIDE_ALLOWED_TOOLS"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .concat(
      process.env["AIDE_ALLOWED_TOOLS"]
        ? []
        : [
            "Read",
            "Glob",
            "Grep",
            "Edit",
            "Write",
            "Bash(pnpm *)",
            "Bash(npm *)",
            "Bash(node *)",
            "Bash(git status *)",
            "Bash(git diff *)",
            "Bash(git log *)",
          ],
    ),
} as const
