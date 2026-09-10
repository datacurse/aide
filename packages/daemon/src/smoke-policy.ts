/**
 * What a run's shell may do, what a mode may do, and what must never block:
 * the half of `pnpm smoke` that needs no repository.
 *
 * Split out of `smoke.ts` because it is the part that genuinely can be. The rest
 * of that file drives one throwaway repository through a sequence where each
 * section is set up by the ones above it; nothing here touches a repository at
 * all, so it was 250 lines a reader had to scroll past to reach either
 * neighbour.
 *
 * Imported by `smoke.ts` for its side effects — the assertions run at module
 * load — and it shares that file's counter through `smoke-check.ts`, so there is
 * still one tally and one exit code. See there for why.
 *
 * Every check in here is a rule from the brief that was once reachable in code:
 * a command that spends money in a loop, a tool that turns a headless turn into
 * a permission prompt with nobody to answer it, a `node:` import that reaches the
 * browser bundle and leaves a blank white page.
 */
import { existsSync } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  CHAT_MODELS,
  SUMMARY_FENCE,
  bridgedChats,
  buildTimeline,
  chatModeFromSdk,
  chatModelLabel,
  classifyFailure,
  collapseUnchanged,
  diffLines,
  pairWords,
  splitRows,
  currentActivity,
  isChatModel,
  isImageAttachment,
  isRefusal,
  foldRows,
  partialToolTarget,
  timelineMeta,
  toolTarget,
  formatLocation,
  parseLocation,
  parseTurnSummary,
  PerProjectMemo,
  placeHint,
  planChecks,
  projectGates,
  restartDecision,
  stripPartialTurnSummary,
  stripTurnSummary,
  type Health,
  type RunEvent,
  type RunEventBody,
  type TimelineCall,
} from "@aide/protocol"
import { parseProjectDoc } from "@aide/protocol/node"
import { attachedFilesNote, fileAttachmentNames } from "./attachment-files.js"
import { HUMAN_ONLY_COMMANDS, checkBashCommand } from "./policy.js"
import { staleVerdict } from "./source.js"
import { check } from "./smoke-check.js"

console.log("\nbash policy")
{
  const allow = ["pnpm", "npm", "git status", "git diff", "git push"]
  const deny = ["pnpm dev", "pnpm probe", "npx"]
  const verdict = (cmd: unknown) => checkBashCommand(cmd, allow, deny)

  check("allows pnpm typecheck", verdict("pnpm typecheck").allow)
  check("allows a bare allowed word", verdict("pnpm").allow)
  check("allows git diff with args", verdict("git diff --stat").allow)
  // The one write in the list, and the reason it is safe is not that it is
  // harmless — it is that it can only move commits a human already approved.
  check("allows git push on an allowlist that names it", verdict("git push origin main").allow)
  check("but not a git subcommand nobody listed", !verdict("git reset --hard").allow)
  check("denies an unlisted command", !verdict("curl https://example.com").allow)
  check("denies a near-miss prefix", !verdict("pnpmx run").allow, "prefix must end at a word")
  check("denies pnpm dev", !verdict("pnpm dev").allow, "it never exits")
  check("denies pnpm  dev with padding", !verdict("pnpm   dev").allow, "whitespace is collapsed")
  check("denies pnpm probe", !verdict("pnpm probe").allow, "it spends money")
  check("denies npx", !verdict("npx cowsay").allow)
  // Compounds are judged segment by segment now — the dedicated section below
  // covers the shapes — so a pipe into a pager and a redirect into scratch
  // space pass, while every segment still has to clear the same lists.
  check(
    "allows a pipe into a pager",
    verdict("pnpm ls | head").allow,
    "head is filtering pnpm's output there, not reading a file",
  )
  check("denies chaining through cd", !verdict("cd packages && pnpm test").allow)
  check("denies substitution", !verdict("pnpm $(echo dev)").allow, "the payload hides in the arg")
  check("denies backticks", !verdict("pnpm `echo dev`").allow)
  check(
    "allows a redirect into scratch space",
    verdict("pnpm ls > /tmp/x").allow,
    "/tmp is outside the tree under review",
  )
  check(
    "denies a redirect into the tree",
    !verdict("pnpm ls > out.txt").allow,
    "a relative target lands in the checkout",
  )
  check("denies a newline", !verdict("pnpm ls\nrm -rf /").allow)
  check("denies a non-string", !verdict(undefined).allow)
  check("denial says what to do instead", verdict("cd x && pnpm t").reason.includes("--filter"))
}

console.log("\nreading files through a shell")
{
  // Advice against this sat in the system prompt, with a measurement attached,
  // and the runs did it anyway: 592 Bash calls running grep/awk/find and 190
  // running cat/sed/head/tail across the eight most recently archived
  // conversations — 69 minutes for work the file tools do in a millisecond,
  // against 31 total calls to Grep in the same eight. That is the evidence that
  // a sentence the model may skip is not a rule.
  const allow = ["pnpm", "git status", "cat", "grep"]
  const deny = ["pnpm dev"]
  const verdict = (cmd: unknown) => checkBashCommand(cmd, allow, deny)

  check("denies cat", !verdict("cat package.json").allow)
  check("denies head", !verdict("head -20 src/index.ts").allow)
  check("denies tail", !verdict("tail -n 5 log.txt").allow)
  check("denies sed", !verdict("sed -n '1,40p' src/app.ts").allow)
  check("denies grep", !verdict("grep -rn TODO src").allow)
  check("denies rg", !verdict("rg --files").allow)
  check("denies awk", !verdict("awk 'NR>10' file.ts").allow)
  check("denies find", !verdict("find . -name '*.ts'").allow)

  // The reader variants CLI 2.1.258/2.1.259 turned up chasing the same gap:
  // every one is one of the commands above wearing another name, and a list
  // that omits them is a rule with a spelling that gets through.
  check("denies tac", !verdict("tac log.txt").allow)
  check("denies egrep", !verdict("egrep -rn TODO src").allow)
  check("denies fgrep", !verdict("fgrep TODO src/x.ts").allow)
  check("denies nl", !verdict("nl -ba src/x.ts").allow)
  check("denies bat", !verdict("bat src/x.ts").allow)
  check("denies batcat", !verdict("batcat src/x.ts").allow)
  check("denies less", !verdict("less src/x.ts").allow)
  check("denies more", !verdict("more src/x.ts").allow)
  check("tac is told to use Read", verdict("tac x.ts").reason.includes("Read"))
  check("egrep is told to use Grep", verdict("egrep x src").reason.includes("Grep"))
  check("bat is told to use Read", verdict("bat x.ts").reason.includes("Read"))

  // Refused even when the run's own allowlist names them. The allowlist says
  // which commands this run may reach for; this rule says the shell is the wrong
  // way to reach for these at all, and an allowlist written before the rule
  // existed must not quietly opt out of it.
  check(
    "an allowlist naming cat does not re-permit it",
    !verdict("cat x.ts").allow,
    "the allowlist picks commands; this rule is about the tool, not the command",
  )

  // Each refusal names the tool that does the job, because a refusal an agent
  // cannot act on becomes a retry loop — the lesson `HUMAN_ONLY_REASON` records.
  check("cat is told to use Read", verdict("cat x.ts").reason.includes("Read"))
  check("grep is told to use Grep", verdict("grep x src").reason.includes("Grep"))
  check("find is told to use Glob", verdict("find . -name x").reason.includes("Glob"))
  check(
    "and says why, so it reads as a cost rather than a preference",
    verdict("cat x.ts").reason.includes("millisecond"),
    verdict("cat x.ts").reason.slice(0, 60),
  )

  // Prefix matching still ends at a word, or `catalog`, `finder` and `header`
  // become unrunnable for spelling reasons.
  check("catalog is not cat", verdict("pnpm catalog").allow, "prefix must end at a word")
  check("a path containing grep is not grep", verdict("pnpm run grepper").allow)
  check("lessc is not less", checkBashCommand("lessc style.less", null, []).allow)
  check("nl ends at a word too", checkBashCommand("nlx run x", null, []).allow)

  // A piped file-tool command with no file argument is a PAGER over another
  // command's output, which is the one thing only a shell can do — refusing it
  // sent the agent to Read for a command that has no file in it. The same
  // command aimed at a file stays refused; the dedicated section below walks
  // the shapes.
  const paged = checkBashCommand("git log --oneline | head -20", null, [])
  check(
    "a pager after a real command is allowed",
    paged.allow,
    paged.reason.slice(0, 60),
  )
  check(
    "but a piped read with a file argument is still a read",
    !checkBashCommand("pnpm test | tail -f log.txt", null, []).allow,
    "tail with a file is reading the file, wherever it sits in the chain",
  )

  // `ls` stays runnable. Glob answers a different question — paths matching a
  // pattern, recursively — so refusing `ls` would push the agent to `Glob("*")`,
  // a worse answer to a question it asked correctly.
  check("ls is still allowed", checkBashCommand("ls -la", null, []).allow, "Glob is not ls")

  // A denied command keeps its own reason. `grep` on a run that also denies it
  // outright must hear "no", not "use Grep instead" — the deny list is checked
  // first for exactly this.
  const bothListed = checkBashCommand("pnpm dev", ["pnpm"], ["pnpm dev", "grep"])
  check(
    "an outright denial still wins over the tool hint",
    !bothListed.allow && bothListed.reason.includes("never exits"),
    bothListed.reason.slice(0, 50),
  )
}

console.log("\nthe gate and its widening name the same commands")
{
  // The rule above is enforced in `checkBashCommand`, which on Auto is NEVER
  // REACHED for these: `fastBashSettings` puts `Bash(*)` in the SDK's settings
  // layer, and that layer resolves before `canUseTool`. So the file-tool prefixes
  // have to appear in that layer's deny list as well, or the rule is enforced on
  // Plan and decorative on the mode most turns actually run in.
  //
  // This is the assertion that catches the two lists drifting apart, which is
  // the only way this can fail — and it would fail silently, looking exactly
  // like a rule that works.
  const { FILE_TOOL_COMMANDS, SHELL_WRITE_COMMANDS, HUMAN_ONLY_COMMANDS: humanOnly } =
    await import("./policy.js")
  const { fastBashSettings } = await import("./agent.js")
  const configDeny = ["pnpm dev"]
  const denied = fastBashSettings(configDeny).permissions?.deny ?? []

  for (const { prefix } of FILE_TOOL_COMMANDS) {
    check(
      `the Auto layer denies ${prefix} too`,
      denied.includes(`Bash(${prefix})`) && denied.includes(`Bash(${prefix} *)`),
      "otherwise Bash(*) resolves it before the policy is consulted",
    )
  }
  for (const { prefix } of SHELL_WRITE_COMMANDS) {
    check(
      `the Auto layer denies ${prefix} as a shell write`,
      denied.includes(`Bash(${prefix})`) && denied.includes(`Bash(${prefix} *)`),
      "a write rule enforced on Plan and decorative on Auto is the same drift",
    )
  }
  check(
    "and still denies what it always did",
    denied.includes("Bash(pnpm dev)") && denied.includes("Bash(git commit)"),
    "the file-tool prefixes are an addition, not a replacement",
  )

  // The other direction: every prefix the Auto layer denies must come from one
  // of the named lists. This is what fails when someone hand-adds a rule to
  // `fastBashSettings` without putting it where `checkBashCommand` can see it —
  // which would enforce it on Auto and leave Plan-approved runs free of it,
  // the same one-sided gate the loop above catches the mirror image of.
  const known = new Set([
    ...configDeny,
    ...humanOnly,
    ...FILE_TOOL_COMMANDS.map((f) => f.prefix),
    ...SHELL_WRITE_COMMANDS.map((f) => f.prefix),
  ])
  const strays = denied
    .map((rule) => /^Bash\((.*?)\s?\*?\)$/.exec(rule)?.[1]?.trim() ?? rule)
    .filter((prefix) => !known.has(prefix))
  check(
    "every denied prefix traces back to a named list",
    strays.length === 0,
    strays.join("; ") || `${denied.length} rules checked`,
  )
}

