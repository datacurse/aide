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
 * The rule, stated so it can be reasoned about: a command is split into
 * segments on `|`, `;`, `&&` and `||`, and every segment's leading words must
 * match an allowed prefix and no denied prefix. Substitution, subshells and
 * backgrounding are refused outright — they let an allowed prefix carry an
 * arbitrary payload. A file-tool command in a PIPED segment with no file
 * argument is a filter over another command's output and is allowed; the same
 * command aimed at a file is the shell read the file tools replace. Redirects
 * that write into the project tree, `sed -i` and its relatives, and heredocs
 * are refused as shell-authored writes — see `SHELL_WRITE_COMMANDS`.
 *
 * A null allowlist drops the allowlist clause and keeps everything else —
 * every segment runs except what is denied. That is what a chat carrying out a
 * plan it has already had approved gets; see `canUseTool` in agent.ts for why
 * that decision is made here rather than handed to the SDK.
 *
 * This is still blunter than a real shell parser, and deliberately so where it
 * refuses: a segment it cannot read is refused rather than guessed at, because
 * the failure mode of a subtly wrong parser is a command that runs when it
 * should not. Where it ALLOWS it errs the other way, and on purpose: matching
 * file paths inside option values is how you refuse `npm run build` for the
 * word `build` — the over-match upstream shipped and reverted in CLI 2.1.260 —
 * so a piped `tail -50` is read as the pager it is, not as a file access.
 */

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
 * The name `HUMAN_ONLY` is kept, but the committer is the DAEMON now, not a
 * person: aide commits the working tree itself when a turn ends and the
 * project's checks pass. What the rule protects is unchanged — that a commit
 * happens exactly once per turn, at a known point, after the gate — and a run
 * committing mid-turn would put half-finished work into history under nobody's
 * message. The refusal says so, and says there is nothing to do instead,
 * because that is what ends the hunt for a spelling that gets through.
 */
const HUMAN_ONLY_REASON =
  "`git commit` is never run from a turn: aide commits the working tree itself after " +
  "your turn ends, once the project's checks pass. There is no form of this command " +
  "that will be allowed and nothing you need to do instead — finish the work, say what " +
  "you changed, and stop. (`git push` is allowed: it only ever moves commits that have " +
  "already landed through that gate.)"

/**
 * Reading a file, or searching for one, through a shell.
 *
 * Advice against this has been in the system prompt for some time, with a
 * measurement in it, and the runs did it anyway. Across the eight most recently
 * archived conversations, 782 Bash calls CONTAINED a file-reading command
 * somewhere in the string — 592 with `grep`/`awk`/`find` and 190 with
 * `cat`/`sed -n`/`head`/`tail`, counted anywhere in the command, pipes and
 * chains included. Counted by leading word alone — the way this list matches —
 * it is 345. Both numbers are the same story at different granularity: 69
 * minutes of wall clock for work `Grep` and `Read` do in about a millisecond,
 * against 31 calls to `Grep` in the same eight. Quote whichever definition you
 * are re-deriving, because the two look like a contradiction when neither is
 * stated. A sentence the model is free to skip is not a rule, so this is the
 * rule. (The cause of the skipping is upstream: the CLI's undocumented
 * `thrifty_sonic` experiment injects the opposite advice — see the runEnv
 * comment in config.ts.)
 *
 * Refused rather than rewritten. The obvious alternative — quietly turn the
 * command into the tool call it should have been — has to guess at flags,
 * globs, `-n` ranges and quoting, and a guess that is subtly wrong returns the
 * WRONG FILE CONTENTS to an agent that has no way to know. A refusal that names
 * the tool costs one round trip and cannot lie.
 *
 * Matched on the leading words of each SEGMENT of the command, with one
 * exception: a segment fed by a pipe whose command has no file argument is
 * paging or filtering another command's output — `git log | head`,
 * `pnpm test 2>&1 | tail -50` — which is legitimate and allowed. The same
 * command aimed at a file, anywhere in the chain, is the read this rule exists
 * to refuse.
 *
 * `ls` is deliberately absent. Listing a directory is what `ls` is for, `Glob`
 * answers a different question (paths matching a pattern, recursively), and
 * refusing `ls` would send the agent to `Glob("*")` — a worse answer to a
 * question it asked correctly.
 */
