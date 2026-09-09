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
   * Started by a dev server, and therefore restarted by one without being asked.
   *
   * Read here rather than at each use because two places now need it — `/health`
   * answers it, and a turn that leaves this process running older code has to
   * say whether anything will pick that up — and two copies of an env-var
   * comparison is exactly how they end up disagreeing about a restart.
   */
  supervised: process.env["AIDE_MANAGED"] === "1",

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
   * There is no concurrency setting, and that is the design rather than an
   * omission. One agent has a project's checkout at a time, because they all
   * work the SAME checkout — see the lock in `chat.ts`. Parallelism is several
   * projects, not several agents in one.
   */

  /**
   * Per chat turn. Zero means no cap, which is the default.
   *
   * A chat has a human at the keyboard and a stop button, so the reason the task
   * cap exists simply is not present — and a cap that cuts off an answer
   * mid-sentence costs you the whole turn's spend anyway, buying nothing. Long
   * conversations resend a large context every turn and are legitimately
   * expensive; the outcome line reports what each one cost.
   *
   * Read this as per CONVERSATION rather than per turn if you set it. The cap is
   * a `query()` option and a conversation now holds one query open across its
   * turns, so the SDK measures it against the session's running total — and a
   * cold start (first message, after an idle eviction, after a restart) begins a
   * fresh query and a fresh allowance.
   */
  chatMaxBudgetUsd: num("AIDE_CHAT_MAX_BUDGET_USD", 0),

  /**
   * How long a conversation's session is kept open with nobody talking to it.
   *
   * A warm session is a CLI subprocess and a context window held in memory, and
   * that is only worth paying for while a follow-up is plausibly coming. Past
   * this the session is closed, and the next message cold-starts with `resume` —
   * which costs the ~1.4s the warm path saves and nothing else.
   */
  chatIdleMs: num("AIDE_CHAT_IDLE_MS", 10 * 60_000),

  /**
   * How long open work can sit untouched before the list flags it stale.
   *
   * A flag rather than a state: a conversation that has been waiting three weeks
   * is still waiting FOR YOU, and promoting staleness to a status of its own
   * would throw away the only useful thing about it.
   */
  chatStaleMs: num("AIDE_CHAT_STALE_MS", 3 * 24 * 60 * 60_000),

  /**
   * How long an evicted worker gets to exit on its own before it is killed.
   *
   * Closing is cooperative — the input stream ends and the SDK winds the session
   * down — so this is only the backstop for a worker that does not come back,
   * which must not be able to leak a process for the life of the daemon.
   */
  chatCloseGraceMs: num("AIDE_CHAT_CLOSE_GRACE_MS", 10_000),

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
   * Tools a CHAT auto-approves. Everything else falls through to `canUseTool`
   * and becomes a prompt.
   *
   * This list is short for a load-bearing reason the SDK warns about out loud:
   * a bare name in `allowedTools` approves the whole tool BEFORE the mode or the
   * callback is consulted. Leaving Edit and Write here made a promise into a lie
   * — Plan says Claude will describe the work before doing any of it, and the
   * edit would have been approved before either could refuse it. Only read-only
   * tools belong here.
   *
   * Bash does not belong here either, however slow leaving it out looks. The
   * reason is that this list is not per-mode: adding Bash would hand Plan an
   * unannounced shell as well. Auto's shell is granted in `fastBashSettings`
   * (agent.ts) instead, which is scoped to Auto alone.
   */
  chatAutoAllowTools: list("AIDE_CHAT_AUTO_ALLOW", ["Read", "Glob", "Grep", "TodoWrite"]),

  /**
   * Bash commands the agent may run, matched as leading-word prefixes by
   * `policy.ts`. Single commands only — no pipes, no chaining.
   *
   * The read-only git entries are usually auto-allowed by the SDK's own set
   * before they ever reach us; they are listed so the policy reads as complete
   * rather than depending on that.
   *
   * `git push` is the one that writes, and it is here on purpose. Nothing is
   * pushable until it has been committed, and committing is the human pressing
   * the button — so a run that can push is only ever moving commits somebody has
   * already read and approved. Leaving it out did not protect a review; it
   * stranded approved work on the machine that made it, which is what happened
   * to a remote project on `tg`. See `HUMAN_ONLY_COMMANDS`, which still holds
   * `git commit`, because that IS the gate.
   */
  allowedBash: list("AIDE_ALLOWED_BASH", [
    "pnpm",
    "npm",
    "git status",
    "git diff",
    "git log",
    "git show",
    "git push",
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
   *
   * `CLAUDE_CODE_THRIFTY_SONIC=0` opts every run out of the CLI's undocumented
   * `thrifty_sonic` experiment (in the binary since v2.1.221), which injects
   * "do your work through the Bash tool" advice into auto-mode turns — the exact
   * opposite of the file-tool rule `policy.ts` enforces, and the measured cause
   * of runs reaching for `cat` and `grep` against their own system prompt. The
   * variable is undocumented and could stop working in any release, so it is a
   * cost saving, not the enforcement: the deny list in `fastBashSettings` and
   * `checkBashCommand` stays the real rule. `pnpm smoke` pins the literal "0"
   * so an edit here cannot silently re-enrol every run.
   */
  runEnv: {
    CI: "true",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    CLAUDE_CODE_THRIFTY_SONIC: "0",
  } as Record<string, string>,
} as const