console.log("\ncompound commands, segment by segment")
{
  // The settings layer matches leading words; the callback sees the full
  // string, and for a long time answered it with a blanket metacharacter
  // refusal — which refused `git log | head` for its pipe and taught nothing
  // about `cd x && cat y`. Now it splits on |, ;, && and ||, and judges each
  // segment by the same lists, with one carve-out: a file-tool command FED BY A
  // PIPE with no file argument is paging another command's output, which only a
  // shell can do. The carve-out is deliberately narrow — matching paths inside
  // option values is the over-reach upstream shipped and reverted in 2.1.260 —
  // so `tail -n 50` is never read as a file access on the value 50.
  const open = (cmd: string) => checkBashCommand(cmd, null, [])
  const listed = (cmd: string) => checkBashCommand(cmd, ["pnpm", "npm", "git log"], [])

  // The shapes that must be caught, each named after the tool that does the job.
  check("cd X && cat Y is refused for the cat", open("cd src && cat index.ts").reason.includes("Read"))
  check("cat Y | head is refused for the cat", open("cat notes.md | head -5").reason.includes("Read"))
  check("a < redirect is a read", !open("wc -l < src/app.ts").allow)
  check("and says so", open("wc -l < src/app.ts").reason.includes("Read"))
  check("$(cat …) is refused naming Read", open("echo $(cat .env)").reason.includes("Read"))
  check("`cat …` too", open("echo `cat .env`").reason.includes("Read"))
  check(
    "a substitution inside double quotes still counts",
    !open('echo "$(cat .env)"').allow,
    "double quotes do not stop $() expanding in a real shell",
  )
  check("a read after && is a read", !open("pnpm build && grep -rn TODO src").allow)
  check(
    "the file-tool refusal outranks the cd hint",
    open("cd src && cat index.ts").reason.includes("Read"),
    "the cat is the thing to fix; the cd sentence would send the agent to --filter and a second refusal",
  )

  // The legitimate compounds, which the blanket refusal used to eat. These are
  // the negative tests: a build tool's output piped into a pager must pass, on
  // the open path AND under an allowlist that never lists head or tail.
  check("npm run build passes", listed("npm run build").allow)
  check("git log | head passes open", open("git log | head").allow)
  check("git log | head passes an allowlist", listed("git log | head").allow)
  check("pnpm test 2>&1 | tail -50 passes open", open("pnpm test 2>&1 | tail -50").allow)
  check("pnpm test 2>&1 | tail -50 passes an allowlist", listed("pnpm test 2>&1 | tail -50").allow)
  check("a flag value is not a filename", open("pnpm test | tail -n 50").allow)
  check("a quoted script is not a filename", open("pnpm ls | sed 's/x/y/'").allow)
  check(
    "but a piped read aimed at a file is still refused",
    !open("pnpm build | grep error src/log.txt").allow,
    "the pipe does not launder a file argument",
  )
  check(
    "and a first-segment file tool has no pipe to hide behind",
    !open("cat x.ts | pnpm exec prettier").allow,
  )

  // Segment checks still apply the allowlist to every segment that RUNS a
  // command, so a chain cannot smuggle one in behind an allowed word.
  check("an unlisted second command is refused", !listed("pnpm ls | curl example.com").allow)
  check("chaining into an unlisted command is refused", !listed("npm run build && curl x").allow)

  // Backgrounding and subshells stay out: they are how an allowed prefix
  // carries a payload, and no segment reading makes them legible.
  check("backgrounding is refused", !open("pnpm dev &").allow)
  check("a subshell is refused", !open("(git commit)").allow)
  check("fd duplication is not backgrounding", open("pnpm test 2>&1").allow)
}

console.log("\nshell-authored writes")
{
  // The read rule costs seconds; this class costs work. A `sed -i`, a redirect
  // into the tree or a heredoc edits files with no Edit row in the transcript
  // and nothing for the checkpoint review to show — upstream has a documented
  // half-a-document data loss from exactly this. Refused with a reason that
  // names Edit and Write, because the way forward is the whole point.
  const open = (cmd: string) => checkBashCommand(cmd, null, [])
  const inRepo = (cmd: string) => checkBashCommand(cmd, null, [], "C:/Users/loki/code/aide")

  check("sed -i is refused", !open("sed -i 's/a/b/' src/x.ts").allow)
  check(
    "and the reason is the write one, not the read one",
    open("sed -i 's/a/b/' src/x.ts").reason.includes("Edit or Write"),
    open("sed -i 's/a/b/' src/x.ts").reason.slice(0, 60),
  )
  check("and says why", open("sed -i 's/a/b/' src/x.ts").reason.includes("checkpoint"))
  check("perl -i is refused", !open("perl -i -pe 's/a/b/' src/x.ts").allow)
  check("perl -i.bak too", !open("perl -i.bak -pe 's/a/b/' src/x.ts").allow)
  check("tee into the tree is refused", !open("pnpm test | tee out.log").allow)
  check("tee -a too", !open("pnpm test | tee -a out.log").allow)
  check("tee to /dev/null is not a write", open("pnpm test | tee /dev/null").allow)
  check("tee to /tmp is scratch", open("pnpm test | tee /tmp/out.log").allow)
  check("a > redirect into the tree is refused", !open("echo x > src/generated.ts").allow)
  check("a >> append too", !open("echo x >> notes.md").allow)
  check("a heredoc is refused", !open("cat > x.ts << EOF").allow)
  check(
    "and gets the write reason, because writing is what heredocs are for here",
    open("cat > x.ts << EOF").reason.includes("Edit or Write"),
  )
  check(
    "python -c that opens a file to write is refused",
    !open("python -c \"open('x.ts','w').write('data')\"").allow,
  )
  check(
    "node -e with writeFileSync is refused",
    !open("node -e \"require('fs').writeFileSync('x.ts','data')\"").allow,
  )
  check(
    "python -c that only reads is not a write",
    open("python -c \"print(open('x.ts').read())\"").allow,
    "only the named write shapes are refused — this is not a python parser",
  )
  check("plain node scripts still run", open("node scripts/one-off.mjs").allow)

  // The conservative side, which is most of the design: scratch space and
  // anything outside the tree is none of the review's business.
  check("> /dev/null passes", open("pnpm test > /dev/null").allow)
  check("2> /dev/null passes", open("pnpm test 2> /dev/null").allow)
  check("> /tmp passes", open("pnpm build > /tmp/build.log").allow)
  check("> %TEMP% passes", open("pnpm build > %TEMP%\\build.log").allow)
  check("> $TMPDIR passes", open("pnpm build > $TMPDIR/build.log").allow)
  check("> ../outside passes", open("pnpm build > ../scratch.log").allow)
  check(
    "an absolute path outside the project passes when cwd is known",
    inRepo("pnpm build > D:/logs/build.log").allow,
  )
  check(
    "an absolute path INSIDE the project does not",
    !inRepo("pnpm build > C:/Users/loki/code/aide/out.log").allow,
    "an absolute spelling of the tree is still the tree",
  )
  check(
    "without a cwd an absolute path is allowed",
    open("pnpm build > /somewhere/build.log").allow,
    "refusing what cannot be judged is the over-match; the daemon always passes cwd",
  )
}

console.log("\nthe run environment opts out of thrifty_sonic")
{
  const { CONFIG } = await import("./config.js")
  const { queryEnv } = await import("./agent.js")

  // The literal string, so a future edit to runEnv cannot silently re-enrol
  // every run in the CLI's bash-first experiment. "0" and not a truthy check:
  // the variable is read by the CLI as a string, and this is the one value the
  // investigation verified disables the injection.
  check(
    'runEnv carries CLAUDE_CODE_THRIFTY_SONIC: "0"',
    CONFIG.runEnv["CLAUDE_CODE_THRIFTY_SONIC"] === "0",
    String(CONFIG.runEnv["CLAUDE_CODE_THRIFTY_SONIC"]),
  )

  // The SDK's env option REPLACES the subprocess environment, so what reaches
  // query() must be process.env with the overrides ON TOP — losing the spread
  // loses PATH and the OAuth credentials, and letting process.env win would let
  // the host machine re-enrol the runs.
  const had = Object.prototype.hasOwnProperty.call(process.env, "CLAUDE_CODE_THRIFTY_SONIC")
  const before = process.env["CLAUDE_CODE_THRIFTY_SONIC"]
  process.env["CLAUDE_CODE_THRIFTY_SONIC"] = "1"
  const env = queryEnv(CONFIG.runEnv)
  check(
    "the override wins over a host that sets the variable itself",
    env["CLAUDE_CODE_THRIFTY_SONIC"] === "0",
    String(env["CLAUDE_CODE_THRIFTY_SONIC"]),
  )
  check(
    "and the rest of the environment survives the merge",
    typeof env["PATH"] === "string" || typeof env["Path"] === "string",
    "options.env replaces, so a lost spread reads as an auth failure",
  )
  if (had) process.env["CLAUDE_CODE_THRIFTY_SONIC"] = before
  else delete process.env["CLAUDE_CODE_THRIFTY_SONIC"]
}

console.log("\ndenied Bash calls are counted where the reasons are")
{
  // The settings layer's denial reaches the model with NO message —
  // SDKPermissionDenial has no reason field — so the callback's sentence is the
  // only corrective there is, and this tally is how a run's log says whether it
  // landed. More than RETRY_LOOP_DENIALS denials of one prefix in a turn is an
  // agent hunting for a spelling that gets through: the `git commit` story,
  // watched live, was exactly four.
  const { DenialTally, RETRY_LOOP_DENIALS } = await import("./policy.js")
  const tally = new DenialTally()

  check("starts at zero", tally.total === 0)
  const first3 = [
    tally.record("cat a.ts"),
    tally.record("cat b.ts"),
    tally.record("cat c.ts"),
  ]
  check(
    `${RETRY_LOOP_DENIALS} denials of one prefix are not yet a loop`,
    first3.every((warned) => !warned),
    "warning early cries wolf; the threshold is the observed hunting length",
  )
  check("the fourth is the signal", tally.record("cat d.ts") === true)
  check("and it fires once, not per denial after", tally.record("cat e.ts") === false)
  check("a different prefix counts separately", tally.record("grep x src") === false)
  check("the total counts everything", tally.total === 6, String(tally.total))
  tally.reset()
  check("a new turn starts clean", tally.total === 0 && tally.record("cat x") === false)

  // Every refusal reaching the model has to be actionable — name the way
  // forward, phrased as the next call. The generic allowlist refusal used to
  // say only "not in this run's allowlist", which names nothing.
  const { notAllowedReason } = await import("./agent.js")
  const reason = notAllowedReason("WebSearch", ["Read", "Glob", "Grep"])
  check("a tool refusal names the tool", reason.includes("WebSearch"))
  check("and the tools to use instead", reason.includes("Read") && reason.includes("Grep"))
  check(
    "and the way out when none of them fit",
    reason.includes("end the turn"),
    "a refusal with no exit is a retry loop",
  )
}

console.log("\na run says what mode it ran under")
{
  // run.started carried no permission mode, which made "was that turn Auto or
  // Plan" unanswerable from the logs — the exact analysis the deny-list
  // investigation needed and could not do. The SDK's init message is preferred
  // when it names one (that is the RESOLVED mode); the context's value covers
  // an SDK that does not.
  const { normalizeSdkMessage } = await import("./agent.js")
  const ctx = {
    projectId: "p1",
    cwd: "C:/x",
    fallbackModel: "claude-opus-5",
    permissionMode: "auto",
  }
  const init = (extra: Record<string, unknown>) =>
    normalizeSdkMessage({ type: "system", subtype: "init", session_id: "s1", ...extra }, ctx)[0]

  const resolved = init({ permissionMode: "plan" })
  check(
    "the SDK's own answer wins",
    resolved?.type === "run.started" && resolved.permissionMode === "plan",
    JSON.stringify(resolved),
  )
  const fallback = init({})
  check(
    "the query's mode fills in when the SDK is silent",
    fallback?.type === "run.started" && fallback.permissionMode === "auto",
  )
  const bare = normalizeSdkMessage(
    { type: "system", subtype: "init", session_id: "s1" },
    { projectId: "p1", cwd: "C:/x", fallbackModel: "m" },
  )[0]
  check(
    "and a replayed session with neither stays silent",
    bare?.type === "run.started" && bare.permissionMode === undefined,
    "inventing a mode for an old log would be a lie the analysis then trusts",
  )
}