export const FILE_TOOL_COMMANDS: ReadonlyArray<{ prefix: string; use: string }> = [
  { prefix: "cat", use: "Read" },
  { prefix: "tac", use: "Read" },
  { prefix: "head", use: "Read" },
  { prefix: "tail", use: "Read" },
  { prefix: "nl", use: "Read" },
  { prefix: "bat", use: "Read" },
  { prefix: "batcat", use: "Read" },
  { prefix: "less", use: "Read" },
  { prefix: "more", use: "Read" },
  { prefix: "sed", use: "Read (with offset/limit) or Edit" },
  { prefix: "awk", use: "Grep" },
  { prefix: "grep", use: "Grep" },
  { prefix: "egrep", use: "Grep" },
  { prefix: "fgrep", use: "Grep" },
  { prefix: "rg", use: "Grep" },
  { prefix: "find", use: "Glob" },
]

/**
 * Writing a file through a shell — the second refusal class, and the one that
 * loses work rather than time.
 *
 * A `sed -i`, a `>` redirect or a heredoc edits the tree with no Edit row in
 * the transcript: the review sees an opaque command where it needs the change,
 * and the SDK's own checkpointing (/rewind) tracks only Edit and Write, so the
 * one kind of edit it cannot undo is the one made this way. Upstream has a
 * documented data loss to show for it.
 *
 * This list carries the PREFIX-shaped half, which is what the settings layer
 * can express — `fastBashSettings` denies these on Auto, where `Bash(*)`
 * resolves before `checkBashCommand` is ever reached, and the parity test in
 * smoke-policy holds the two lists together. The rest of the class — redirect
 * targets, heredocs, `python -c` that opens a file for writing — is
 * content-shaped and lives in `checkBashCommand` alone, which means on Auto it
 * is advice in the system prompt rather than a gate. Stated here so nobody
 * mistakes the coverage.
 *
 * `sed` is not listed because the read rule above already denies it whole.
 */
export const SHELL_WRITE_COMMANDS: ReadonlyArray<{ prefix: string }> = [
  { prefix: "tee" },
  { prefix: "perl -i" },
]

/**
 * Why a shell write is refused. Names the tools and the reason, because the
 * reason is not speed this time: a refusal that read like the file-tool one
 * would invite "but this edit is faster in sed", and the answer to that is that
 * speed was never the point.
 */
const shellWriteReason = (what: string) =>
  `use Edit or Write instead of ${what}: an edit made through the shell bypasses ` +
  "checkpointing and produces no diff for review — the transcript shows an opaque " +
  "command where the review needs the change itself."

/**
 * Why a shell read is refused, naming the tool that does the same job.
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

// ---------------------------------------------------------------------------
// A small, quote-aware reading of one command line.
//
// Not a shell parser — a shell parser has arithmetic expansion, brace ranges
// and locale-dependent word splitting, and a subtly wrong one is worse than a
// blunt one. This reads exactly the shapes the checks below need: segments
// between `|`/`;`/`&&`/`||`, words with their quoting remembered, and
// redirects with their targets. Anything it cannot read confidently — command
// substitution, process substitution, subshells, backgrounding — is refused
// before it gets here, so "cannot read" never becomes "ran anyway".
// ---------------------------------------------------------------------------

interface Word {
  text: string
  /** Any part of it was quoted. A quoted token is a script or a message, not a filename to police. */
  quoted: boolean
}

interface Redirect {
  kind: "write" | "read"
  target: Word | null
}

interface Segment {
  /** The segment's text, verbatim — what regex-shaped checks scan. */
  raw: string
  /** Fed by `|` from the segment before it. `&&`/`;`/`||` do not feed stdin. */
  piped: boolean
  words: Word[]
  redirects: Redirect[]
  /** A heredoc (`<<`) opens in this segment. */
  heredoc: boolean
}

const OPERATOR_REASON =
  "command substitution, subshells and backgrounding are not permitted in this run — " +
  "run the command directly, one step at a time"

