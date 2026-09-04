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
  cardsForConversation,
  chatModeFromSdk,
  checkVerdict,
  formatLocation,
  parseLocation,
  parseTurnSummary,
  PerProjectMemo,
  planChecks,
  projectGates,
  reduceCard,
  restartDecision,
  sortCards,
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

console.log("\na turn reduced to a card")
{
  // The card's contract: everything but the summary comes off exit codes and
  // git, so nothing a model writes can contradict a check, a sha or an outcome.
  let seq = 0
  const ev = (body: RunEventBody, ts = 1000 + seq * 10): RunEvent =>
    ({ ...body, runId: "r1", seq: (seq += 1), ts }) as RunEvent

  const done = reduceCard("r1", [
    ev({ type: "user.message", text: "fix the poll" }),
    ev({ type: "turn.summary", headline: "fixed it", next: "read the diff" }),
    ev({ type: "verify.result", command: "pnpm typecheck", ok: true, exitCode: 0, durationMs: 5, output: "" }),
    ev({ type: "verify.skipped", command: "pnpm build", reason: "web only" }),
    ev({ type: "commit.landed", sha: "abc1234", paths: ["a.ts", "b.ts"] }),
    ev({
      type: "run.finished",
      subtype: "success",
      status: "success",
      totalCostUsd: 1.5,
      modelUsage: {},
      numTurns: 4,
      durationMs: 90,
      permissionDenials: [],
    }),
  ])
  check("a finished turn is done", done.state === "done", done.state)
  check("the summary is carried", done.summary?.headline === "fixed it")
  check("the checks are counted from events", done.checks.length === 2)
  check("and the skipped one is IN the list", done.checks.some((c) => c.skipped), "a gate that quietly shrinks looks like one that broke")
  check("the diffstat is the commit's paths", done.changed === 2)
  check("and the sha came with it", done.sha === "abc1234")

  const verdict = checkVerdict(done.checks)
  check("the badge is green when nothing failed", verdict?.ok === true)
  check("it counts what RAN, not what was listed", verdict?.ran === 1, String(verdict?.ran))
  check("and says how many were skipped", verdict?.skipped === 1)
  check("a turn that ran no checks gets no badge", checkVerdict([]) === null, "an empty badge on every row spends the best pixel saying nothing")

  // A failed check must reach the badge even on a turn the SDK called a success:
  // the commit gate refuses, the turn ends fine, and the card has to say so.
  const broken = reduceCard("r2", [
    ev({ type: "verify.result", command: "pnpm smoke", ok: false, exitCode: 1, durationMs: 5, output: "boom" }),
    ev({
      type: "run.finished",
      subtype: "success",
      status: "success",
      totalCostUsd: 0,
      modelUsage: {},
      numTurns: 1,
      durationMs: 5,
      permissionDenials: [],
    }),
  ])
  check("a failed check shows red", checkVerdict(broken.checks)?.ok === false)
  check(
    "even though the turn itself succeeded",
    broken.state === "done",
    "the check badge and the run outcome are different facts",
  )

  // Blocked means still waiting, and the AND with "not finished" is the whole
  // rule. A LIVE run with an open question is the one thing on the list a person
  // can act on.
  const blocked = reduceCard("r3", [
    ev({ type: "permission.request", requestId: "q1", name: "Bash", input: {} }),
  ])
  check("a live run with an open question needs you", blocked.state === "blocked", blocked.state)

  // ...and a DEAD one does not, which is the correction real logs forced. Two
  // runs on this machine died holding a question — killed by a daemon restart —
  // and the first version put both at the top of the worklist as "needs you",
  // 44 hours old. Nobody can answer a request whose run is gone: the `resolve`
  // it would call is in a process that no longer exists. A needs-you row no
  // action can clear teaches you to ignore the column.
  const abandoned = reduceCard("r3b", [
    ev({ type: "permission.request", requestId: "q1", name: "Bash", input: {} }),
    ev({ type: "run.error", message: "worker exited" }),
  ])
  check(
    "a dead run holding a question is failed, not needs-you",
    abandoned.state === "failed",
    `${abandoned.state} — a row nobody can clear is worse than no row`,
  )
  const answered = reduceCard("r4", [
    ev({ type: "permission.request", requestId: "q1", name: "Bash", input: {} }),
    ev({ type: "permission.resolved", requestId: "q1", allowed: true, reason: "" }),
    ev({
      type: "run.finished",
      subtype: "success",
      status: "success",
      totalCostUsd: 0,
      modelUsage: {},
      numTurns: 1,
      durationMs: 5,
      permissionDenials: [],
    }),
  ])
  check("an answered one is not", answered.state === "done", answered.state)

  // A turn in flight is `working`, not `failed`. Asking for a card mid-turn is
  // the normal case for the live view, and drawing a red X on the turn that is
  // currently going fine is the same mistake the profile documents.
  const live = reduceCard("r5", [ev({ type: "user.message", text: "go" })])
  check("an unfinished turn is working", live.state === "working", live.state)
  check("a cancelled one is not done", reduceCard("r6", [
    ev({
      type: "run.finished",
      subtype: "interrupted",
      status: "cancelled",
      totalCostUsd: 0,
      modelUsage: {},
      numTurns: 1,
      durationMs: 5,
      permissionDenials: [],
    }),
  ]).state === "failed", "a stopped turn must not wear a green tick")

  // The model gets no say in pass/fail. This is the assertion that catches the
  // layers collapsing: a summary claiming success over a failed check must not
  // change one field of what the card reports.
  const lying = reduceCard("r7", [
    ev({ type: "turn.summary", headline: "all green, everything passed" }),
    ev({ type: "verify.result", command: "pnpm smoke", ok: false, exitCode: 1, durationMs: 5, output: "" }),
    ev({
      type: "run.finished",
      subtype: "success",
      status: "failed",
      totalCostUsd: 0,
      modelUsage: {},
      numTurns: 1,
      durationMs: 5,
      permissionDenials: [],
    }),
  ])
  check(
    "a summary cannot talk a failed check green",
    checkVerdict(lying.checks)?.ok === false && lying.state === "failed",
    "the whole point of the three layers",
  )

  // A log with TWO terminal events, which is not hypothetical: three runs on
  // this machine carry a `success` followed by a `cancelled`, from `#retire`
  // writing over an outcome the turn had already reported before `EventLog`
  // sealed logs. The first one is what the run actually said, and the transcript
  // already drops the redundant second — a card reading the other end would
  // disagree with the transcript beside it about a run both draw from one file.
  const doubled = reduceCard("r8", [
    ev({
      type: "run.finished",
      subtype: "success",
      status: "success",
      totalCostUsd: 2,
      modelUsage: {},
      numTurns: 3,
      durationMs: 5,
      permissionDenials: [],
    }),
    ev({
      type: "run.finished",
      subtype: "interrupted",
      status: "cancelled",
      totalCostUsd: 0,
      modelUsage: {},
      numTurns: 0,
      durationMs: 0,
      permissionDenials: [],
    }),
  ])
  check(
    "the first outcome wins, not the last",
    doubled.state === "done",
    `${doubled.state} — old logs carry a second terminal event that overwrote the real one`,
  )
  check("and its spend is not overwritten by the stray", doubled.costUsd === 2, String(doubled.costUsd))
  check(
    "a stray run.error after an outcome is ignored too",
    reduceCard("r9", [
      ev({
        type: "run.finished",
        subtype: "success",
        status: "success",
        totalCostUsd: 0,
        modelUsage: {},
        numTurns: 1,
        durationMs: 5,
        permissionDenials: [],
      }),
      ev({ type: "run.error", message: "transport died" }),
    ]).state === "done",
    "the transcript drops this one; the card has to agree",
  )

  // A turn read back from the SDK's session store, which is MOST of what the
  // card view draws and is the case the first version got wrong end to end.
  //
  // `sessions.ts` stamps every replayed event with `runId: sessionId` and
  // `ts: 0`, because the SDK envelope carries neither. Two consequences, both
  // seen on screen before they were understood: grouping cards by run id drew
  // ONE card for a 587-message conversation, and a card that trusts its events
  // for an outcome reports every past turn as still working — a chat of thirty
  // spinning rows, in which the one row that IS running cannot be found.
  //
  // `settled` is what the caller passes when it knows the source records no
  // outcomes. Asserted here because the alternative — inferring it from a
  // missing `run.finished` — silently turns the live turn into a finished one.
  const replayed = reduceCard(
    "session-id",
    [
      { type: "user.message", text: "what changed?", runId: "session-id", seq: 1, ts: 0 },
      { type: "assistant.text", text: "this and that", parentToolUseId: null, runId: "session-id", seq: 2, ts: 0 },
    ] as RunEvent[],
    { settled: true },
  )
  check(
    "a replayed turn is done, not forever working",
    replayed.state === "done",
    `${replayed.state} — the session store records no outcome, so the events cannot say`,
  )
  check("and it keeps the prompt, which is what the row is found by", replayed.prompt === "what changed?")
  check(
    "an unstamped turn reports no duration",
    replayed.wallMs === 0,
    "ts: 0 minus ts: 0 is not a measurement",
  )
  check(
    "and without `settled` the same events are still working",
    reduceCard("x", [{ type: "user.message", text: "hi", runId: "x", seq: 1, ts: 0 }] as RunEvent[]).state ===
      "working",
    "the live turn must not be swept up by the same rule",
  )

  // The split, over a conversation shaped exactly like the one the pane builds:
  // replayed history (one shared runId, ts 0) followed by the live turn from a
  // run log. This is the bug that reached the screen — grouping by run id drew
  // ONE card for 587 messages, because every replayed event carries the session
  // id as its run id.
  const mixed = cardsForConversation([
    { type: "user.message", text: "first question", runId: "sess", seq: 1, ts: 0 },
    { type: "assistant.text", text: "first answer", parentToolUseId: null, runId: "sess", seq: 2, ts: 0 },
    { type: "user.message", text: "second question", runId: "sess", seq: 3, ts: 0 },
    { type: "assistant.text", text: "second answer", parentToolUseId: null, runId: "sess", seq: 4, ts: 0 },
    { type: "user.message", text: "the live one", runId: "run-9", seq: 1, ts: 5000 },
    { type: "assistant.text", text: "working on it", parentToolUseId: null, runId: "run-9", seq: 2, ts: 5100 },
  ] as RunEvent[])
  check(
    "a conversation splits into one card per turn",
    mixed.length === 3,
    `${mixed.length} cards — grouping by runId gives 2, and by session id gives 1`,
  )
  check("each card keeps its own question", mixed[1]?.prompt === "second question", mixed[1]?.prompt)
  check(
    "the replayed turns read as finished",
    mixed[0]?.state === "done" && mixed[1]?.state === "done",
    `${mixed[0]?.state},${mixed[1]?.state} — a chat of spinning rows hides the one that is running`,
  )
  check(
    "and the live one is still working",
    mixed[2]?.state === "working",
    `${mixed[2]?.state} — this is the row the view exists to show`,
  )
  check(
    "the live card keeps its real run id",
    mixed[2]?.runId === "run-9",
    "the key has to be stable, and the replayed rows have no distinct id to offer",
  )
  check(
    "and the replayed cards get distinct keys anyway",
    mixed[0]?.runId !== mixed[1]?.runId,
    "reusing the session id for every row is duplicate React keys across the list",
  )
  // Events before the first human message open a turn rather than vanishing: a
  // `run.started` can beat its own prompt into the log.
  const headless = cardsForConversation([
    { type: "run.started", projectId: "p", model: "m", cwd: "/", sessionId: "s", runId: "r", seq: 1, ts: 10 },
    { type: "user.message", text: "hello", runId: "r", seq: 2, ts: 20 },
  ] as RunEvent[])
  check(
    "an event before the first prompt is not dropped",
    headless.length === 2,
    `${headless.length} — a card missing its opening row reads as lost history`,
  )
  check("an empty conversation is no cards", cardsForConversation([]).length === 0)

  // The CLI writes an image caption as its own user message directly AFTER the
  // question a screenshot was pasted with. Treating that as a turn boundary cuts
  // the question away from its answer: one card holding a prompt with no reply,
  // the next holding a reply captioned with image dimensions — which reads as
  // the model having ignored you.
  const pasted = cardsForConversation([
    { type: "user.message", text: "why is this broken?", runId: "s", seq: 1, ts: 0 },
    {
      type: "user.message",
      text: "[Image: original 2560x1259, displayed at 2000x984. Multiply coordinates by 1.28]",
      runId: "s",
      seq: 2,
      ts: 0,
    },
    { type: "assistant.text", text: "because of X", parentToolUseId: null, runId: "s", seq: 3, ts: 0 },
    { type: "turn.summary", headline: "fixed X", runId: "s", seq: 4, ts: 0 },
  ] as RunEvent[])
  check(
    "a pasted screenshot does not split the turn it belongs to",
    pasted.length === 1,
    `${pasted.length} cards — the caption is the harness talking, not a new question`,
  )
  check(
    "so the question keeps the answer it was asked with",
    pasted[0]?.prompt === "why is this broken?" && pasted[0]?.summary?.headline === "fixed X",
    `${pasted[0]?.prompt} :: ${pasted[0]?.summary?.headline}`,
  )

  // A resume nudge that produced nothing is not a row. Dropped on having nothing
  // to show rather than on its text, so the same nudge KEEPS its card when the
  // turn it opened actually did work.
  const resumed = cardsForConversation([
    { type: "user.message", text: "Continue from where you left off.", runId: "s", seq: 1, ts: 0 },
    { type: "assistant.text", text: "ok", parentToolUseId: null, runId: "s", seq: 2, ts: 0 },
  ] as RunEvent[])
  check(
    "an empty resume nudge is not a card",
    resumed.length === 0,
    `${resumed.length} — a row that says only that the harness spoke`,
  )
  const resumedWorked = cardsForConversation([
    { type: "user.message", text: "Continue from where you left off.", runId: "s", seq: 1, ts: 0 },
    { type: "turn.summary", headline: "finished the migration", runId: "s", seq: 2, ts: 0 },
  ] as RunEvent[])
  check(
    "but one that did work keeps its card",
    resumedWorked.length === 1,
    "filtering on the sentence rather than on the content would lose this",
  )

  // What a running turn says it is doing, and SINCE WHEN. The clock is the
  // point: an elapsed time measured from the start of the turn counts up at the
  // same rate whether the agent is making progress or wedged, so the card
  // measures the current STEP instead and a step whose clock keeps resetting is
  // visible progress.
  const running = reduceCard("r10", [
    ev({ type: "user.message", text: "go" }, 1000),
    ev({ type: "tool.start", toolUseId: "t1", name: "Bash", input: { command: "pnpm smoke" }, parentToolUseId: null }, 2000),
  ])
  check("a running turn says what it is doing", running.activity?.label === "Running Bash pnpm smoke", running.activity?.label)
  check(
    "and the clock starts at that STEP, not at the turn",
    running.activity?.since === 2000,
    `${running.activity?.since} — 1000 would be the turn, which cannot distinguish progress from a stall`,
  )

  // The OLDEST open call, not the newest. One message opens several at once, and
  // reporting the newest resets the clock every time a batch goes out — hiding
  // exactly the stall this exists to show.
  const batch = reduceCard("r11", [
    ev({ type: "tool.start", toolUseId: "a", name: "Bash", input: { command: "pnpm build" }, parentToolUseId: null }, 1000),
    ev({ type: "tool.start", toolUseId: "b", name: "Read", input: { file_path: "/x/y.ts" }, parentToolUseId: null }, 1100),
  ])
  check(
    "a batch reports the call that has been open longest",
    batch.activity?.since === 1000 && batch.activity?.label.includes("pnpm build"),
    `${batch.activity?.label} @ ${batch.activity?.since}`,
  )
  // A closed call stops being the answer, or the line names something that has
  // already returned.
  const closed = reduceCard("r12", [
    ev({ type: "tool.start", toolUseId: "a", name: "Bash", input: { command: "pnpm build" }, parentToolUseId: null }, 1000),
    ev({ type: "tool.end", toolUseId: "a", ok: true, summary: "" }, 1500),
  ])
  check("a finished call is not still running", closed.activity?.label === "Thinking", closed.activity?.label)

  // The boilerplate in front of a command comes off. Nearly every Bash call in
  // this project's logs opens `cd C:/Users/loki/code/aide; CI=true pnpm …` — 34
  // identical characters — so a truncated label read the same for a typecheck, a
  // build and a smoke run, which is the one distinction the line is for.
  const shell = reduceCard("r13b", [
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
  check(
    "a command loses its cd and env prefix",
    shell.activity?.label === "Running Bash pnpm smoke",
    shell.activity?.label,
  )

  // A path is reduced to its basename: the pane is a few hundred pixels wide and
  // a full absolute path pushes the tool's own name off the front of the line.
  const reading = reduceCard("r13", [
    ev({ type: "tool.start", toolUseId: "a", name: "Read", input: { file_path: "C:/Users/loki/code/aide/packages/protocol/src/card.ts" }, parentToolUseId: null }, 1000),
  ])
  check("a file path is shown as its basename", reading.activity?.label === "Running Read card.ts", reading.activity?.label)

  // A finished turn has no "now". Leaving it on would put a stale "Running pnpm
  // smoke" under every completed card in the list.
  check("a finished turn reports no activity", done.activity === null, "the question stops being asked once it is over")
  check("but a blocked one still does", blocked.activity !== null, "a turn waiting on you is still live")

  // Needs-you, then working, then done — the list's grouping, as a sort.
  const order = sortCards([done, live, blocked]).map((c) => c.state)
  check("the list leads with what needs you", order[0] === "blocked", order.join(","))
  check("and buries what is finished", order.at(-1) === "done", order.join(","))
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
  // turn with `cannot find module ./card.js`, which costs an ssh round trip and
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