console.log("\ncarrying out an approved plan")
{
  // A null allowlist is the shape a chat gets once the human has approved a
  // plan and asked for it to be carried out without further questions. Nobody
  // is watching, so what still has to hold is that the refusals hold: the ways
  // a run ends badly, and the one that ends the REVIEW.
  const deny = [...["pnpm dev", "pnpm probe", "npx"], ...HUMAN_ONLY_COMMANDS]
  const verdict = (cmd: unknown) => checkBashCommand(cmd, null, deny)

  // `rg --files` used to be this case and no longer can be: searching through a
  // shell is refused everywhere now, allowlist or not. Swapped rather than
  // dropped — what this asserts is that a null allowlist stops gating on the
  // LIST, which is still true and still the point.
  check("runs a command no allowlist mentions", verdict("docker ps").allow, "this is the point")
  check("runs node", verdict("node scripts/one-off.mjs").allow)
  check(
    "but the file tools are not a list it can opt out of",
    !verdict("rg --files").allow,
    "an approved plan is exactly where nobody is watching the seconds go",
  )
  check("still denies pnpm dev", !verdict("pnpm dev").allow, "it never exits")
  check("still denies npx", !verdict("npx cowsay").allow)
  check("denies git commit", !verdict("git commit -m x").allow, "the human commits, not the run")
  // Push is DOWNSTREAM of the gate, so allowing it removes no review: nothing is
  // pushable until a human has already read that diff and pressed commit.
  // Denying it stranded approved work on the machine that made it.
  check(
    "allows git push",
    verdict("git push").allow,
    "it only ever moves commits a human already approved",
  )
  check("allows git push with a remote and branch", verdict("git push origin main").allow)
  check("git status is not git commit", verdict("git status").allow, "prefix must end at a word")
  // Chaining is judged per segment, and the deny list holds in EVERY segment —
  // an unattended run is exactly where `pnpm ls; git commit` must not resolve
  // to its first, innocent word.
  check("denies chaining into a denied command", !verdict("pnpm ls; pnpm dev").allow)
  check(
    "denies chaining into git commit, with the commit-rule reason",
    verdict("pnpm ls; git commit -m x").reason.includes("never run from a turn"),
    verdict("pnpm ls; git commit -m x").reason.slice(0, 55),
  )
  check(
    "an env prefix does not dodge the deny list",
    !verdict("GIT_AUTHOR_NAME=x git commit -m x").allow,
    "the CLI's own parser walks VAR=value prefixes; so does this one now",
  )
  check("denies substitution", !verdict("echo $(git push)").allow)
  check("an empty command is still nothing", !verdict("   ").allow)

  // The two categories are refused for OPPOSITE reasons, and an agent acts on
  // the sentence rather than on the boolean. Both call sites concatenate the
  // lists, so for a while everything got `deniedBash`'s wording: an agent that
  // ran a human-only command was told it "never exits, or spends money", none of
  // which was true, and it read that as a runaway-command guard worth working
  // around — four denials in a row, each a different invocation, hunting for a
  // form that would pass. Asserting the boolean alone is what let that ship.
  const commitReason = verdict("git commit -m x").reason
  check(
    "the commit refusal says who commits instead, and when",
    commitReason.includes("aide commits") && commitReason.includes("checks pass"),
    commitReason.slice(0, 55),
  )
  check(
    "and says no form of it will work, so the agent stops looking",
    commitReason.includes("no form of this command"),
    "a refusal an agent cannot act on becomes a retry loop",
  )
  check(
    "and points at the one that IS allowed",
    commitReason.includes("git push"),
    "an agent that has just been refused should not have to guess whether push is next",
  )
  check(
    "a runaway command still gets the OTHER reason",
    verdict("pnpm dev").reason.includes("never exits"),
    verdict("pnpm dev").reason.slice(0, 55),
  )
  check(
    "and the two are not the same sentence",
    verdict("pnpm dev").reason !== commitReason,
    "sharing one message is exactly how the wrong reason reached the agent",
  )
}

console.log("\nthe agent is told what the gate will run")
{
  // Two thirds of all shell time across the eight most recently archived
  // conversations — 334 runs, 101.6 minutes — went on re-running the very checks
  // the commit gate runs afterwards. The cause is that a run cannot see the
  // gate, so it re-proves the whole tree after every edit. Naming the commands
  // in the system prompt is the fix, and these pin the two ways it breaks
  // silently.
  const { promptFingerprint } = await import("./chat.js")
  const doc = parseProjectDoc("---\nverify:\n  - pnpm typecheck\n  - pnpm smoke\n---\nthe brief")

  // A warm session's system prompt is fixed for the life of its query, so the
  // reuse test has to cover EVERY part of that prompt which came off disk. It
  // covered the prose only; the commands are in the prompt now too, and the
  // commit's one repair attempt is explicitly allowed to rewrite them — which
  // would leave a warm session naming checks that no longer exist.
  const rewritten = parseProjectDoc("---\nverify:\n  - pnpm typecheck\n---\nthe brief")
  check(
    "changing a check changes the fingerprint",
    promptFingerprint(doc) !== promptFingerprint(rewritten),
    "otherwise a rewritten gate keeps a warm session on the old prompt",
  )
  check(
    "changing the prose still changes it",
    promptFingerprint(doc) !== promptFingerprint(parseProjectDoc("---\nverify:\n  - pnpm typecheck\n  - pnpm smoke\n---\nother")),
    "the body half is what this test was originally for",
  )
  check(
    "and an identical doc is identical",
    promptFingerprint(doc) ===
      promptFingerprint(parseProjectDoc("---\nverify:\n  - pnpm typecheck\n  - pnpm smoke\n---\nthe brief")),
    "a fingerprint that never matches makes every message pay a cold start",
  )
  // The separator has to be something no command can contain, or two projects
  // whose fields differ can fingerprint the same. `parseVerify` trims commands
  // and refuses an empty one, so a newline cannot appear inside one.
  check(
    "a command cannot forge a field boundary",
    promptFingerprint({ body: "a", retired: [], verify: [{ command: "b", unless: [] }] }) !==
      promptFingerprint({ body: "a\n b", retired: [], verify: [] }),
    "colliding fingerprints reuse a session built from a different prompt",
  )
}

console.log("\nthe closing block a turn writes about itself")
{
  const fence = (body: string) => "```" + SUMMARY_FENCE + "\n" + body + "\n```"

  const full = parseTurnSummary(
    "Did the thing.\n\n" +
      fence("headline: fixed the poll guard\nnext: read the diff\nrisk: untested on remote"),
  )
  check("the headline is read", full?.headline === "fixed the poll guard", full?.headline)
  check("and the handover", full?.next === "read the diff")
  check("and the risk", full?.risk === "untested on remote")

  // The headline is what makes it a summary. A block with only a `next:` is a
  // fragment, and a card drawn from it has an empty first line — which reads as
  // aide having lost the text rather than as the model not having written any.
  check("a block with no headline is not a summary", parseTurnSummary(fence("next: x")) === null)
  check("a reply with no block at all is not one either", parseTurnSummary("just prose") === null)
  check("nor is an ordinary code block", parseTurnSummary("```\nheadline: no\n```") === null)

  // The LAST block, not the first. A turn answering "what did you say last
  // time" quotes an older summary, and taking the first would report that one
  // as this turn's.
  const quoted = parseTurnSummary(fence("headline: the old one") + "\n\n" + fence("headline: the new one"))
  check("the last block wins", quoted?.headline === "the new one", quoted?.headline)

  // A field that wraps keeps its second line. The model writes prose here, and
  // prose wraps — dropping the continuation silently truncates mid-sentence.
  const wrapped = parseTurnSummary(fence("headline: a long one\n  that wrapped\nnext: go"))
  check("a wrapped field keeps its tail", wrapped?.headline === "a long one that wrapped", wrapped?.headline)
  check("and the field after it still parses", wrapped?.next === "go")

  // Absent and empty are different: one is a turn with nothing to hand over,
  // the other is a turn that did not answer, and they are drawn differently.
  const bare = parseTurnSummary(fence("headline: done\nnext:"))
  check("an empty field is absent, not blank", bare?.next === undefined, String(bare?.next))

  // Never throws. This runs while normalizing a message, so a malformed block
  // has to mean "no summary" rather than take the turn's events down with it.
  let threw = false
  try {
    parseTurnSummary("```" + SUMMARY_FENCE + "\nheadline: unterminated")
  } catch {
    threw = true
  }
  check("an unterminated block does not throw", !threw, "it runs mid-normalize")

  // The block is machinery and must not be read as prose. Stripped at RENDER
  // time only — the log keeps the reply exactly as the model wrote it.
  const reply = "Here is what I did.\n\n" + fence("headline: x")
  check("the block is taken out of the prose", !stripTurnSummary(reply).includes("headline:"))
  check("and the prose survives", stripTurnSummary(reply) === "Here is what I did.")

  // Mid-stream the closing fence has not arrived, so the ordinary strip matches
  // nothing and the reader watches the block's own field names type themselves
  // out — the raw machinery the card exists to replace.
  const typing = "Here is what I did.\n\n```" + SUMMARY_FENCE + "\nheadline: half w"
  check(
    "a half-written block is hidden too",
    stripPartialTurnSummary(typing) === "Here is what I did.",
    JSON.stringify(stripPartialTurnSummary(typing)),
  )
  check(
    "and a reply with no block is untouched by it",
    stripPartialTurnSummary("plain words") === "plain words",
  )

  // A global regex keeps `lastIndex` between calls, so a shared one silently
  // skips the first block of every other call. Two calls, same input.
  check(
    "parsing twice gives the same answer",
    parseTurnSummary(reply)?.headline === parseTurnSummary(reply)?.headline,
    "a module-level global regex would fail this on the second call",
  )
}

console.log("\na snapshot that is stable across projects")
{
  // `useSyncExternalStore` compares by IDENTITY, so a snapshot that derives a
  // fresh array on every read re-renders forever. The version this replaces held
  // ONE memo slot and was correct while one project was on screen; a view that
  // drew two at once made their interleaved reads evict each other, so every read
  // missed and the page went grey about half a second after it painted. That view
  // is gone and this stays — the assertions below are what stop a future one
  // rediscovering it. Nothing about it is visible to `tsc` or to the build.
  const memo = new PerProjectMemo<string>()
  const source = { store: 1 }
  let computed = 0
  const rows = (id: string) => {
    computed += 1
    return [`${id}-a`, `${id}-b`]
  }

  const first = memo.read(source, "p1", rows)
  check("a first read computes", first?.length === 2 && computed === 1)
  check("and reading it again is the same array", memo.read(source, "p1", rows) === first)

  // The case that broke: two projects read in turn, every render.
  const other = memo.read(source, "p2", rows)
  check("a second project gets its own", other !== first && other?.length === 2)
  check(
    "and the first is NOT evicted by it",
    memo.read(source, "p1", rows) === first,
    "one slot for two projects is the render loop that greyed the page",
  )
  check("nor the second by going back", memo.read(source, "p2", rows) === other)
  check("so interleaving computes nothing new", computed === 2, String(computed))

  // Three passes over two projects, which is what a repeated render does.
  const before = computed
  for (let pass = 0; pass < 3; pass++) {
    check(`p1 is stable on pass ${pass}`, memo.read(source, "p1", rows) === first)
    check(`p2 is stable on pass ${pass}`, memo.read(source, "p2", rows) === other)
  }
  check("and none of that recomputed", computed === before)

  // A write replaces the store wholesale, which invalidates every project at
  // once — no caller has to know which project was touched.
  const after = memo.read({ store: 2 }, "p1", rows)
  check("a new store recomputes", after !== first && computed === before + 1)

  check("no project is not an empty list", memo.read(source, null, rows) === null)
}

console.log("\na chat that has just handed off")
{
  // The unstarted record is dropped the instant the SDK names the session, and
  // the row that replaces it only arrives on the next fetch of the daemon's
  // list. Between those two the chat is in neither collection — so it left the
  // list and came back a round trip later, which locally is a flash and on a
  // remote project is seconds of the row simply being gone.
  //
  // Both ways of getting the retirement wrong are SILENT. Held too long and one
  // chat is drawn twice under two keys with a tick on one of them; dropped too
  // early and the row blinks out again, which is the bug this removes. Neither
  // is visible to `tsc` or to the build, and a React component cannot be driven
  // from here — which is why the rule is a function in protocol.
  const note = (sessionId: string) => ({ sessionId, title: sessionId, createdAt: 1, lastModified: 1 })
  const a = note("s-a")
  const b = note("s-b")

  check("a stand-in the list does not have yet is kept", bridgedChats([a], new Set()).length === 1)
  check("and it is the same object", bridgedChats([a], new Set())[0] === a)
  check(
    "one the list HAS is retired",
    bridgedChats([a], new Set(["s-a"])).length === 0,
    "a note kept past its real row draws the chat twice",
  )
  check(
    "and only that one",
    bridgedChats([a, b], new Set(["s-a"])).map((n) => n.sessionId).join() === "s-b",
  )
  check("nothing standing stays nothing", bridgedChats([], new Set(["s-a"])).length === 0)
  // The identity half. The list reports what landed by comparing the filtered
  // array against the one it was given, so a filter that rebuilt its entries
  // would report every note as landed on every render — and retire the
  // stand-in immediately, restoring the flicker while looking like it worked.
  const kept = bridgedChats([a, b], new Set(["s-a"]))
  check("survivors keep their identity", kept[0] === b, "a rebuilt entry breaks the landed report")
}