/** The leading word inside a `$(...)` or backtick body, for naming the right refusal. */
function substitutionLead(command: string, from: number): string {
  const body = command.slice(from)
  return body.trim().split(/[\s)`]/, 1)[0] ?? ""
}

/**
 * Split on unquoted `|`, `;`, `&&`, `||`. Returns a refusal instead when the
 * command carries a construct the checks below cannot see through: `$(...)`,
 * backticks, `<(...)`, `(...)` subshells, or a stray `&`. A substitution whose
 * body starts with a file-tool command gets that refusal rather than the
 * generic one — `echo $(cat secrets)` is a shell read wearing an echo.
 */
function splitSegments(command: string): Segment[] | { reason: string } {
  const segments: Array<{ raw: string; piped: boolean }> = []
  let cur = ""
  let piped = false
  const push = (nextPiped: boolean) => {
    if (cur.trim()) segments.push({ raw: cur.trim(), piped })
    cur = ""
    piped = nextPiped
  }

  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    const next = command[i + 1]
    if (c === "\\") {
      cur += c + (next ?? "")
      i += 1
      continue
    }
    if (c === "'" || c === '"') {
      const close = findClose(command, i)
      if (close === -1) return { reason: "unterminated quote — check the command and resend it" }
      // A double-quoted span still substitutes in a real shell, so `$(` and
      // backticks inside one are the same payload carrier they are outside it.
      // Single quotes are literal and safe.
      if (c === '"' && /\$\(|`/.test(command.slice(i + 1, close))) {
        return { reason: OPERATOR_REASON }
      }
      cur += command.slice(i, close + 1)
      i = close
      continue
    }
    if (c === "`") {
      const lead = substitutionLead(command, i + 1)
      const ft = FILE_TOOL_COMMANDS.find((f) => f.prefix === lead)
      return { reason: ft ? fileToolReason(ft.prefix, ft.use) : OPERATOR_REASON }
    }
    if (c === "$" && next === "(") {
      const lead = substitutionLead(command, i + 2)
      const ft = FILE_TOOL_COMMANDS.find((f) => f.prefix === lead)
      return { reason: ft ? fileToolReason(ft.prefix, ft.use) : OPERATOR_REASON }
    }
    if (c === "<" && next === "(") return { reason: OPERATOR_REASON }
    if (c === "(" || c === ")") return { reason: OPERATOR_REASON }
    if (c === "|") {
      if (next === "|") {
        push(false)
        i += 1
      } else {
        push(true)
      }
      continue
    }
    if (c === ";") {
      push(false)
      continue
    }
    if (c === "&") {
      if (next === "&") {
        push(false)
        i += 1
        continue
      }
      // `2>&1`, `>&2`, `<&0`, `&>log` are redirect plumbing, not backgrounding.
      const prev = command[i - 1]
      if (prev === ">" || prev === "<" || next === ">") {
        cur += c
        continue
      }
      return { reason: OPERATOR_REASON }
    }
    cur += c
  }
  push(false)
  return segments.map((s) => lexSegment(s.raw, s.piped))
}

/** Index of the closing quote for the one opening at `i`, or -1. */
function findClose(text: string, i: number): number {
  const q = text[i]!
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === "\\" && q === '"') {
      j += 1
      continue
    }
    if (text[j] === q) return j
  }
  return -1
}

