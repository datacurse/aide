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
   * Note what is NOT here any more: `Bash(...)` patterns. Bash is decided by
   * `policy.ts` through `canUseTool` instead — see the comment there for why the
   * most security-relevant decision aide makes should not depend on the SDK's
   * undocumented rule-matching internals.
   *
   * TodoWrite is allowed because models reach for it constantly and it has no
   * side effects; denying it costs a denial and a retry on nearly every turn.
   */
  allowedTools: list("AIDE_ALLOWED_TOOLS", [
    "Read",
    "Glob",
    "Grep",
    "Edit",
    "Write",
    "TodoWrite",
  ]),

  /**
   * Bash commands the agent may run, matched as leading-word prefixes by
   * `policy.ts`. Single commands only — no pipes, no chaining.
   *
   * The git entries are usually auto-allowed by the SDK's own read-only set
   * before they ever reach us; they are listed so the policy reads as complete
   * rather than depending on that.
   */
  allowedBash: list("AIDE_ALLOWED_BASH", [
    "pnpm",
    "npm",
    "git status",
    "git diff",
    "git log",
    "git show",
  ]),

  /**
   * Denied even though a prefix above would allow them. Each one is a way a run
   * ends badly rather than a way it does damage:
   *
   * - `pnpm dev` / `daemon` / `web` start servers and never exit, so the run
   *   burns its entire budget waiting for a prompt that is not coming.
   * - `pnpm probe` spends real money on a model call.
   * - `npx` / `npm exec` fetch and execute arbitrary packages, which makes the
   *   allowlist above decorative.
   */
  deniedBash: list("AIDE_DENIED_BASH", [
    "pnpm dev",
    "pnpm daemon",
    "pnpm web",
    "pnpm probe",
    "npm exec",
    "npx",
  ]),

  /**
   * Environment overrides for a run, merged over `process.env`.
   *
   * `CI` is the important one: pnpm otherwise asks before purging a modules
   * directory and there is nobody to answer, and setting it here means the agent
   * never has to type `CI=true` — which would depend on the SDK stripping an
   * env-var prefix before matching, an internal we should not build on.
   *
   * The colour variables matter more than they look: ANSI escapes land in the
   * event log and then in a browser as garbage, and `CI=true` makes many tools
   * colourize MORE rather than less.
   *
   * `GIT_TERMINAL_PROMPT=0` turns "git wants credentials" from a run that hangs
   * until its budget runs out into an error the agent can read.
   */
  runEnv: {
    CI: "true",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
  } as Record<string, string>,
} as const