console.log("\nwhere a hover hint goes")
{
  // Every one of these is a silent failure. A hint placed off the right edge of
  // the window, or flipped under the pointer, or with its arrow pointing at its
  // own middle instead of at the thing it describes, still RENDERS — nothing
  // throws and nothing logs. The only report is somebody noticing they cannot
  // read it, which is why the arithmetic is in protocol rather than in the
  // component that paints it.
  const view = { width: 1000, height: 800 }
  const box = { width: 200, height: 40 }
  /** A 20x20 anchor with its top-left at (x, y). */
  const at = (x: number, y: number) => ({ left: x, top: y, right: x + 20, bottom: y + 20 })

  const mid = placeHint(at(500, 400), box, view)
  check("a hint opens above what it describes", mid.side === "top")
  check("clear of it by the offset", mid.top === 400 - 40 - 6, `${mid.top}`)
  check("centred on it", mid.left === 510 - 100, `${mid.left}`)
  check("with the arrow at its own centre", mid.arrow === 100, `${mid.arrow}`)

  // The flip, and the reason it is a comparison rather than a test of the
  // default: near the TOP there is room below and the hint must go there.
  const top = placeHint(at(500, 5), box, view)
  check("no room above flips it under", top.side === "bottom")
  check("clear of it downwards", top.top === 25 + 6, `${top.top}`)

  // Near the BOTTOM there is room above, so it stays above — the ordinary case
  // for the working bar and the rail's foot, which sit on a window edge.
  const bottom = placeHint(at(500, 770), box, view)
  check("an element at the bottom edge keeps its hint above", bottom.side === "top")

  // Neither side fits, and above is the roomier of the two. Flipping here would
  // trade a clipped top for a MORE clipped bottom, so the comparison has to be
  // between the two rooms rather than a test of the default alone.
  const squeezed = placeHint(at(500, 40), box, { width: 1000, height: 80 })
  check("when neither side fits it takes the roomier one", squeezed.side === "top")
  // And the same shape the other way up: barely any room above, more below.
  const squeezedDown = placeHint(at(500, 10), box, { width: 1000, height: 80 })
  check("and flips when below is the roomier one", squeezedDown.side === "bottom")

  // The horizontal clamp, and the arrow following the anchor out of the box's
  // centre — this is what stops a clamped hint pointing at nothing.
  const right = placeHint(at(980, 400), box, view)
  check("a hint near the right edge is pulled back", right.left === 1000 - 200 - 8, `${right.left}`)
  check("and stays on screen", right.left + box.width <= view.width)
  check("its arrow follows the anchor, not the box", right.arrow > 100, `${right.arrow}`)
  check("and stays inside the box", right.arrow <= box.width - 8)

  const left = placeHint(at(0, 400), box, view)
  check("a hint near the left edge is pushed in", left.left === 8, `${left.left}`)
  // The anchor's centre (x=10) is only 2px into a box pushed to x=8, which is
  // inside the corner the box's own border and rounding occupy. The arrow pins
  // at the inset rather than being drawn half-cut — the guard doing its job.
  check("an arrow that would land in the corner pins to the inset", left.arrow === 8, `${left.arrow}`)

  // A box wider than the window pins LEFT, because the start of a sentence is
  // the half worth keeping. Clamping the other way round loses the beginning.
  const wide = placeHint(at(500, 400), { width: 1200, height: 40 }, view)
  check("a hint wider than the window pins to the left", wide.left === 8, `${wide.left}`)

  // A zero-width box is what a hint measured before its first paint looks like;
  // the arrow must not come out negative and land outside its own element.
  const empty = placeHint(at(500, 400), { width: 0, height: 0 }, view)
  check("an unmeasured hint still places an arrow", empty.arrow >= 0, `${empty.arrow}`)
}

console.log("\nwhere you are, as a URL")
{
  // `parseLocation` and `formatLocation` are inverses, and a broken round trip
  // is not an error anywhere — it is a reload landing somewhere you did not ask
  // for, which reads as the app forgetting what you had open rather than as a
  // parser bug. That is why these live in protocol rather than beside the hook.
  //
  // Asserted as STABILITY rather than as byte-equality with the input: a page
  // with no project formats as `#/activity/`, so a bare `#/activity` is a
  // different spelling of the same place and comparing against the input would be
  // testing the spelling rather than the inverse. What has to hold is that
  // formatting again changes nothing — that is what makes the effect in
  // `useAppLocation` settle instead of rewriting the URL on every render.
  const trip = (hash: string) => formatLocation(parseLocation(hash))
  for (const hash of [
    "#/",
    "#/p/abc",
    "#/p/abc/session-1",
    "#/p/abc/new/new-xyz",
    "#/activity",
    "#/activity/p/abc/session-1",
  ]) {
    check(`${hash} round trips to a fixed point`, trip(trip(hash)) === trip(hash), trip(hash))
  }
  // And the ones that carry a project are byte-identical, which is the case a
  // shared link actually consists of.
  for (const hash of [
    "#/p/abc",
    "#/p/abc/session-1",
    "#/p/abc/new/new-xyz",
    "#/activity/p/abc/session-1",
  ]) {
    check(`${hash} survives verbatim`, trip(hash) === hash, trip(hash))
  }

  // The dashboard is a PREFIX, so what is underneath survives — which is what
  // lets closing it put you back exactly where you were.
  const under = parseLocation("#/activity/p/abc/session-1")
  check("the dashboard keeps the project underneath it", under.projectId === "abc")
  check("and the chat", under.sessionId === "session-1")
  check("and says it is open", under.activity)

  // A bare page is a complete location: it is about every project, so it needs
  // none. Testing only for a project id would drop it.
  check("a bare activity URL is a location", parseLocation("#/activity").activity === true)
  check("with no project", parseLocation("#/activity").projectId === null)

  // Layouts this app has already outgrown. The mirror in localStorage outlives
  // them, so they land on the project rather than on nothing.
  check("an old chats URL still finds its project", parseLocation("#/p/abc/chats/s1").projectId === "abc")
  check("and its chat", parseLocation("#/p/abc/chats/s1").sessionId === "s1")
  check("a retired board URL opens the project", parseLocation("#/p/abc/board").projectId === "abc")
  check("with nothing open", parseLocation("#/p/abc/board").sessionId === null)

  // The wall was the second whole-window prefix, and it is gone. A bookmark or a
  // restored mirror still naming it has to open what it names rather than drop
  // the project — the same courtesy `chats` and `board` above get. This is the
  // one that would be silent: `#/wall/p/abc/s1` failing the `p` test lands you on
  // an empty app with the URL apparently intact.
  const retired = parseLocation("#/wall/p/abc/session-1")
  check("a retired wall URL still finds its project", retired.projectId === "abc")
  check("and its chat", retired.sessionId === "session-1")
  check("and formats without the prefix", formatLocation(retired) === "#/p/abc/session-1")
  check("a bare wall URL is just the app", parseLocation("#/wall").projectId === null)

  check("nonsense is not a project", parseLocation("#/nonsense").projectId === null)
}

console.log("\nwhat a project's gates refuse")
{
  // These answers used to be computed inline in `App.tsx` for the one open
  // project. They were lifted out when a second view needed them per project,
  // and they stay out: a second implementation of "is this project blocked" is
  // the shape that produced the wedge in the brief — a block reading one object
  // while the button that releases it reads another. Asserted here because a
  // component cannot be.
  const held = (title: string) => `"${title}" has it`
  const holder = { runId: "run-1", title: "a chat" }

  // What is deliberately ABSENT is the old dirty-tree rule. Commits are
  // automatic — once per turn, after the checks — and the commit button is
  // gone, so a dirty tree blocking a new chat would be a refusal with no
  // release: the wedge in the brief, built on purpose. The only gate left is
  // the lock.
  const free = projectGates({ holder: null, held })
  check("a free project refuses nothing", !free.start && !free.push && !free.send)

  // `start` gates a chat's first SEND — the ▶ and the survey button. Creating
  // a parked row is never gated: it is a local record, the same act as the
  // capture box, and locking the `new` button on this rule is the bug where
  // typing into the box was the workaround for the button beside it.
  const busy = projectGates({ holder, held })
  check("a holder stops a chat's first send", busy.start === held("a chat"))
  check(
    "and a push",
    busy.push === held("a chat"),
    "pushing under a live run sends a branch whose tip is about to move",
  )

  // The composer's half. The turn on screen is the one you can interrupt; a run
  // anywhere else is the one you must wait for, and they are told apart by run
  // id rather than by session — a commit attributed to this conversation is not
  // this conversation's turn.
  const watching = projectGates({ holder, openRunId: "run-1", held })
  check("the turn I am watching does not lock its own box", watching.send === null)
  const elsewhere = projectGates({ holder, openRunId: "run-9", held })
  check("a run somewhere else does", elsewhere.send === held("a chat"))
  check(
    "but even my own turn blocks another chat's first send",
    watching.start === held("a chat"),
    "the daemon refuses a fresh turn under any holder, ours included",
  )

  // An auto-commit landing is a holder that blocks almost nothing: the daemon
  // QUEUES a send behind it and starts the turn when it releases, so a lock
  // drawn for it would refuse something the daemon accepts — a block reading
  // one object while the button reads another, in the polite direction.
  // Committing was automated precisely so nobody waits on it.
  const committing = projectGates({ holder: { ...holder, held: true }, held })
  check("a commit landing does not stop a send", committing.send === null)
  check("nor a chat's first send", committing.start === null)
  check(
    "but it does hold the push",
    committing.push === held("a chat"),
    "pushing while a commit lands sends a branch whose tip is about to move",
  )
}

console.log("\nthe message an auto-commit writes")
{
  // A commit per turn needs a subject per turn, and the turn already wrote one:
  // the `headline` of its closing summary block. Using it is what keeps an
  // auto-commit free — no helper-model call, no ten-second wait — and honest,
  // since the line was written by the thing that did the work. These pin the
  // decision function; the fallback path (null → helper model drafts from the
  // diff) is a model call the smoke repo cannot make, so what is pinned about
  // it is that null MEANS "draft".
  const { turnCommitMessage } = await import("./review.js")

  const full = turnCommitMessage("wire the thrifty-sonic opt-out", "T2. Env var.\nDetails below.")
  check("the headline becomes the subject", full?.subject === "wire the thrifty-sonic opt-out")
  check(
    "and the prompt's first line the body, verbatim",
    full?.body === "T2. Env var.",
    String(full?.body),
  )

  // Git's conventional 72 columns, cut with an ellipsis rather than wrapped —
  // a subject that wraps is two half-sentences in every log listing.
  const long = turnCommitMessage("x".repeat(100), "p")
  check(
    "a runaway headline is capped at 72",
    (long?.subject.length ?? 0) <= 72,
    String(long?.subject.length),
  )
  check("and says it was cut", long?.subject.endsWith("…") === true)
  const exact = turnCommitMessage("y".repeat(72), "p")
  check("seventy-two exactly is not cut", exact?.subject === "y".repeat(72))

  check("no headline means the helper model drafts", turnCommitMessage(null, "p") === null)
  check("so does a blank one", turnCommitMessage("   ", "p") === null)
  check("and an absent one", turnCommitMessage(undefined, "p") === null)
  check("an empty prompt is an empty body, not a crash", turnCommitMessage("h", "")?.body === "")
}

console.log("\nthe message a squash writes")
{
  // Squashing is the push button's second spelling: fold the per-turn commits
  // into one before they leave the machine. What must survive the fold is
  // everything the auto-commits said — every subject in the body, every
  // Aide-Session trailer — or squashing would cut the link from history back to
  // the transcripts that explain it.
  const { squashMessage } = await import("./changes.js")

  const msg = squashMessage(
    ["add the parser", "fix the parser's cap", "rename the cap"],
    ["s-1", "s-2"],
  )
  check("the FIRST subject leads", msg.startsWith("add the parser\n"), msg.split("\n")[0])
  check(
    "every subject survives in the body",
    msg.includes("- fix the parser's cap") && msg.includes("- rename the cap"),
  )
  check(
    "and every conversation's trailer",
    msg.includes("Aide-Session: s-1") && msg.includes("Aide-Session: s-2"),
    "losing the trailers would orphan the transcripts the commits point at",
  )
  const long = squashMessage(["z".repeat(100)], [])
  check("a runaway first subject is capped", (long.split("\n")[0]?.length ?? 0) <= 72)
  check("no sessions is no trailer block", !squashMessage(["a"], []).includes("Aide-Session"))
}

