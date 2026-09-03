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
import { chatModeFromSdk, planChecks, restartDecision, type Health } from "@aide/protocol"
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

console.log("\ncarrying out an approved plan")
{
  // A null allowlist is the shape a chat gets once the human has approved a
  // plan and asked for it to be carried out without further questions. Nobody
  // is watching, so what still has to hold is that the refusals hold: the ways
  // a run ends badly, and the one that ends the REVIEW.
  const deny = [...["pnpm dev", "pnpm probe", "npx"], ...HUMAN_ONLY_COMMANDS]
  const verdict = (cmd: unknown) => checkBashCommand(cmd, null, deny)

  check("runs a command no allowlist mentions", verdict("rg --files").allow, "this is the point")
  check("runs node", verdict("node scripts/one-off.mjs").allow)
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

