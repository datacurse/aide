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
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  SUMMARY_FENCE,
  chatModeFromSdk,
  currentActivity,
  foldRows,
  formatLocation,
  parseLocation,
  parseTurnSummary,
  PerProjectMemo,
  planChecks,
  projectGates,
  restartDecision,
  splitHiddenColumns,
  stripPartialTurnSummary,
  stripTurnSummary,
  withHidden,
  type Health,
  type RunEvent,
  type RunEventBody,
} from "@aide/protocol"
import { parseProjectDoc } from "@aide/protocol/node"
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
  check("denies a pipe", !verdict("pnpm ls | head").allow)
  check("denies chaining", !verdict("cd packages && pnpm test").allow)
  check("denies substitution", !verdict("pnpm $(echo dev)").allow, "the payload hides in the arg")
  check("denies backticks", !verdict("pnpm `echo dev`").allow)
  check("denies redirection", !verdict("pnpm ls > /tmp/x").allow)
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

  // Only at the START. `git log | head` is paging a git call rather than reading
  // a file, and a rule matching anywhere in the string would refuse it for the
  // word `head`. That command is refused here anyway — a pipe is a shell
  // metacharacter and loses to the blunter rule above it — so what is checkable
  // is the reason: it must be the pipe that stops it, not the pager, or the
  // refusal sends the agent to Read for a command that has no file in it.
  const paged = checkBashCommand("git log --oneline | head -20", null, [])
  check(
    "a pager after a real command is refused for its pipe, not for being a read",
    !paged.allow && paged.reason.includes("shell operators") && !paged.reason.includes("Read"),
    paged.reason.slice(0, 60),
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
  const { FILE_TOOL_COMMANDS } = await import("./policy.js")
  const { fastBashSettings } = await import("./agent.js")
  const denied = fastBashSettings(["pnpm dev"]).permissions?.deny ?? []

  for (const { prefix } of FILE_TOOL_COMMANDS) {
    check(
      `the Auto layer denies ${prefix} too`,
      denied.includes(`Bash(${prefix})`) && denied.includes(`Bash(${prefix} *)`),
      "otherwise Bash(*) resolves it before the policy is consulted",
    )
  }
  check(
    "and still denies what it always did",
    denied.includes("Bash(pnpm dev)") && denied.includes("Bash(git commit)"),
    "the file-tool prefixes are an addition, not a replacement",
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
  // The blunt half of the rule survives the allowlist going away, and it has to:
  // an unattended run is exactly where `pnpm ls; git push` must not resolve to
  // an allowed leading word.
  check("denies chaining past a denied command", !verdict("pnpm ls; git push").allow)
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
    "a human-only refusal says whose the commit is",
    commitReason.includes("human") && commitReason.includes("presses commit"),
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
  // ONE memo slot and was correct while one project was on screen; the wall draws
  // a column per project, and interleaved reads made them evict each other, so
  // every read missed and the page went grey about half a second after it
  // painted. Nothing about that is visible to `tsc` or to the build.
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
    "one slot for two projects is the render loop that greyed the wall",
  )
  check("nor the second by going back", memo.read(source, "p2", rows) === other)
  check("so interleaving computes nothing new", computed === 2, String(computed))

  // Three passes of two columns, which is what a wall actually does.
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

console.log("\nwhere you are, as a URL")
{
  // `parseLocation` and `formatLocation` are inverses, and a broken round trip
  // is not an error anywhere — it is a reload landing somewhere you did not ask
  // for, which reads as the app forgetting what you had open rather than as a
  // parser bug. That is why these live in protocol rather than beside the hook.
  //
  // Asserted as STABILITY rather than as byte-equality with the input: a page
  // with no project formats as `#/wall/`, so a bare `#/wall` is a different
  // spelling of the same place and comparing against the input would be testing
  // the spelling rather than the inverse. What has to hold is that formatting
  // again changes nothing — that is what makes the effect in `useAppLocation`
  // settle instead of rewriting the URL on every render.
  const trip = (hash: string) => formatLocation(parseLocation(hash))
  for (const hash of [
    "#/",
    "#/p/abc",
    "#/p/abc/session-1",
    "#/p/abc/new/new-xyz",
    "#/activity",
    "#/activity/p/abc/session-1",
    "#/wall",
    "#/wall/p/abc/session-1",
    "#/wall/p/abc/new/new-xyz",
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
    "#/wall/p/abc/session-1",
  ]) {
    check(`${hash} survives verbatim`, trip(hash) === hash, trip(hash))
  }

  // The whole-window pages are PREFIXES, so what is underneath survives — which
  // is what lets closing either one put you back exactly where you were.
  const under = parseLocation("#/wall/p/abc/session-1")
  check("the wall keeps the project underneath it", under.projectId === "abc")
  check("and the chat", under.sessionId === "session-1")
  check("and says it is open", under.wall && !under.activity)

  // Two whole-window pages cannot both be open. A hand-written URL naming both
  // has to resolve to one of them rather than to some third state.
  const both = parseLocation("#/activity/wall/p/abc")
  check(
    "a URL naming both pages opens exactly one",
    both.activity !== both.wall,
    JSON.stringify({ activity: both.activity, wall: both.wall }),
  )

  // A bare page is a complete location: both are about every project, so neither
  // needs one. Testing only for a project id would drop it.
  check("a bare wall URL is a location", parseLocation("#/wall").wall === true)
  check("with no project", parseLocation("#/wall").projectId === null)

  // Layouts this app has already outgrown. The mirror in localStorage outlives
  // them, so they land on the project rather than on nothing.
  check("an old chats URL still finds its project", parseLocation("#/p/abc/chats/s1").projectId === "abc")
  check("and its chat", parseLocation("#/p/abc/chats/s1").sessionId === "s1")
  check("a retired board URL opens the project", parseLocation("#/p/abc/board").projectId === "abc")
  check("with nothing open", parseLocation("#/p/abc/board").sessionId === null)

  check("nonsense is not a project", parseLocation("#/nonsense").projectId === null)
}

console.log("\nwhat a project's gates refuse")
{
  // These four answers used to be computed inline in `App.tsx` for the one open
  // project. The wall draws a column per project and needs them for every one,
  // and a second implementation of "is this project blocked" is the shape that
  // produced the wedge in the brief — a block reading one object while the button
  // that releases it reads another. Asserted here because a component cannot be.
  const held = (title: string) => `"${title}" has it`
  const holder = { runId: "run-1", title: "a chat" }

  const free = projectGates({ holder: null, uncommitted: 0, held })
  check("a free, clean project refuses nothing", !free.start && !free.commit && !free.send)

  const dirty = projectGates({ holder: null, uncommitted: 3, held })
  check("uncommitted work stops a new chat", dirty.start?.includes("3 uncommitted files") === true, String(dirty.start))
  check(
    "but never the commit that would clear it",
    dirty.commit === null,
    "a commit button locked by the dirt it exists to remove is a gate with no release",
  )

  // The ORDER, which is the rule most easily lost: a held checkout is nearly
  // always dirty too, and "commit that work" cannot be followed while a run has
  // the repo, because the commit button is locked by the same holder.
  const both = projectGates({ holder, uncommitted: 3, held })
  check(
    "a holder is named before the dirt it is also causing",
    both.start === held("a chat"),
    "naming the files first sends you to a button this same holder has locked",
  )

  // The commit's own run must not lock its own button. `committing` is derived
  // from the lock the daemon publishes, so without this exemption the button
  // reads as blocked by itself from the moment it is pressed.
  const mine = projectGates({ holder, uncommitted: 3, commitRunId: "run-1", held })
  check("the commit I started does not block my commit button", mine.commit === null)
  check("nor my push", mine.push === null)
  check(
    "but it still blocks a NEW chat",
    mine.start === held("a chat"),
    "the daemon refuses a fresh turn under any holder, ours included",
  )

  // The composer's half. The turn on screen is the one you can interrupt; a run
  // anywhere else is the one you must wait for, and they are told apart by run
  // id rather than by session — a commit attributed to this conversation is not
  // this conversation's turn.
  const watching = projectGates({ holder, uncommitted: 0, openRunId: "run-1", held })
  check("the turn I am watching does not lock its own box", watching.send === null)
  const elsewhere = projectGates({ holder, uncommitted: 0, openRunId: "run-9", held })
  check("a run somewhere else does", elsewhere.send === held("a chat"))

  // The tree stops only a chat that has NOT started, because the way out of it is
  // to finish the chat that made it — and a chat whose own turn is in flight is
  // exempt separately, since for its first seconds it has no session id while its
  // own edits are already piling up.
  check(
    "uncommitted work does not stop a chat that has run",
    projectGates({ holder: null, uncommitted: 3, started: true, held }).send === null,
  )
  check(
    "nor one whose own turn is in flight",
    projectGates({ holder: null, uncommitted: 3, busy: true, held }).send === null,
    "a new chat has no session id for its first few seconds",
  )
  check(
    "but it does stop an unstarted, idle one",
    projectGates({ holder: null, uncommitted: 3, held }).send !== null,
  )

  check(
    "one file is not pluralised",
    projectGates({ holder: null, uncommitted: 1, held }).start?.includes("1 uncommitted file —") === true,
  )
}

console.log("\ncolumns the wall is not drawing")
{
  const projects = [{ id: "a" }, { id: "b" }, { id: "c" }]

  const none = splitHiddenColumns(projects, [])
  check("nothing hidden draws everything", none.shown.length === 3 && none.hiddenCount === 0)

  const one = splitHiddenColumns(projects, ["b"])
  check(
    "a hidden project is not drawn",
    one.shown.map((p) => p.id).join(",") === "a,c",
    one.shown.map((p) => p.id).join(","),
  )
  check("and is counted", one.hiddenCount === 1)

  // The header's number and the missing columns are the SAME arithmetic, and
  // this is the case that separates them. A duplicate id is reachable from two
  // tabs or a hand-edited value, and counting the stored list would report two
  // hidden columns while only one is absent from the page — a "2 hidden" that
  // restores one column when pressed.
  const dupe = splitHiddenColumns(projects, ["b", "b"])
  check(
    "a duplicate id counts once",
    dupe.hiddenCount === 1 && dupe.shown.length === 2,
    `${dupe.hiddenCount} hidden, ${dupe.shown.length} shown`,
  )

  // The other way the two drift: a project hidden and then FORGOTTEN. Its id
  // stays in the stored set forever, and counting the set would keep offering to
  // restore a column that no longer exists.
  const stale = splitHiddenColumns(projects, ["b", "gone"])
  check(
    "an id for a forgotten project counts for nothing",
    stale.hiddenCount === 1,
    "otherwise the header offers to restore a column that cannot come back",
  )

  // The property both of the above are instances of, stated directly: whatever
  // is stored, the two halves partition the projects. This is what lets the wall
  // draw one and count the other without them ever disagreeing.
  for (const ids of [[], ["a"], ["a", "a"], ["a", "b", "c"], ["nope"], ["c", "nope", "c"]]) {
    const { shown, hiddenCount } = splitHiddenColumns(projects, ids)
    check(
      `shown + hidden is every project (${ids.join("|") || "none"})`,
      shown.length + hiddenCount === projects.length,
      `${shown.length} + ${hiddenCount} of ${projects.length}`,
    )
  }

  // Hiding everything is legal and is NOT the same as having no projects — the
  // wall draws a different empty state for it, because the way out is the
  // header's restore control rather than adding a repository.
  const all = splitHiddenColumns(projects, ["a", "b", "c"])
  check("every column can be hidden at once", all.shown.length === 0 && all.hiddenCount === 3)

  // The stored set stays clean at the point of writing as well. Both ends are
  // guarded deliberately: this keeps the value tidy, and the split above stays
  // correct for a value this function never wrote.
  check("hiding twice stores one id", withHidden(["a"], "a").join(",") === "a")
  check("hiding appends", withHidden(["a"], "b").join(",") === "a,b")
  check(
    "and the order hidden is kept",
    withHidden(withHidden([], "c"), "a").join(",") === "c,a",
    "the list is a record of what you hid, not a sorted set",
  )
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

  const single = foldRows([tool("Read"), text("done")], false)
  check(
    "a lone step is left alone",
    single.every((r) => !r.folded),
    "a fold the same height as the row it replaces has traded readability for a click",
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