console.log("\nwhat a turn is doing right now")
{
  // The working bar's line. There was a card view reduced from these same
  // events; it was removed, and this is what survived it — see
  // `protocol/activity-line.ts`.
  let seq = 0
  const ev = (body: RunEventBody, ts = 1000 + seq * 10): RunEvent =>
    ({ ...body, runId: "r1", seq: (seq += 1), ts }) as RunEvent

  // What a running turn says it is doing, and SINCE WHEN. The clock is the
  // point: an elapsed time measured from the start of the turn counts up at the
  // same rate whether the agent is making progress or wedged, so the line
  // measures the current STEP instead and a step whose clock keeps resetting is
  // visible progress.
  const running = currentActivity([
    ev({ type: "user.message", text: "go" }, 1000),
    ev({ type: "tool.start", toolUseId: "t1", name: "Bash", input: { command: "pnpm smoke" }, parentToolUseId: null }, 2000),
  ])
  check("a running turn says what it is doing", running?.label === "Running Bash pnpm smoke", running?.label)
  check(
    "and the clock starts at that STEP, not at the turn",
    running?.since === 2000,
    `${running?.since} — 1000 would be the turn, which cannot distinguish progress from a stall`,
  )

  // The OLDEST open call, not the newest. One message opens several at once, and
  // reporting the newest resets the clock every time a batch goes out — hiding
  // exactly the stall this exists to show.
  const batch = currentActivity([
    ev({ type: "tool.start", toolUseId: "a", name: "Bash", input: { command: "pnpm build" }, parentToolUseId: null }, 1000),
    ev({ type: "tool.start", toolUseId: "b", name: "Read", input: { file_path: "/x/y.ts" }, parentToolUseId: null }, 1100),
  ])
  check(
    "a batch reports the call that has been open longest",
    batch?.since === 1000 && batch.label.includes("pnpm build"),
    `${batch?.label} @ ${batch?.since}`,
  )

  // A closed call stops being the answer, or the line names something that has
  // already returned.
  const closed = currentActivity([
    ev({ type: "tool.start", toolUseId: "a", name: "Bash", input: { command: "pnpm build" }, parentToolUseId: null }, 1000),
    ev({ type: "tool.end", toolUseId: "a", ok: true, summary: "" }, 1500),
  ])
  check("a finished call is not still running", closed?.label === "Thinking", closed?.label)

  // A pending permission outranks everything: nothing moves until it is answered.
  const asking = currentActivity([
    ev({ type: "tool.start", toolUseId: "a", name: "Bash", input: { command: "pnpm build" }, parentToolUseId: null }, 1000),
    ev({ type: "permission.request", requestId: "q1", name: "Write", input: {} }, 1200),
  ])
  check(
    "an open question outranks an open call",
    asking?.label === "Waiting for you · Write" && asking.since === 1200,
    `${asking?.label} @ ${asking?.since} — nothing moves until it is answered`,
  )
  check(
    "and an answered one stops being the line",
    currentActivity([
      ev({ type: "permission.request", requestId: "q1", name: "Write", input: {} }, 1200),
      ev({ type: "permission.resolved", requestId: "q1", allowed: true, reason: "" }, 1300),
    ])?.label !== "Waiting for you · Write",
  )

  // The boilerplate in front of a command comes off. Nearly every Bash call in
  // this project's logs opens `cd C:/Users/loki/code/aide; CI=true pnpm …` — 34
  // identical characters — so a truncated label read the same for a typecheck, a
  // build and a smoke run, which is the one distinction the line is for.
  const shell = currentActivity([
    ev(
      {
        type: "tool.start",
        toolUseId: "a",
        name: "Bash",
        input: { command: "cd C:/Users/loki/code/aide; CI=true pnpm smoke" },
        parentToolUseId: null,
      },
      1000,
    ),
  ])
  check("a command loses its cd and env prefix", shell?.label === "Running Bash pnpm smoke", shell?.label)

  // A path is reduced to its basename: the bar is a few hundred pixels wide and
  // a full absolute path pushes the tool's own name off the front of the line.
  const reading = currentActivity([
    ev({ type: "tool.start", toolUseId: "a", name: "Read", input: { file_path: "C:/Users/loki/code/aide/packages/protocol/src/events.ts" }, parentToolUseId: null }, 1000),
  ])
  check("a file path is shown as its basename", reading?.label === "Running Read events.ts", reading?.label)

  // A subagent spawn is a container: open for its subagent's whole life BY
  // DESIGN, so reporting it as the oldest open call pins the label to
  // "Running Agent" with a clock that never resets — the exact wedge signature
  // the line exists to draw — while the subagent's own calls, the real steps,
  // churn invisibly underneath it.
  const fanned = currentActivity([
    ev({ type: "tool.start", toolUseId: "spawn", name: "Agent", input: { description: "survey daemon" }, parentToolUseId: null }, 1000),
    ev({ type: "tool.start", toolUseId: "inner", name: "Grep", input: { pattern: "gates" }, parentToolUseId: "spawn" }, 2000),
  ])
  check(
    "a subagent's own call outranks the spawn that opened it",
    fanned?.label === "Running Grep gates" && fanned.since === 2000,
    `${fanned?.label} @ ${fanned?.since} — the spawn is open for minutes by design`,
  )
  const spawnOnly = currentActivity([
    ev({ type: "tool.start", toolUseId: "spawn", name: "Agent", input: { description: "survey daemon" }, parentToolUseId: null }, 1000),
  ])
  check(
    "but a spawn with nothing running inside it is still the line",
    spawnOnly?.label === "Running Agent" && spawnOnly.since === 1000,
    `${spawnOnly?.label} — a thinking subagent is not a stalled turn`,
  )
  const innerDone = currentActivity([
    ev({ type: "tool.start", toolUseId: "spawn", name: "Agent", input: {}, parentToolUseId: null }, 1000),
    ev({ type: "tool.start", toolUseId: "inner", name: "Grep", input: { pattern: "x" }, parentToolUseId: "spawn" }, 2000),
    ev({ type: "tool.end", toolUseId: "inner", ok: true, summary: "" }, 2500),
  ])
  check(
    "a finished inner call hands the line back to the spawn",
    innerDone?.label === "Running Agent",
    innerDone?.label,
  )

  // A check with no result yet is the same idea for a commit run.
  const checking = currentActivity([
    ev({ type: "verify.started", command: "pnpm typecheck" }, 1000),
  ])
  check("a check in flight names itself", checking?.label === "Running pnpm typecheck", checking?.label)

  check(
    "a run with no events yet has no line",
    currentActivity([]) === null,
    "the caller decides what an unstarted turn says — `Sending` is a different statement",
  )
}

console.log("\nfolding the derivation, not the answer")
{
  // The card was removed for compressing LOSSILY — a fixed-size, model-written
  // summary that carried least exactly where the turn held most. A fold is the
  // opposite trade and only stays that way if it can be shown to drop nothing,
  // which is what these assert. None of it is visible to `tsc`: a fold that
  // loses a row type-checks and renders, it just shows you less than happened.
  const tool = (name: string) => ({ kind: "tool", name })
  const text = (t: string) => ({ kind: "text", text: t })

  const flat = (rows: ReturnType<typeof foldRows>) =>
    rows.flatMap((r) => (r.folded ? r.group.rows : [r.row]))

  const think = (t: string) => ({ kind: "thinking", text: t })
  const asked = (t: string) => ({ kind: "user", text: t })

  // The shape a real turn has: prose BETWEEN the calls, not only at the end.
  const turn = [
    asked("remove the steer correction"),
    think("planning"),
    tool("Grep"),
    text("Confirmed — the loader never reads it. Let me build and verify what that leaves behind."),
    tool("Bash"),
    think("reading the output"),
    tool("Edit"),
    text("Now the assertions, since the flush-on-thinking one is what made it look absent."),
    tool("Bash"),
    text("The approach now rides at whatever you picked on the DRIVE panel. Two follow-on fixes."),
    { kind: "outcome" },
  ]
  const one = foldRows(turn, false)
  check(
    "a whole turn folds to ONE row plus its answer",
    one.filter((r) => r.folded).length === 1,
    `${one.filter((r) => r.folded).length} folds — a fold per burst is the transcript with extra clicks in it`,
  )
  check(
    "the question it answers stays out of the fold",
    one[0]?.folded === false && "kind" in one[0].row && one[0].row.kind === "user",
    "the ask is what a fold hangs under — burying it leaves a collapsed row explaining nothing",
  )
  check(
    "and the answer is the last thing the turn said",
    one.some(
      (r) => !r.folded && "text" in r.row && r.row.text.startsWith("The approach now rides"),
    ),
    "position marks the answer, not length — a mid-turn paragraph is derivation however long it is",
  )
  check(
    "mid-turn prose is folded away with the calls",
    !one.some((r) => !r.folded && "text" in r.row && r.row.text.startsWith("Confirmed —")),
    "this is the one the length rule got wrong: long AND narration is the common case",
  )
  check(
    "what follows the answer stays out of the fold",
    one.at(-1)?.folded === false,
    "the outcome line is structural — folding it would hide how the turn ended",
  )

  // The case the old rules had no concept of, and the reason the unit is the
  // turn: a conversation is many of these, and each one gets its own fold and
  // its own answer. Folding by content rather than by the ask cannot express
  // this at all — it sees one long stream and picks one boundary in it.
  const conversation = [
    asked("first thing"),
    tool("Grep"), tool("Bash"), think("hm"),
    text("Done, the first one is fixed."),
    asked("second thing"),
    tool("Edit"), tool("Bash"), think("checking"),
    text("Done, and the second one too."),
  ]
  const many = foldRows(conversation, false)
  check(
    "each question gets its own fold",
    many.filter((r) => r.folded).length === 2,
    `${many.filter((r) => r.folded).length} folds for 2 questions`,
  )
  check(
    "and its own answer",
    many.filter((r) => !r.folded && "kind" in r.row && r.row.kind === "text").length === 2,
    "one turn's answer is not the next turn's — a single boundary over the whole log conflates them",
  )
  check(
    "a turn's work never crosses into the one before it",
    many.every((r) => !r.folded || r.group.rows.length === 3),
    "3 rows apiece — a fold that swallowed a user message would hold six",
  )

  // The property that makes every other one safe.
  check(
    "nothing is lost, whatever the shape",
    flat(foldRows(turn, false)).length === turn.length,
    `${flat(foldRows(turn, false)).length} of ${turn.length} — the fold hides rows, it never removes them`,
  )
  check(
    "and they stay in order",
    JSON.stringify(flat(foldRows(turn, false))) === JSON.stringify(turn),
    "a reordered transcript reads as the agent having done things in an order it did not",
  )

  // Thinking was once neither `tool` nor `text` and so FLUSHED the run, chopping
  // a turn of sixteen calls into fragments that could not reach the threshold.
  // Nothing folded at all, which reads as the feature being absent rather than
  // as a bug in it.
  const across = foldRows([tool("Grep"), think("a"), tool("Bash"), think("b"), text("done")], false)
  check(
    "thinking does not break a run",
    across.filter((r) => r.folded).length === 1,
    "an unrecognised kind flushes, and a fragment cannot reach the threshold",
  )
  check(
    "a turn that only thinks still folds",
    foldRows([think("a"), think("b"), think("c"), text("done")], false).some((r) => r.folded),
    "counting calls alone leaves pages of reasoning as the one thing that never collapses",
  )

  // Even a lone step folds. The threshold used to be two — a fold the same
  // height as the row it replaces looked like readability traded for a click —
  // but a run of one is what EVERY turn is while its opening block streams, so
  // the block the rule promises to collapse was the one block always on screen,
  // in full, until a second row arrived to tip it over the threshold.
  const single = foldRows([tool("Read"), text("done")], false)
  check(
    "even a lone step folds — the boundary is the rule, not the height",
    single.some((r) => r.folded),
    "a threshold makes the rule 'derivation folds, except when there was only one thing'",
  )
  check(
    "a live turn's first block is folded from the start",
    foldRows([asked("go"), think("streaming…")], true).some((r) => r.folded),
    "the opening thinking block is a run of one — left loose, it streams in full and is swallowed mid-read",
  )

  // A turn with no prose at all — cut short, or interrupted. It still folds,
  // because the fold hangs off the ASK rather than off the answer: work you
  // requested is work that collapses, whether or not anything was said at the
  // end of it. The outcome line stays out, so how it ended is still on screen.
  const silent = foldRows(
    [asked("do it"), tool("Grep"), tool("Bash"), { kind: "outcome" }],
    false,
  )
  check(
    "a turn that never answered still folds its work",
    silent.filter((r) => r.folded).length === 1,
    "the fold hangs off the question, so it does not need an answer to exist",
  )
  check(
    "and how it ended is still visible",
    silent.at(-1)?.folded === false,
    "an interrupted turn with its outcome folded away is one you cannot tell from a finished one",
  )

  // A live turn DOES fold — this is the change your eye caught. It used to fold
  // nothing while running, so the split point crept down the screen as the turn
  // went: `28 steps` with two calls hanging below it, then `31 steps` a moment
  // later. Every frame was defensible and the boundary was never twice in the
  // same place, which is unlearnable. Now the fold opens at the question and
  // simply grows, so the only thing that moves is its own count.
  const running = [asked("do the thing"), tool("Grep"), think("a"), tool("Bash"), text("so far")]
  const inFlight = foldRows(running, true)
  check(
    "a live turn folds from the question down",
    inFlight.filter((r) => r.folded).length === 1,
    "a boundary that moves as the turn runs is one a reader cannot learn",
  )
  check(
    "and claims no answer while it is still writing",
    inFlight.every((r) => r.folded || !("text" in r.row) || r.row.kind === "user"),
    "the prose arriving now is the turn in progress, not its conclusion",
  )
  check(
    "the same turn yields its answer once it is over",
    foldRows(running, false).some(
      (r) => !r.folded && "text" in r.row && r.row.text === "so far",
    ),
    "settled is what decides the answer, and it is decided once",
  )

  // A commit is its own episode and collapses as one. It used to be six row
  // kinds loose among the rest — checks, a step, a full message box, the landed
  // sha — so it had no visible start or end and spent more vertical space than
  // anything else in a transcript while being the least re-read.
  const committed = foldRows(
    [
      asked("commit this"),
      tool("Grep"),
      text("Looks right."),
      { kind: "commit-step" },
      { kind: "verify" },
      { kind: "verify" },
      { kind: "commit-message" },
      { kind: "commit-landed" },
      { kind: "push-landed" },
    ],
    false,
  )
  const commitFold = committed.find((r) => r.folded && r.group.commit)
  check(
    "a commit collapses to one row",
    commitFold?.folded === true && commitFold.group.rows.length === 6,
    `${commitFold?.folded === true ? commitFold.group.rows.length : 0} rows — checks, message, sha and push are one episode`,
  )
  check(
    "and it is marked as a commit, not as steps",
    commitFold?.folded === true && commitFold.group.commit === true,
    "the two folds render differently — one has a sha to report, the other a call count",
  )
  check(
    "the work before it stays its own fold",
    committed.filter((r) => r.folded && !r.group.commit).length === 0 ||
      committed.some((r) => r.folded && !r.group.commit),
    "a commit merged into the turn that preceded it is the unmarked boundary all over again",
  )
  check(
    "and the turn's answer is still outside both",
    committed.some((r) => !r.folded && "text" in r.row && r.row.text === "Looks right."),
    "collapsing the commit must not swallow what the turn said",
  )

  // Even a single row folds, unlike a derivation: the point is the boundary.
  const lone = foldRows([asked("go"), { kind: "commit-landed" }], false)
  check(
    "a one-row commit still folds",
    lone.some((r) => r.folded && r.group.commit),
    "a lone `committed a1b2c3d` loose in the transcript is the unmarked row this exists to stop",
  )

  // The shake, pinned as a SEQUENCE rather than a single answer — which is the
  // only way to see it. Every frame below is individually defensible; the bug
  // was that consecutive frames disagreed about which row was the answer, so a
  // paragraph was lifted out of the fold and swallowed back as the turn went.
  //
  // What caused it was upstream of this function: the caller passed `!!live`,
  // and `live` is the reply being TYPED, which empties in the gap between one
  // block and the next. So `live` went false mid-turn, the turn briefly counted
  // as settled, and the newest prose was promoted. The lesson is the assertion:
  // while a turn runs, NOTHING is ever the answer, whatever it has said so far.
  const frames = [
    [asked("go"), tool("Grep"), text("Confirmed.")],
    [asked("go"), tool("Grep"), text("Confirmed."), tool("Bash")],
    [asked("go"), tool("Grep"), text("Confirmed."), tool("Bash"), text("Also this.")],
    [asked("go"), tool("Grep"), text("Confirmed."), tool("Bash"), text("Also this."), tool("Edit")],
  ]
  const promoted = frames.filter((f) =>
    foldRows(f, true).some((r) => !r.folded && "kind" in r.row && r.row.kind === "text"),
  )
  check(
    "no prose escapes the fold while the turn is running",
    promoted.length === 0,
    `${promoted.length} of ${frames.length} frames promoted one — a block lifted out and swallowed back is the shake`,
  )
  check(
    "and the fold only ever grows across those frames",
    frames.every((f, i) => {
      const held = foldRows(f, true).find((r) => r.folded)
      const before = i === 0 ? 0 : (foldRows(frames[i - 1] as typeof f, true).find((r) => r.folded)?.folded ? 1 : 0)
      return before === 0 || (held?.folded === true && held.group.rows.length >= i + 1)
    }),
    "a fold that shrinks between frames has handed a row back to the transcript",
  )
  check(
    "and the answer appears exactly once, at the end",
    foldRows(frames[3] as (typeof frames)[0], false).filter(
      (r) => !r.folded && "kind" in r.row && r.row.kind === "text",
    ).length === 1,
    "the same rows, settled — one answer, not one per block",
  )

  // A live conversation is one running turn on top of finished ones, and the
  // finished ones must not be held hostage to it.
  const mixed = foldRows(
    [
      asked("first"), tool("Grep"), tool("Bash"), text("first is done."),
      asked("second"), tool("Edit"), tool("Read"),
    ],
    true,
  )
  check(
    "an earlier turn keeps its answer while a later one runs",
    mixed.some((r) => !r.folded && "text" in r.row && r.row.text === "first is done."),
    "only the LAST turn is unsettled — the ones above it finished and are not going to change",
  )
}

