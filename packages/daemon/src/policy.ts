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

/**
 * Reading a file, or searching for one, through a shell.
 *
 * Advice against this has been in the system prompt for some time, with a
 * measurement in it, and the runs did it anyway: across the eight most recently
 * archived conversations, 592 Bash calls ran `grep`/`awk`/`find` and 190 ran
 * `cat`/`sed -n`/`head`/`tail` over source files — 69 minutes of wall clock for
 * work `Grep` and `Read` do in about a millisecond. `Grep` was called 31 times
 * in the same eight. A sentence the model is free to skip is not a rule, so this
 * is the rule.
 *
 * Refused rather than rewritten. The obvious alternative — quietly turn the
 * command into the tool call it should have been — has to guess at flags,
 * globs, `-n` ranges and quoting, and a guess that is subtly wrong returns the
 * WRONG FILE CONTENTS to an agent that has no way to know. A refusal that names
 * the tool costs one round trip and cannot lie.
 *
 * Anchored at the start of the command, and only at the start. `git log | head`
 * is a shell pipeline that `SHELL_METACHARACTERS` already refuses on the path
 * with an allowlist; on the null-allowlist path a pipe is permitted and the
 * `head` there is paging a git call, not reading a file, so matching anywhere in
 * the string would refuse the very thing it is fine to do.
 *
 * `ls` is deliberately absent. Listing a directory is what `ls` is for, `Glob`
 * answers a different question (paths matching a pattern, recursively), and
 * refusing `ls` would send the agent to `Glob("*")` — a worse answer to a
 * question it asked correctly.
 */
export const FILE_TOOL_COMMANDS: ReadonlyArray<{ prefix: string; use: string }> = [
  { prefix: "cat", use: "Read" },
  { prefix: "head", use: "Read" },
  { prefix: "tail", use: "Read" },
  { prefix: "sed", use: "Read (with offset/limit) or Edit" },
  { prefix: "awk", use: "Grep" },
  { prefix: "grep", use: "Grep" },
  { prefix: "rg", use: "Grep" },
  { prefix: "find", use: "Glob" },
]

/**
 * Why one of those is refused, naming the tool that does the same job.
 *
 * Every refusal in this file names the way forward, for the reason
 * `HUMAN_ONLY_REASON` records: an agent that is told only "no" goes looking for
 * a spelling that gets through. Here the way forward is genuinely better than
 * what was asked for, so the sentence leads with it and gives the measurement,
 * which is the part that makes it read as a cost rather than a preference.
 */
const fileToolReason = (prefix: string, use: string) =>
  `use ${use} instead of \`${prefix}\`: a Bash call costs several seconds on this machine ` +
  "where the file tools return in about a millisecond, and this run is measured. " +
  "Keep Bash for what needs a shell — git, the package manager, running something."

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

  // After the deny list, before the allowlist. A command that is denied outright
  // must keep saying so — `grep` reaching this on a run that also denied it would
  // otherwise be told to use a tool while the real answer is no — and a run whose
  // allowlist does not mention `cat` at all should hear the useful sentence
  // rather than the generic one, because the useful sentence is also true.
  const shellRead = FILE_TOOL_COMMANDS.find((f) => hasPrefix(command, f.prefix))
  if (shellRead) {
    return { allow: false, reason: fileToolReason(shellRead.prefix, shellRead.use) }
  }

  if (allowed && !allowed.some((a) => hasPrefix(command, a))) {
    return {
      allow: false,
      reason: `not in this run's allowlist — permitted commands start with: ${allowed.join(", ")}`,
    }
  }

  return { allow: true, reason: "" }
}
