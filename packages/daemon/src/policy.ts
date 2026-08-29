/**
 * Whether a Bash command may run. Pure function, no I/O, no SDK.
 *
 * This used to be expressed as `Bash(pnpm *)` entries in `allowedTools` and
 * decided inside the Agent SDK. That delegated the most security-relevant
 * decision aide makes to matching rules that are undocumented, that differ
 * between prefix and wildcard forms, that strip leading `VAR=value` only for an
 * env-name list we cannot read, and that split compound commands by rules which
 * have changed between releases. None of it is in the SDK's type definitions;
 * all of it is in a shipped binary.
 *
 * Deciding here buys three things. The rule is assertable by `pnpm smoke` with
 * no model calls. The denial reason becomes aide's own sentence, so a blocked
 * agent is told what to do instead of burning a turn guessing. And it is robust
 * in both directions: if the SDK does auto-allow a read-only command, it never
 * reaches us and nothing changes; if it does not, our list covers it.
 *
 * The rule, stated so it can be reasoned about in one line: a command is allowed
 * when it contains no shell metacharacters and its leading words match an
 * allowed prefix and no denied prefix.
 *
 * A null allowlist drops the middle clause and keeps the other two — everything
 * runs except what is denied. That is what a chat carrying out a plan it has
 * already had approved gets; see `canUseTool` in agent.ts for why that decision
 * is made here rather than handed to the SDK.
 *
 * That is deliberately blunter than a shell parser. The cost is honest — the
 * agent occasionally gets refused for a pipe it could have had — and it is the
 * right trade, because the failure mode of a subtly wrong shell parser is a
 * command that runs when it should not.
 */

/**
 * Anything that could turn one command into two, or into something else
 * entirely: chaining, subshells, substitution, redirection, backgrounding.
 * `$(`, backticks and `<(` are the ones that matter most — they let an allowed
 * prefix carry an arbitrary payload.
 */
const SHELL_METACHARACTERS = /[`$|;&<>\n\r]/

/**
 * Commands no chat may run, on either of the paths where nobody is asked — the
 * `Bash(*)` layer Auto gets, and an approved plan being carried out.
 *
 * `deniedBash` in CONFIG already carries the ways a run ends badly: the servers
 * that never exit, the script that spends money, the fetch-and-execute. These
 * two are a different category — they are the ways a run ends the REVIEW. The
 * product is that you read the diff and you commit it, so a run that commits its
 * own work has removed the gate rather than passed it.
 *
 * Here rather than in agent.ts because it now has two consumers, and because
 * `pnpm smoke` can assert it without loading the SDK.
 */
export const HUMAN_ONLY_COMMANDS = ["git commit", "git push"]

export interface BashVerdict {
  allow: boolean
  /** Shown to the agent on denial, so make it actionable. */
  reason: string
}

/** Leading-word prefix match: "pnpm" matches "pnpm test" but not "pnpmx". */
function hasPrefix(command: string, prefix: string): boolean {
  if (command === prefix) return true
  return command.startsWith(`${prefix} `)
}

export function checkBashCommand(
  rawCommand: unknown,
  /** Prefixes that may run, or null for "anything that is not denied". */
  allowed: readonly string[] | null,
  denied: readonly string[],
): BashVerdict {
  if (typeof rawCommand !== "string" || !rawCommand.trim()) {
    return { allow: false, reason: "no command was given" }
  }

  // Collapse HORIZONTAL whitespace only, so `pnpm   dev` cannot dodge a denied
  // prefix. Deliberately not `\s+`: a newline is a command separator, and
  // collapsing it to a space before the check below turned
  // `pnpm ls\nrm -rf /` into an innocent-looking `pnpm ls rm -rf /` that
  // matched the `pnpm` prefix and was allowed. Caught by `pnpm smoke`.
  const command = rawCommand.trim().replace(/[ \t]+/g, " ")

  if (SHELL_METACHARACTERS.test(command)) {
    return {
      allow: false,
      reason:
        "shell operators are not permitted in this run — run one command at a time, " +
        "and use `pnpm --filter <package> <script>` rather than `cd <dir> && pnpm <script>`",
    }
  }

  const hit = denied.find((d) => hasPrefix(command, d))
  if (hit) {
    return {
      allow: false,
      reason:
        `\`${hit}\` is not permitted in this run: it either never exits, or spends money, ` +
        "or runs code this allowlist cannot see",
    }
  }

  if (allowed && !allowed.some((a) => hasPrefix(command, a))) {
    return {
      allow: false,
      reason: `not in this run's allowlist — permitted commands start with: ${allowed.join(", ")}`,
    }
  }

  return { allow: true, reason: "" }
}