/** One segment into words and redirects. See the block comment above. */
function lexSegment(raw: string, piped: boolean): Segment {
  const words: Word[] = []
  const redirects: Redirect[] = []
  let heredoc = false
  let buf = ""
  let quoted = false
  let pending: Redirect | null = null

  const flush = () => {
    if (!buf && !quoted) return
    const word: Word = { text: buf, quoted }
    if (pending) {
      pending.target = word
      pending = null
    } else {
      words.push(word)
    }
    buf = ""
    quoted = false
  }

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!
    if (c === "\\") {
      buf += raw[i + 1] ?? ""
      i += 1
      continue
    }
    if (c === "'" || c === '"') {
      const close = findClose(raw, i)
      // Unterminated quotes were refused by the splitter; this is unreachable
      // but must not loop.
      if (close === -1) {
        buf += raw.slice(i + 1)
        quoted = true
        break
      }
      buf += raw.slice(i + 1, close)
      quoted = true
      i = close
      continue
    }
    if (c === " ") {
      flush()
      continue
    }
    if (c === "<" || c === ">" || (c === "&" && raw[i + 1] === ">")) {
      // A pure-digit word glued to the operator is its fd — `2>&1` — not a word.
      const fd = /^\d+$/.test(buf) && !quoted ? buf : ""
      if (!fd) flush()
      buf = ""
      quoted = false
      let op = c
      let j = i + 1
      while (j < raw.length && (raw[j] === ">" || raw[j] === "<" || raw[j] === "&")) {
        op += raw[j]!
        j += 1
      }
      // Trailing digits after `>&` belong to the operator: `2>&1`.
      let dup = ""
      if (op.endsWith("&") || op.includes("&")) {
        while (j < raw.length && /\d/.test(raw[j]!)) {
          dup += raw[j]!
          j += 1
        }
      }
      i = j - 1
      const whole = fd + op + dup
      if (/^\d*>{1,2}&\d+$/.test(whole) || /^\d*<&\d*-?$/.test(whole)) continue // fd duplication
      if (op.startsWith("<<")) {
        // `<<` heredoc and `<<<` herestring both feed stdin from the command
        // line; the heredoc is the file-writing idiom and gets the write
        // refusal downstream. Either way no target word follows to consume.
        heredoc = true
        continue
      }
      pending = { kind: op.includes(">") ? "write" : "read", target: null }
      redirects.push(pending)
      continue
    }
    buf += c
  }
  flush()

  // Leading VAR=value assignments are not the command. Stripping them is what
  // stops `CI=1 git commit` reading as a command named `CI=1` that no deny
  // prefix matches — the same walk the CLI's own parser does.
  while (words.length && !words[0]!.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!.text)) {
    words.shift()
  }

  return { raw, piped, words, redirects, heredoc }
}

/**
 * Whether a redirect target is a place a run may write without review.
 *
 * Conservative in the direction 2.1.260's revert teaches: only a target that is
 * legibly INSIDE the project tree is refused. Scratch space (`/dev/null`,
 * `/tmp`, `%TEMP%` and its spellings), anything above the tree (`../`), and —
 * when no cwd is known — any absolute path, are allowed. An absolute path is
 * checked against `cwd` when the caller supplies one, which the daemon always
 * does.
 */
function allowedWriteTarget(target: Word | null, cwd: string | undefined): boolean {
  if (!target) return false
  const t = target.text
  if (!t) return false
  const lower = t.toLowerCase().replace(/\\/g, "/")
  if (lower === "/dev/null" || lower === "nul") return true
  if (lower === "/tmp" || lower.startsWith("/tmp/")) return true
  if (/^%te?mp%/.test(lower)) return true
  if (/^\$\{?(tmpdir|temp|tmp)\}?(\/|$)/.test(lower)) return true
  if (t === ".." || lower.startsWith("../")) return true
  const absolute = lower.startsWith("/") || /^[a-z]:\//.test(lower) || lower.startsWith("~")
  if (absolute) {
    if (!cwd) return true
    const root = cwd.toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "")
    return !(lower === root || lower.startsWith(`${root}/`))
  }
  // A bare relative path resolves inside the checkout, which is the tree under
  // review. This is the case the rule exists for.
  return false
}

/**
 * A file argument, as distinct from a flag or a quoted script.
 *
 * Only consulted for a PIPED segment, where the command may be a legitimate
 * filter. Flags are skipped, and so are quoted tokens — `sed 's/a/b/'` in a
 * pipe is a stream edit of output, not a file access — and what is left counts
 * as a file when it looks like a path: a separator or an extension dot.
 * `tail -n 50` has neither, which is exactly the option-value shape that must
 * NOT be read as a filename.
 */
function hasFileArgument(words: Word[]): boolean {
  return words
    .slice(1)
    .some((w) => !w.quoted && !w.text.startsWith("-") && /[\\/.]/.test(w.text))
}