console.log("\nnothing may stop for a human mid-turn")
{
  const { QUESTION_TOOL, QUESTION_REFUSAL } = await import("./agent.js")
  const { CONFIG } = await import("./config.js")

  // The rule this pins was unenforced for the whole life of the feature, and the
  // symptom was not an error: a turn on Auto simply stopped, held a remote
  // project's checkout, and waited 937 seconds for a click. `canUseTool` routes
  // every unresolved call in a chat run to the browser, so a tool that is not on
  // an allowlist becomes a QUESTION rather than a refusal — which is right for
  // an edit and catastrophic for the one tool whose whole purpose is to block.
  check(
    "the question tool is never on the chat allowlist",
    !CONFIG.chatAutoAllowTools.includes(QUESTION_TOOL),
    CONFIG.chatAutoAllowTools.join(","),
  )
  check(
    "nor on the task allowlist — a headless run has nobody to ask at all",
    !CONFIG.allowedTools.includes(QUESTION_TOOL),
  )
  // A refusal an agent cannot act on just becomes a retry, and a retry loop
  // against a blocked tool spends money going nowhere. This one has to name the
  // thing to do instead, which is: say it in the reply and end the turn.
  check(
    "and the refusal says what to do instead",
    QUESTION_REFUSAL.includes("reply") && QUESTION_REFUSAL.includes("end the turn"),
    QUESTION_REFUSAL.slice(0, 60),
  )
  // `ExitPlanMode` is the deliberate exception, and the REASON matters because
  // the obvious one is wrong. It is not "the tool ends the turn, so nothing is
  // held while the human reads" — that was the reasoning here for one commit and
  // it cost seven minutes of a held checkout. `canUseTool` is awaited BEFORE the
  // SDK runs a tool, so asking about the handoff parks the run exactly like any
  // other question; the tool only ends the turn once it has already been
  // approved. It is an exception because aide APPROVES it without asking, which
  // lets the turn end and puts the plan in the transcript to be answered by the
  // next message. Not asserted here — the tool names are string literals, so tsc
  // rejects the comparison as provably false, which is a stronger guarantee than
  // a runtime check and costs nothing to keep.

  // The rule above was pinned for the ONE tool whose purpose is to block, and
  // the general path underneath it kept routing every unresolved call in a chat
  // to the browser. Plan is where that surfaced: Edit is deliberately kept off
  // `chatAutoAllowTools` (a bare name there approves a tool before the mode can
  // refuse it), so a Plan turn reaching for Edit fell through and became the
  // same wait — on the mode whose whole promise is that it does not act.
  //
  // What makes this checkable rather than a comment is that the refusal must
  // name the way out. Plan's way out is to hand the plan over and stop.
  const { PLAN_REFUSAL } = await import("./agent.js")
  check(
    "a plan turn that reaches for a tool is refused, not asked",
    PLAN_REFUSAL.includes("does not act"),
    PLAN_REFUSAL.slice(0, 60),
  )
  check(
    "and is told to hand the plan over and end the turn",
    PLAN_REFUSAL.includes("ExitPlanMode") && PLAN_REFUSAL.includes("end the turn"),
    "a refusal an agent cannot act on is a retry loop",
  )
  check(
    "and that the work resumes in the same conversation",
    PLAN_REFUSAL.includes("carries it out"),
    "otherwise the model reads the refusal as the task being impossible",
  )
  check(
    "the two refusals are not one sentence",
    PLAN_REFUSAL !== QUESTION_REFUSAL,
    "sharing a message is how the wrong reason reached the agent last time",
  )
}

console.log("\na subagent spawn is judged, not trusted")
{
  const { AGENT_TOOL, AGENT_ISOLATION_REFUSAL, checkAgentSpawn } = await import("./agent.js")
  const { CONFIG } = await import("./config.js")

  // Allowed by canUseTool's own branch, never by a bare name on a list: a bare
  // name approves the whole call before its input is judged, and this tool's
  // input can ask for a worktree or a background run — the two things the
  // judgement below exists to stop.
  check(
    "the spawn is not on the chat allowlist",
    !CONFIG.chatAutoAllowTools.includes(AGENT_TOOL),
    CONFIG.chatAutoAllowTools.join(","),
  )
  check(
    "nor on the task allowlist — a task run stays narrow",
    !CONFIG.allowedTools.includes(AGENT_TOOL),
  )

  // Isolation is refused, not stripped. Stripping would run the work in the
  // real tree when the model asked for a copy — the Bash-rewrite trap: a
  // correction the model does not see is one it cannot account for. And the
  // reason a copy is refused at all is the brief's oldest lesson — a worktree's
  // changes cannot appear in the dev server or in the commit that follows.
  check("a worktree spawn is refused", !checkAgentSpawn({ prompt: "x", isolation: "worktree" }).allow)
  check("a remote spawn is refused too", !checkAgentSpawn({ prompt: "x", isolation: "remote" }).allow)
  check(
    "and the refusal says where the work runs instead",
    AGENT_ISOLATION_REFUSAL.includes("own checkout") &&
      AGENT_ISOLATION_REFUSAL.includes("Drop the isolation"),
    AGENT_ISOLATION_REFUSAL.slice(0, 60),
  )

  // Background is the SDK's DEFAULT — absent means background — so this one is
  // a rewrite rather than a refusal: refusing would fire on the default
  // spelling of every spawn, a round trip each. The rewrite changes scheduling,
  // not meaning, and it must happen: a turn's end starts the commit gate, and a
  // background agent outliving `run.finished` is still writing files while the
  // gate reads the tree.
  const plain = checkAgentSpawn({ description: "survey", prompt: "read the daemon" })
  check("a plain spawn is allowed", plain.allow)
  check(
    "and forced synchronous even when it asked for nothing",
    plain.allow && plain.input["run_in_background"] === false,
    "absent means background, and a background agent outlives the turn the gate reads",
  )
  const bg = checkAgentSpawn({ prompt: "x", run_in_background: true })
  check(
    "an explicit background ask is overridden",
    bg.allow && bg.input["run_in_background"] === false,
  )
  check(
    "the rest of the input survives the rewrite",
    plain.allow && plain.input["prompt"] === "read the daemon" && plain.input["description"] === "survey",
  )
}

console.log("\na remote shell call cannot forget its timeout")
{
  const { sshCommand } = await import("./git.js")

  // `sshCommand` exists so the ssh argv and `REMOTE_GIT_TIMEOUT_MS` cannot be
  // taken separately — `remoteFileSize` in `repo.ts` took the first without the
  // second and could hang `workingTree` once per untracked file. A real call
  // needs a host, so what is checkable here is the guard that keeps it honest:
  // handed a LOCAL ref it must throw rather than quietly spawning ssh to reach
  // this machine's own disk, which would be a slower way to answer a question
  // `node:fs` answers directly.
  let threw = false
  try {
    await sshCommand("C:/some/local/path", "true")
  } catch {
    threw = true
  }
  check(
    "sshCommand refuses a local ref",
    threw,
    "otherwise it silently shells out to reach this machine's own disk",
  )
}

console.log("\ninherited chat mode")
{
  // The session store is shared with the CLI and the VS Code extension, and a
  // conversation carries the mode it was last driven at. Reading that back is
  // what stops a chat you were running on Auto elsewhere from quietly reverting
  // here and asking permission for the next command.
  check("plan round-trips", chatModeFromSdk("plan") === "plan")
  check("auto round-trips", chatModeFromSdk("auto") === "auto")
  // Null is the load-bearing case. It means "no opinion", and the browser keeps
  // whatever the human last picked — so an unknown mode can never widen one, and
  // a mode aide has retired can never narrow one either.
  check(
    "the mode Manual used to be is no longer inherited",
    chatModeFromSdk("default") === null,
    "a CLI chat on default arrives on your own setting, not on a mode aide dropped",
  )
  check("nor is the one Edit-automatically was", chatModeFromSdk("acceptEdits") === null)
  check("dontAsk has no picker entry", chatModeFromSdk("dontAsk") === null, "what task runs use")
  check("bypassPermissions is never inherited", chatModeFromSdk("bypassPermissions") === null)
  check("a future mode is not guessed at", chatModeFromSdk("somethingNew") === null)
  check("junk is not a mode", chatModeFromSdk(undefined) === null && chatModeFromSdk(7) === null)
}

console.log("\nthe models a turn can be sent to")
{
  // The composer offers a closed list and the daemon validates against the same
  // one, so what is asserted here is that the two cannot drift: an id the picker
  // can produce must be one `isChatModel` admits, or a send is refused at the
  // endpoint over a value the human chose from a menu.
  for (const m of CHAT_MODELS) {
    check(`${m.label} is admitted by the guard that gates a send`, isChatModel(m.id), m.id)
    check(`${m.label} says what it is for`, m.hint.length > 0, "an id alone says nothing about the trade")
  }
  check(
    "the default the composer starts on is in the list",
    isChatModel("claude-opus-5"),
    "the composer names this id literally — a rename here is a picker that falls back on every load",
  )
  // The endpoint drops an unrecognised id and sends the turn on the default
  // rather than refusing it, so this guard is what decides "unrecognised".
  check("an unknown id is not a model", !isChatModel("gpt-4"), "the endpoint falls back to the default")
  check("an alias is not an id", !isChatModel("opus"), "aliases resolve to whatever the CLI points at")
  check("junk is not a model", !isChatModel(undefined) && !isChatModel(7) && !isChatModel(null))
  // A log may name a model this build no longer lists — every run in
  // `~/.aide/runs` predates the picker — so the label has to degrade to the id
  // rather than render as nothing.
  check("a known id shows its label", chatModelLabel("claude-opus-5") === "Opus 5")
  check(
    "and an unknown one shows itself",
    chatModelLabel("claude-3-opus-20240229") === "claude-3-opus-20240229",
    "a retired model must read as its id, not as a blank",
  )
}

