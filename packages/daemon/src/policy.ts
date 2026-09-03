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
 * that never exit, the script that spends money, the fetch-and-execute. This one
 * is a different category — it is the way a run ends the REVIEW. The product is
 * that you read the diff and you commit it, so a run that commits its own work
 * has removed the gate rather than passed it.
 *
 * `git push` is NOT here, and the distinction is worth stating because it was
 * wrong for a while. Push is DOWNSTREAM of the gate: nothing is pushable until
 * it is committed, and committing is the human pressing the button — so by the
 * time a run can push, a person has already read that diff and approved it.
 * Blocking push therefore protects no review that has not already happened. What
 * it does instead is strand approved work on the machine that made it, which is
 * exactly what it did: a remote project on `tg` had its commit reviewed and
 * taken, and then could not get it to the remote, so the deploy ran from a local
 * checkout that no longer matched origin. A gate placed after the decision it is
 * supposed to guard is not a gate, it is a dead end.
 *
 * Here rather than in agent.ts because it now has two consumers, and because
 * `pnpm smoke` can assert it without loading the SDK.
 */
export const HUMAN_ONLY_COMMANDS = ["git commit"]

/**
 * Why one of those is refused, in aide's own words.
 *
 * Separate from the `deniedBash` sentence because the two categories are
 * separate, and sharing a message made the refusal actively misleading: an agent
 * that ran a human-only command was told it "either never exits, or spends
 * money, or runs code this allowlist cannot see", none of which is true of it.
 * Watched on a remote project — the agent read that as a runaway-command guard
 * rather than a rule about the review, and went looking for a form that would
 * get through: a heredoc, then a message file, then a different invocation, four
 * denials before it gave up. A refusal that names the real reason ends that at
 * one, and a refusal an agent cannot act on is how a gate turns into a loop.
 *
 * It names what to do instead, because there IS something: leave the work
 * uncommitted, say so, and let the human press the button. That is not a
 * consolation prize — it is the product.
 */
const HUMAN_ONLY_REASON =
  "`git commit` is the human's, not a run's: you leave the work uncommitted and a " +
  "person reads the diff and presses commit in aide. That review is the whole product, " +
  "so there is no form of this command that will be allowed — say what you changed and " +
  "stop, rather than looking for one. (`git push` is allowed: it only ever moves commits " +
  "a human already approved.)"

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
    // Which of the two categories, because they are refused for opposite
    // reasons and an agent acts on the sentence it is given. Checked against the
    // constant rather than a flag on the caller, so a caller that concatenates
    // the two lists — both of them do — cannot lose the distinction.
    return {
      allow: false,
      reason: HUMAN_ONLY_COMMANDS.includes(hit)
        ? HUMAN_ONLY_REASON
        : `\`${hit}\` is not permitted in this run: it either never exits, or spends money, ` +
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
