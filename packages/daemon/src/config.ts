const num = (name: string, fallback: number): number => {
  const raw = process.env[name]
  const parsed = raw === undefined ? Number.NaN : Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

export const CONFIG = {
  port: num("AIDE_PORT", 4317),

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