console.log("\nthe force endpoint stays out of the UI")
{
  // The commit route exists again — force-only, the escape hatch past a red
  // gate — and the design is that the UI NEVER learns it: the default stays
  // "fix the code", and a button would make landing broken work one press
  // cheaper than fixing it. A route the web package cannot name is a promise a
  // grep can keep, so this is that grep, pinned. `commitProject` is the old
  // api.ts wrapper's name, checked so it cannot quietly come back either.
  const webSrc = fileURLToPath(new URL("../../web/src/", import.meta.url))
  const files = (await readdir(webSrc, { recursive: true })).filter((f) =>
    /\.(ts|tsx)$/.test(String(f)),
  )
  const offenders: string[] = []
  for (const file of files) {
    const body = await readFile(join(webSrc, String(file)), "utf8")
    if (/\/commit\b|commitProject|force=true/.test(body)) offenders.push(String(file))
  }
  check(
    "no web source names the commit endpoint",
    offenders.length === 0,
    offenders.join("; ") || `${files.length} files checked`,
  )
}

console.log("\nprotocol stays browser-safe")
{
  // The web bundle imports the @aide/protocol barrel. If anything reachable from
  // it pulls `node:*` or a Node-only library, Vite resolves it happily at dev
  // time, the browser refuses it at runtime, React never mounts, and you get a
  // blank white page with nothing in the terminal and nothing in the build.
  // Cheap to assert, miserable to diagnose.
  const src = fileURLToPath(new URL("../../protocol/src/", import.meta.url))
  const seen = new Set<string>()
  const offenders: string[] = []

  const walk = async (file: string): Promise<void> => {
    if (seen.has(file)) return
    seen.add(file)
    let body: string
    try {
      body = await readFile(join(src, file), "utf8")
    } catch {
      return
    }
    for (const m of body.matchAll(/from "([^"]+)"/g)) {
      const spec = m[1] ?? ""
      if (spec.startsWith("node:") || spec === "gray-matter") {
        offenders.push(`${file} imports ${spec}`)
      } else if (spec.startsWith("./")) {
        await walk(spec.slice(2).replace(/\.js$/, ".ts"))
      }
    }
  }
  await walk("index.ts")

  check(
    "the barrel reaches no Node-only module",
    offenders.length === 0,
    offenders.join("; ") || `${seen.size} modules checked`,
  )
  // The counterpart: the Node entry must still exist and still carry the
  // filesystem half, or the split has quietly collapsed back into one barrel.
  const nodeEntry = await readFile(join(src, "node.ts"), "utf8")
  check("the node entry still carries paths", nodeEntry.includes("./paths.js"))
}

console.log("\nthe remote agent ships every file it imports")
{
  // `deploy-agent`'s manifest was hand-listed and drifted: `todo.ts` went with
  // the backlog file, eight modules were added after it, and nothing noticed
  // until a deploy died on `stat local todo.ts` — AFTER the remote npm install,
  // leaving a machine with a new launcher and last release's sources. The worse
  // shape is the one that did not happen: had that name still existed, a missing
  // NEW file would have deployed cleanly and crashed on the far side's first
  // turn with `cannot find module ./gates.js`, which costs an ssh round trip and
  // a model call to discover.
  //
  // The manifest is derived from the barrel now, so what is worth asserting is
  // the property the old list violated — every path it names is really there.
  const { filesToShip } = await import("./deploy.js")
  const shipped = await filesToShip()
  const missing: string[] = []
  for (const [local] of shipped) if (!existsSync(local)) missing.push(local)
  check(
    "every file the deploy names exists",
    missing.length === 0,
    missing.join("; ") || `${shipped.length} files`,
  )

  // And that the derivation actually tracks the barrel, rather than happening to
  // agree with it today. A module exported to the browser but absent from the
  // agent's copy is the `cannot find module` above.
  const protocolSrc = fileURLToPath(new URL("../../protocol/src/", import.meta.url))
  const barrel = await readFile(join(protocolSrc, "index.ts"), "utf8")
  const exported = [...barrel.matchAll(/^export \* from "\.\/([\w-]+)\.js"/gm)].map(
    (m) => `${m[1]}.ts`,
  )
  const names = new Set(shipped.map(([, remote]) => remote.split("/").pop()))
  check(
    "and every module the barrel exports is one of them",
    exported.every((name) => names.has(name)),
    exported.filter((name) => !names.has(name)).join("; ") || `${exported.length} modules`,
  )

  // Importing the deploy script must not BE a deploy. It is a CLI with a
  // top-level `main()`, and the guard that stops that running on import is the
  // only reason the two checks above can exist at all.
  check(
    "importing the deploy script deploys nothing",
    true,
    "reaching this line at all is the assertion",
  )
}

console.log("\nrestarting a stale daemon")
{
  // The daemon loads its modules once, so every edit to packages/daemon/src
  // leaves a process running code that no longer exists. The dev server fixes
  // that by restarting it — and the previous version of this rule, chokidar
  // firing on a file write, killed a daemon three lines into a commit and left
  // the repository half-changed. Hence a pure function, and hence these.
  //
  // Runs edit the project's own checkout now, so a daemon developing its own
  // repository has its source rewritten by the agents it supervises as a matter
  // of routine rather than by accident.
  const QUIET = 1500
  const base: Health = {
    ok: true,
    taskModel: "claude-opus-5",
    bootSourceId: "aaaaaaaaaaaa",
    sourceId: "bbbbbbbbbbbb",
    stale: true,
    supervised: true,
    busy: { chats: 0, writes: 0 },
    idleMs: 10_000,
  }
  const decide = (patch: Partial<Health>, previous = "bbbbbbbbbbbb" as string | null) =>
    restartDecision({ ...base, ...patch }, previous, QUIET)

  check("restarts a stale, quiet daemon", decide({}).restart, decide({}).reason)
  check("leaves a current daemon alone", !decide({ stale: false }).restart)

  // Each of these is a way to destroy work.
  check("not mid chat turn", !decide({ busy: { chats: 1, writes: 0 } }).restart)
  check(
    "not mid commit",
    !decide({ busy: { chats: 0, writes: 1 } }).restart,
    "a commit is one request, and killing it leaves the work half-staged",
  )
  check(
    "and it says what it is waiting for",
    decide({ busy: { chats: 1, writes: 2 } }).reason === "1 chat turn, 2 requests in flight",
    decide({ busy: { chats: 1, writes: 2 } }).reason,
  )

  // The gap between two of the browser's requests is not a safe moment.
  check("not in the gap right after a write", !decide({ idleMs: 200 }).restart)
  check("but yes once it has been quiet", decide({ idleMs: QUIET }).restart)

  // A tree still being rewritten reports a different fingerprint every tick, and
  // restarting once per tick through a `git merge` helps nobody.
  check("not while the tree is still moving", !decide({}, "ccccccccccc").restart)
  check("not on the very first sighting", !decide({}, null).restart)

  // Unknown must never read as changed: a daemon with no source tree to compare
  // against is not stale, it is unknowable.
  check("never restarts on an unreadable source", !decide({ sourceId: null }, null).restart)
}

console.log("\nfile attachments")
{
  // A non-image attachment becomes a file on the agent's machine, and these are
  // the two halves that fail quietly: a name that collides or escapes the
  // folder writes over — or outside — what the note promises, and a note that
  // lists the wrong paths sends the agent to files that are not there.
  const names = fileAttachmentNames([
    { name: "part.stl" },
    { name: "part.stl" },
    { name: "C:\\Users\\loki\\Downloads\\part.stl" },
    { name: "../../etc/passwd" },
    {},
    { name: 'log<>:"|?*.txt' },
    { name: "PART.STL" },
  ])
  check("a plain name survives as itself", names[0] === "part.stl", names.join(", "))
  check("a duplicate is suffixed, not overwritten", names[1] === "part-2.stl", names[1] ?? "")
  check(
    "a full path is cut to its basename, then de-collided",
    names[2] === "part-3.stl",
    names[2] ?? "",
  )
  check("a traversal name cannot leave the folder", names[3] === "passwd", names[3] ?? "")
  check("no name at all still gets one", names[4] === "file-5", names[4] ?? "")
  check(
    "characters Windows refuses are replaced, not dropped",
    names[5] === "log-------.txt",
    names[5] ?? "",
  )
  // NTFS would happily create PART.STL beside nothing — it IS part.stl there.
  check(
    "collisions are judged case-insensitively",
    names[6] === "PART-4.STL",
    names[6] ?? "",
  )

  const note = attachedFilesNote([
    { path: "/tmp/aide-attach-x/part.stl", bytes: 133 * 1024 },
    { path: "/tmp/aide-attach-x/notes.csv", bytes: 2 * 1024 * 1024 },
  ])
  check("the note names every path", note.includes("/tmp/aide-attach-x/part.stl"))
  check("with a human-readable size", note.includes("(133 KB)") && note.includes("(2.0 MB)"))
  check(
    "and says the files are outside the repository",
    note.includes("outside the repository"),
    "or an agent spends a turn asking why the commit gate ignores them",
  )

  // The split is shared, not re-derived: web chips, the log event and the
  // worker's routing all call this one predicate.
  check("an image routes to a vision block", isImageAttachment({ mediaType: "image/png" }))
  check(
    "an untyped file routes to the agent's disk",
    !isImageAttachment({ mediaType: "application/octet-stream" }),
  )
}