/**
 * `open(..., 'w')` / `writeFileSync` inside a `-c`/`-e` one-liner.
 *
 * The mode string is matched AFTER a comma, not anywhere in the call —
 * `open('x.ts').read()` must not trip on the `x` of its own filename. A
 * keyword-argument spelling (`mode="w"`) slips this; the named shapes are the
 * ones upstream's data loss came in, and guessing wider is how over-matching
 * starts.
 */
const INLINE_WRITE_CODE =
  /open\s*\([^)]*,\s*["'](?:[wax]|r\+)|writeFileSync|appendFileSync|createWriteStream/

interface Refusal {
  /** Lower wins. Deny list < shell write < shell read < cd chain < allowlist. */
  priority: number
  reason: string
}

export function checkBashCommand(
  rawCommand: unknown,
  /** Prefixes that may run, or null for "anything that is not denied". */
  allowed: readonly string[] | null,
  denied: readonly string[],
  /**
   * The run's project root, for judging redirect targets. Optional so callers
   * without one (and older call sites) still get every path-free check.
   */
  cwd?: string,
): BashVerdict {
  if (typeof rawCommand !== "string" || !rawCommand.trim()) {
    return { allow: false, reason: "no command was given" }
  }

  // A newline is a command separator that reads as whitespace, so it is refused
  // rather than split on: `pnpm ls\nrm -rf /` must not become two clean
  // segments of which the reader shows one. Horizontal whitespace is collapsed
  // for the same reason in the other direction — `pnpm   dev` cannot dodge a
  // denied prefix. This string is only ANALYZED; what runs is the original.
  if (/[\n\r]/.test(rawCommand)) {
    return {
      allow: false,
      reason: "a newline separates commands — send one command per call",
    }
  }
  const command = rawCommand.trim().replace(/[ \t]+/g, " ")

  const split = splitSegments(command)
  if (!Array.isArray(split)) return { allow: false, reason: split.reason }
  const segments = split.filter((s) => s.words.length > 0 || s.redirects.length > 0 || s.heredoc)
  if (segments.length === 0) return { allow: false, reason: "no command was given" }

  const refusals: Refusal[] = []

  for (const seg of segments) {
    const segText = seg.words.map((w) => w.text).join(" ")
    const lead = seg.words[0]?.text ?? ""

    // The deny list first, in every segment. A command that is denied outright
    // must keep saying so — `git commit` at the end of a chain is still the
    // review being ended — and which of the two categories decides the
    // sentence, because they are refused for opposite reasons. Checked against
    // the constant rather than a flag on the caller, so a caller that
    // concatenates the two lists — both of them do — cannot lose the
    // distinction.
    const hit = denied.find((d) => hasPrefix(segText, d))
    if (hit) {
      refusals.push({
        priority: 1,
        reason: HUMAN_ONLY_COMMANDS.includes(hit)
          ? HUMAN_ONLY_REASON
          : `\`${hit}\` is not permitted in this run: it either never exits, or spends money, ` +
            "or runs code this allowlist cannot see",
      })
      continue
    }

    // Shell-authored writes. `-i` is checked before the read rule below so
    // `sed -i` gets the write sentence — the read one names the wrong problem.
    if (
      (lead === "sed" || lead === "perl") &&
      seg.words.some((w) => !w.quoted && /^(-i|--in-place)/.test(w.text))
    ) {
      refusals.push({ priority: 2, reason: shellWriteReason(`\`${lead} -i\``) })
      continue
    }
    if (lead === "tee") {
      const targets = seg.words.slice(1).filter((w) => !w.text.startsWith("-"))
      if (targets.some((t) => !allowedWriteTarget(t, cwd))) {
        refusals.push({ priority: 2, reason: shellWriteReason("`tee` into the project tree") })
        continue
      }
    }
    if (
      /^(python\d?(\.\d+)?|py|node)$/.test(lead) &&
      seg.words.some((w) => !w.quoted && /^(-c|-e|-p|--eval)$/.test(w.text)) &&
      INLINE_WRITE_CODE.test(seg.raw)
    ) {
      refusals.push({ priority: 2, reason: shellWriteReason(`a \`${lead} -c\` one-liner that writes a file`) })
      continue
    }
    if (seg.heredoc) {
      refusals.push({ priority: 2, reason: shellWriteReason("a heredoc") })
      continue
    }
    const badWrite = seg.redirects.find(
      (r) => r.kind === "write" && !allowedWriteTarget(r.target, cwd),
    )
    if (badWrite) {
      refusals.push({
        priority: 2,
        reason: shellWriteReason(
          `a \`> ${badWrite.target?.text ?? ""}\` redirect into the project tree`,
        ),
      })
      continue
    }

    // `< file` is a shell read of a file whatever the command in front of it.
    const readRedirect = seg.redirects.find((r) => r.kind === "read")
    if (readRedirect) {
      refusals.push({
        priority: 3,
        reason: fileToolReason(`< ${readRedirect.target?.text ?? "file"}`, "Read"),
      })
      continue
    }

    // The read rule. A piped segment with no file argument is a filter over the
    // previous command's output — `git log | head` — which is the shell being
    // used for what only a shell does, so it is allowed and exempt from the
    // allowlist below (nobody lists `head` as a command a run may start).
    const ft = FILE_TOOL_COMMANDS.find((f) => hasPrefix(segText, f.prefix))
    if (ft) {
      if (seg.piped && !hasFileArgument(seg.words)) continue
      refusals.push({ priority: 3, reason: fileToolReason(ft.prefix, ft.use) })
      continue
    }

    // `cd` at the head of a chain is the one compound this project steers away
    // from by name, so the refusal keeps naming the way that works.
    if (lead === "cd" && segments.length > 1) {
      refusals.push({
        priority: 4,
        reason:
          "no need to `cd` and chain — use `pnpm --filter <package> <script>`, or give " +
          "the command an absolute path; each Bash call starts in the project root",
      })
      continue
    }

    if (allowed && !allowed.some((a) => hasPrefix(segText, a))) {
      refusals.push({
        priority: 5,
        reason: `not in this run's allowlist — permitted commands start with: ${allowed.join(", ")}`,
      })
    }
  }

  if (refusals.length) {
    refusals.sort((a, b) => a.priority - b.priority)
    return { allow: false, reason: refusals[0]!.reason }
  }
  return { allow: true, reason: "" }
}

/**
 * How many denials of the same command it takes to call it a retry loop.
 *
 * Three is the observed shape of an agent hunting for a spelling that gets
 * through — the `git commit` story above was four denials — so the fourth
 * same-prefix denial in one turn is the signal, and it fires once rather than
 * per denial so the log carries one warning instead of a stutter.
 */
export const RETRY_LOOP_DENIALS = 3

/**
 * Denied Bash calls in one turn, counted where the denials happen.
 *
 * What this is FOR is the retry loop, not the total. `record` answering true
 * means the same prefix has been denied more than `RETRY_LOOP_DENIALS` times —
 * the refusal text is not landing and the turn is spending itself rephrasing.
 *
 * The total used to ride on `run.finished.bashDenials` as well, on the argument
 * that the SDK's own `permission_denials` has no reason field and so cannot say
 * whether refusals landed. Nothing ever read that field, so it is gone; the
 * tally is still reset per turn, or the second turn's first refusal would look
 * like a repeat of the first turn's.
 */
export class DenialTally {
  #byPrefix = new Map<string, number>()
  #total = 0

  get total(): number {
    return this.#total
  }

  /** Count one denial. True exactly once, when its prefix crosses the loop line. */
  record(command: unknown): boolean {
    this.#total += 1
    const word =
      typeof command === "string" ? (command.trim().split(/\s+/, 1)[0] ?? "") : "(not a string)"
    const n = (this.#byPrefix.get(word) ?? 0) + 1
    this.#byPrefix.set(word, n)
    return n === RETRY_LOOP_DENIALS + 1
  }

  /** A new turn starts from zero — a chat's tally must not accumulate across turns. */
  reset(): void {
    this.#byPrefix.clear()
    this.#total = 0
  }
}