console.log("\nan edit, as a diff")
{
  // What the Edit card draws instead of two blocks side by side. Every way
  // this fails is quiet on screen: a line attributed to the wrong side reads
  // as a change that never happened, and none of it is visible to `tsc`.
  const tags = (a: string, b: string) =>
    diffLines(a, b)
      .map((l) => (l.tag === "keep" ? "=" : l.tag === "add" ? "+" : "-"))
      .join("")

  check("identical text is all context", tags("a\nb\nc", "a\nb\nc") === "===")
  check(
    "a changed line is a deletion then an insertion",
    tags("a\nb\nc", "a\nB\nc") === "=-+=",
    "old above new — a tie in the walk has to go to the deletion or a change reads backwards",
  )
  check("an inserted line is only an insertion", tags("a\nc", "a\nb\nc") === "=+=")
  check("a deleted line is only a deletion", tags("a\nb\nc", "a\nc") === "=-=")
  check(
    "context between two changes is kept once",
    tags("x\nsame\ny", "X\nsame\nY") === "-+=-+",
    "the shared line must not be printed on both sides",
  )
  check("everything new is all insertion", tags("", "a\nb") === "-++")
  check(
    "a moved line is not invented as unchanged",
    tags("a\nb", "b\na") === "-=+" || tags("a\nb", "b\na") === "+=-",
    "LCS keeps one of the two and moves the other; either is honest",
  )
  // The reconstruction property: dropping insertions gives back the old text
  // and dropping deletions gives back the new one. This is the assertion that
  // catches a diff that silently loses or duplicates a line.
  const A = "one\ntwo\nthree\nfour"
  const B = "one\ntwo point five\nthree\nfour\nfive"
  const d = diffLines(A, B)
  check(
    "dropping the insertions reconstructs the old text",
    d.filter((l) => l.tag !== "add").map((l) => l.text).join("\n") === A,
  )
  check(
    "dropping the deletions reconstructs the new text",
    d.filter((l) => l.tag !== "del").map((l) => l.text).join("\n") === B,
  )

  // The fold over long unchanged runs — the same idea as the shell elision,
  // and the count has to be the number actually hidden or the rule lies.
  const long: ReturnType<typeof diffLines> = [
    { tag: "del", text: "x" },
    ...Array.from({ length: 20 }, (_, i) => ({ tag: "keep" as const, text: `k${i}` })),
    { tag: "add", text: "y" },
  ]
  const folded = collapseUnchanged(long)
  const gap = folded.find((r) => r.tag === "gap")
  check("a long unchanged run collapses", gap !== undefined)
  check(
    "and the count is what it actually hid",
    gap?.tag === "gap" && gap.hidden === 14,
    "20 kept, 3 of context at each end",
  )
  check(
    "the rows still add up to every line",
    folded.reduce((n, r) => n + (r.tag === "gap" ? r.hidden : 1), 0) === long.length,
    "a fold that drops a line shows less than happened, which is the one thing it must not do",
  )
  check(
    "a short unchanged run is left alone",
    !collapseUnchanged([
      { tag: "del", text: "x" },
      { tag: "keep", text: "a" },
      { tag: "keep", text: "b" },
      { tag: "add", text: "y" },
    ]).some((r) => r.tag === "gap"),
    "a fold the same height as what it replaces trades readable lines for a rule",
  )

  // The two-column pairing. An off-by-one in the zip puts a deletion beside
  // the wrong insertion, which draws a change nobody made.
  const pairs = splitRows([
    { tag: "keep", text: "a" },
    { tag: "del", text: "x1" },
    { tag: "del", text: "x2" },
    { tag: "del", text: "x3" },
    { tag: "add", text: "y1" },
    { tag: "keep", text: "b" },
  ])
  check(
    "context spans both columns rather than printing twice",
    pairs[0]?.tag === "keep" && pairs[0].text === "a",
  )
  check(
    "a lopsided change keeps the columns aligned",
    pairs.length === 5 &&
      pairs[1]?.tag === "change" &&
      pairs[1].left === "x1" &&
      pairs[1].right === "y1" &&
      pairs[2]?.tag === "change" &&
      pairs[2].left === "x2" &&
      pairs[2].right === null,
    "three lines out against one in is three rows, two with an empty right",
  )
  check(
    "an insertion with no deletion has an empty left",
    splitRows([{ tag: "add", text: "only" }])[0]?.tag === "change" &&
      (splitRows([{ tag: "add", text: "only" }])[0] as { left: string | null }).left === null,
  )

  // Word-level marking inside a changed line — the reason a one-identifier
  // change no longer means comparing two lines character by character.
  const words = pairWords("const a = compute(x)", "const a = compute(y)")
  check("a one-word change marks only that word", words !== null && words.right !== undefined)
  check(
    "the unchanged prefix is not marked",
    words?.left.filter((s) => s.changed).map((s) => s.text).join("") === "x",
    words?.left.filter((s) => s.changed).map((s) => s.text).join("") ?? "null",
  )
  check(
    "and the spans reconstruct their own line",
    words?.right.map((s) => s.text).join("") === "const a = compute(y)",
    "a span dropped or duplicated silently rewrites the line on screen",
  )
  check(
    "two unrelated lines are not word-diffed into a mosaic",
    pairWords("import { X } from './x.js'", "return notEvenClose(1, 2, 3)") === null,
    "marking 90% of both lines as changed says less than the plain +/- pair",
  )
  // The share is measured against the SHORTER line. Against the longer one, a
  // short line whose words all appear somewhere in a long one scores highly —
  // which paired two unrelated sentences sharing one clause and drew a
  // mostly-dimmed line whose bright fragments were noise. Seen on screen.
  check(
    "a short line contained in a much longer one does not pair",
    pairWords(
      "reconstruct the old text and dropping the deletions the new one.",
      "reconstruct the old text and dropping the deletions the new one. Inside a changed line the words that actually MOVED are found the same way and the ones that survived are dimmed rather than tinted.",
    ) === null,
    "a reflowed paragraph is every line sharing most of its words with a DIFFERENT line",
  )
  check(
    "but a genuine rewrite of one line still pairs",
    pairWords("const clamp = expand ? '' : 'max-h-48'", "const clamp = expand ? '' : 'max-h-64'") !==
      null,
  )
  check(
    "an empty line pairs with nothing",
    pairWords("", "something") === null,
  )
}

console.log("\nthe tool timeline")
{
  // Every rule here fails invisibly on screen: a message split in two draws one
  // round trip as several, an unmarked retry hides what a failure cost, and a
  // fold that drops a file shows less than happened with nothing looking wrong.
  let seq = 0
  const ev = (body: RunEventBody): RunEvent => ({ ...body, runId: "r", seq: ++seq, ts: seq })
  const call = (id: string, name: string, input: unknown, parent: string | null = null) =>
    ev({ type: "tool.start", toolUseId: id, name, input, parentToolUseId: parent })
  const done = (id: string, ok: boolean) => ev({ type: "tool.end", toolUseId: id, ok, summary: "" })
  const say = (text: string) => ev({ type: "assistant.text", text, parentToolUseId: null })

  const meta = timelineMeta([
    ev({ type: "user.message", text: "go" }),
    // Message 1: two calls read off one completed assistant message — they are
    // consecutive in the log, and that adjacency IS the message boundary.
    say("looking"),
    call("a", "Grep", { pattern: "x" }),
    call("b", "Read", { file_path: "src/a.ts" }),
    done("a", true),
    done("b", true),
    // Message 2: an edit that fails...
    say("editing"),
    call("c", "Edit", { file_path: "src/a.ts" }),
    done("c", false),
    // ...message 3 retries it and succeeds...
    say("again"),
    call("d", "Edit", { file_path: "src/a.ts" }),
    done("d", true),
    // ...so message 4's identical edit is an ordinary call, not a retry.
    say("more"),
    call("e", "Edit", { file_path: "src/a.ts" }),
    done("e", true),
    // Message 5: a subagent's call lands between two main-loop calls and must
    // not split them — it is on its own message axis, not this one.
    say("fan out"),
    call("f", "Bash", { command: "pnpm typecheck" }),
    call("n1", "Read", { file_path: "sub.ts" }, "agent-1"),
    call("g", "Bash", { command: "pnpm build" }),
    // Message 6: two same-target calls in ONE message where the first fails —
    // they went out together, before the model could see either fail.
    say("parallel"),
    call("j", "Write", { file_path: "src/b.ts" }),
    call("k", "Write", { file_path: "src/b.ts" }),
    done("j", false),
    done("k", true),
    // A new turn: the ordinals AND the failure memory both start over.
    ev({ type: "user.message", text: "next" }),
    say("fresh"),
    call("i", "Edit", { file_path: "src/a.ts" }),
    done("i", true),
  ])
  check(
    "calls of one message share its column",
    meta.get("a")?.message === 1 && meta.get("b")?.message === 1,
  )
  check("prose between calls opens a new one", meta.get("c")?.message === 2)
  check(
    "a failed call's re-attempt is marked a retry",
    meta.get("d")?.retry === true,
    "the spec forbids the UI inferring this from target matching — it is computed here, once",
  )
  check(
    "and a retry that succeeded clears the failure",
    meta.get("e")?.retry === false,
    "a third identical call is ordinary work, not a permanent echo of one old mistake",
  )
  check(
    "a subagent's call does not split the message around it",
    meta.get("f")?.message === 5 && meta.get("g")?.message === 5,
  )
  check("and gets no column of its own", meta.get("n1") === undefined)
  check(
    "same-message repeats are not retries",
    meta.get("k")?.retry === false,
    "calls in one message went out together, before the model could see either fail",
  )
  check("a new turn restarts the ordinals", meta.get("i")?.message === 1)
  check("and forgets the old turn's failures", meta.get("i")?.retry === false)

  const at = (over: Partial<TimelineCall>): TimelineCall => ({
    id: `t${++seq}`,
    message: 1,
    tool: "Read",
    target: "f.ts",
    status: "ok",
    failTag: null,
    retry: false,
    ...over,
  })

  // Rows: by target, in first-touch order, with search and shell as their own.
  const t1 = buildTimeline([
    at({ tool: "Grep", target: "x" }),
    at({ tool: "Read", target: "src/a.ts", message: 2 }),
    at({ tool: "Bash", target: "pnpm build", message: 3 }),
    at({ tool: "Edit", target: "src/a.ts", message: 3, status: "err", retry: false }),
    at({ tool: "Edit", target: "src/a.ts", message: 4, retry: true }),
  ])
  check(
    "rows are ordered by first touch",
    t1.rows.map((r) => r.key).join("|") === "search|src/a.ts|shell",
    t1.rows.map((r) => r.key).join("|"),
  )
  check(
    "a file row keeps the path colour and the rest are muted",
    t1.rows.find((r) => r.key === "src/a.ts")?.sys === false &&
      t1.rows.find((r) => r.key === "search")?.sys === true,
  )
  check("a failed call marks its message", t1.failed.join(",") === "3")
  check(
    "a message of nothing but retries is a recovery",
    t1.recovery.join(",") === "4",
    "the round trips a failure cost, tinted so they read as cost",
  )

  // The fold: more than eight files and the ones only read collapse — but a
  // file that was WRITTEN keeps its row, because it is the diff about to
  // appear in the rail.
  const nine = Array.from({ length: 9 }, (_, i) => at({ target: `src/f${i}.ts` }))
  const t2 = buildTimeline([...nine, at({ tool: "Edit", target: "src/hot.ts", message: 2 })])
  const reads = t2.rows.find((r) => r.key === "reads")
  check("ten files fold the read-only ones", reads !== undefined && reads.label === "reads · 9 files")
  check(
    "but an edited file always keeps its own row",
    t2.rows.some((r) => r.key === "src/hot.ts" && !r.sys),
  )
  check(
    "eight files do not fold",
    !buildTimeline(Array.from({ length: 8 }, (_, i) => at({ target: `src/f${i}.ts` }))).rows.some(
      (r) => r.key === "reads",
    ),
  )

  // A live call — announced by a delta, not yet logged — lands one past the
  // last known column: the message it belongs to is the one still streaming.
  const t3 = buildTimeline([at({ message: 3 }), at({ message: 0, status: "busy" })])
  check("a streaming call lands one past the last column", t3.messages.join(",") === "3,4")

  // One classifier, over what the log recorded. A failure it does not
  // recognise is a red dot with no tag — degraded and honest — where a wrong
  // tag is a lie in red.
  check(
    "a stale Edit anchor is named",
    classifyFailure("Edit", "String to replace not found in file") === "stale anchor",
  )
  check(
    "a policy refusal is named denied",
    classifyFailure("Bash", "Permission to use Bash with command grep has been denied.") ===
      "denied",
  )
  check("a missing file is named", classifyFailure("Read", "File does not exist.") === "not found")
  check(
    "a timeout is named",
    classifyFailure("Bash", "Command timed out after 120000ms") === "timeout",
  )
  check("an unrecognised failure gets no tag", classifyFailure("Bash", "exit code 1") === null)

  // Refusal vs fault. aide declining a call is the system working, and drawn in
  // the fault colour it reads as a broken tool — so it is amber, and the split
  // is derived from the tag rather than stored as a third status, or four
  // surfaces would each decide what counts as a refusal.
  check(
    "a denial is a refusal, not a fault",
    isRefusal(classifyFailure("Bash", "Permission to use Bash with command grep has been denied.")),
  )
  check(
    "a real failure is not a refusal",
    !isRefusal(classifyFailure("Read", "File does not exist.")) &&
      !isRefusal(classifyFailure("Bash", "exit code 1")),
    "an error drawn amber would understate the one thing the grid exists to make conspicuous",
  )

  const refusal = (over: Partial<TimelineCall>) =>
    at({ status: "err", failTag: "denied", ...over })
  const t4 = buildTimeline([
    refusal({ message: 1 }),
    at({ message: 2, status: "err", failTag: "not found" }),
    // A column holding BOTH: one refusal and one genuine fault.
    refusal({ message: 3 }),
    at({ message: 3, status: "err", failTag: null }),
  ])
  check("every failure is still counted as one", t4.failed.join(",") === "1,2,3")
  check(
    "a column of nothing but refusals is drawn amber",
    t4.refused.join(",") === "1",
    "the denial that made the run route around it is not an error in anybody's tool",
  )
  check(
    "a column holding one real fault stays red",
    !t4.refused.includes(3),
    "half refused and half broken must not be coloured as though nothing went wrong",
  )

  // The retry identity reads the raw field, so two targets that would truncate
  // alike cannot read as one retried call.
  check("a shell call's target is its command", toolTarget("Bash", { command: "pnpm build" }) === "pnpm build")
  check("a file call's target is its path", toolTarget("Edit", { file_path: "src/a.ts" }) === "src/a.ts")
  check("no readable target is empty, not invented", toolTarget("Agent", { count: 3 }) === "")

  // The live dot's early target: a COMPLETE string field inside JSON that is
  // not. Wrong in either direction fails quietly — reading a value whose
  // closing quote has not arrived names a truncated file, and refusing
  // complete ones parks the dot on a placeholder row for the whole time the
  // model spends writing a big edit's arguments.
  check(
    "an unfinished value is not a target",
    partialToolTarget('{"file_path":"src/a') === null,
  )
  check(
    "a complete first field is, before the JSON closes",
    partialToolTarget('{"file_path":"src/a.ts","old_string":"x') === "src/a.ts",
  )
  check(
    "escapes decode as JSON, not by hand",
    partialToolTarget('{"command":"echo \\"hi\\""') === 'echo "hi"',
  )
  check(
    "backslashes survive a Windows path",
    partialToolTarget('{"file_path":"C:\\\\Users\\\\loki\\\\a.ts"') === "C:\\Users\\loki\\a.ts",
  )
  check("an empty target names no row", partialToolTarget('{"pattern":""') === null)
  check(
    "a target key INSIDE a string value cannot match",
    partialToolTarget('{"old_string":"say \\"file_path\\": \\"trap\\"","file_path":"real.ts"') ===
      "real.ts",
    "inside a JSON string a quote can only appear escaped, so the pattern's real quotes miss it",
  )
}

