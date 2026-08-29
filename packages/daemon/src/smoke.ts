/**
 * End-to-end check of the git plumbing behind the checkpoint and the commit:
 * `pnpm smoke`.
 *
 * It builds a throwaway repo in the temp directory and drives the real functions
 * against it — no mocks, no model calls, nothing to clean up in your own
 * projects. Worth running on any change to `checkpoint.ts`, `changes.ts` or
 * `git.ts`, because the failure modes here are the expensive kind and most of
 * them are SILENT: a diff that quietly includes the human's work, a commit that
 * sweeps up a file nobody reviewed, a scratch index that writes through to the
 * real one, a shell policy that lets through what it should not.
 *
 * The through-line of the checkpoint assertions is that aide must be able to
 * work in someone's own checkout without ever disturbing it. Several checks
 * below exist only to prove a NON-effect — that `git status` and the index are
 * byte-identical either side of an operation — which is exactly the kind of
 * thing that breaks without anybody noticing for a week.
 *
 * It is deliberately not a test framework. One file, one command, plain output.
 */
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { chatModeFromSdk } from "@aide/protocol"
import { HUMAN_ONLY_COMMANDS, checkBashCommand } from "./policy.js"
import { restartDecision, type Health } from "@aide/protocol"
import { staleVerdict } from "./source.js"
import {
  buildGraph,
  commitDetail,
  isSha,
  log as readLog,
  overview,
  parseStatus,
  pending,
  status as repoStatus,
  workingTree,
} from "./repo.js"
import { commitRun, currentBranch, recentSubjects, runChanges, withSessionTrailer } from "./changes.js"
import {
  listTurnCheckpoints,
  readCheckpoint,
  restoreCommand,
  takeCheckpoint,
  takeTurnCheckpoint,
} from "./checkpoint.js"
import { STATE_DIR } from "@aide/protocol"
import type { Project, RunEvent } from "@aide/protocol"

const run = promisify(execFile)
const git = async (cwd: string, args: string[]) =>
  (await run("git", ["-C", cwd, ...args], { windowsHide: true })).stdout

let failures = 0
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures += 1
}

const root = await mkdtemp(join(tmpdir(), "aide-smoke-"))
console.log(`repo: ${root}\n`)

await git(root, ["init", "-b", "main"])
await git(root, ["config", "user.email", "smoke@aide.test"])
await git(root, ["config", "user.name", "aide smoke"])
// Git for Windows sets core.autocrlf=true system-wide, so a checkout rewrites
// LF as CRLF. That is git doing its job, but it makes "the file came back
// byte-for-byte" a statement about line-ending policy rather than about restore.
await git(root, ["config", "core.autocrlf", "false"])
await writeFile(join(root, "README.md"), "# smoke\n", "utf8")
await git(root, ["add", "-A"])
await git(root, ["commit", "-m", "Add a readme"])
await writeFile(join(root, "app.ts"), "export const n = 1\n", "utf8")
await git(root, ["add", "-A"])
await git(root, ["commit", "-m", "Add app entrypoint"])

console.log("checkpoint")
const ROW = "0001"
const SESSION = "7f1c0e2a-0000-4000-8000-000000000001"

// The human's own uncommitted work, present BEFORE any agent runs. Everything
// below is about keeping this distinguishable from what the agent does.
await writeFile(join(root, "app.ts"), "export const n = 1\nconst mine = true\n", "utf8")
await writeFile(join(root, "scratch.txt"), "notes to self\n", "utf8")

const statusBefore = await git(root, ["status", "--porcelain"])
const cp = await takeCheckpoint(root, SESSION)
check("returns a sha", /^[0-9a-f]{40}$/.test(cp.sha), cp.sha)
check("under refs/aide/", cp.ref === `refs/aide/checkpoints/${SESSION}`, cp.ref)
check("the ref resolves", (await readCheckpoint(root, SESSION))?.sha === cp.sha)

// The whole point. A snapshot that alters the tree it is snapshotting would be
// worse than useless, because the human is watching that tree in a dev server.
check(
  "working tree untouched",
  (await git(root, ["status", "--porcelain"])) === statusBefore,
  "a checkpoint must be invisible",
)
check(
  "untracked files are IN the snapshot",
  (await git(root, ["ls-tree", "-r", "--name-only", cp.sha])).includes("scratch.txt"),
  "exactly what `git stash create` drops on the floor",
)
check(
  "invisible to git branch",
  !(await git(root, ["branch", "--format=%(refname:short)"])).includes("aide"),
)
check(
  "invisible to the history view",
  !(await readLog(root, 50)).commits.some((c) => c.subject.startsWith("aide checkpoint")),
  "refs/aide/ must not draw itself into the graph",
)

console.log("\nchanges — the agent's work, separated from the human's")
await writeFile(join(root, "app.ts"), "export const n = 2\nconst mine = true\n", "utf8")
await mkdir(join(root, "lib"), { recursive: true })
await writeFile(join(root, "lib/new.ts"), "export const added = true\n", "utf8")

const changes = await runChanges(root, cp.sha)
check("stat sees the modified file", changes.stat.includes("app.ts"))
check("stat sees the CREATED file", changes.stat.includes("new.ts"))
check("diff has hunks", changes.diff.includes("+export const added = true"))
check(
  "the human's untouched file is NOT in the diff",
  !changes.diff.includes("notes to self") && !changes.paths.includes("scratch.txt"),
  "diffing HEAD instead of the checkpoint is how that leaks in",
)
check(
  "paths are exactly what changed",
  [...changes.paths].sort().join(",") === "app.ts,lib/new.ts",
  changes.paths.join(","),
)
check(
  "a file both of them touched is flagged",
  changes.overlap.includes("app.ts"),
  "git cannot split two people's edits, so the human is told by name",
)
check("a file only the agent touched is not flagged", !changes.overlap.includes("lib/new.ts"))
check(
  "reading a diff stages nothing in the real index",
  !(await git(root, ["diff", "--cached", "--name-only"])).trim(),
  "no `add -A -N` across the human's tree",
)

console.log("\nhouse style")
const subjects = await recentSubjects(root)
check("reads recent subjects", subjects.length === 2, JSON.stringify(subjects))

console.log("\ncommit")
const message = withSessionTrailer(
  "Bump n and add lib\n\nBecause the smoke test says so.",
  SESSION,
)
check("trailer appended", message.includes(`Aide-Session: ${SESSION}`))
check("trailers are idempotent", withSessionTrailer(message, SESSION) === message)

// Staged by hand, by the human, while all this was going on. It must survive.
await writeFile(join(root, "staged-by-hand.txt"), "mine\n", "utf8")
await git(root, ["add", "staged-by-hand.txt"])

const sha = await commitRun(root, changes.paths, message)
check("returns a sha", /^[0-9a-f]{40}$/.test(sha), sha)
const body = await git(root, ["log", "-1", "--format=%B"])
check("multi-line message survived", body.includes("Because the smoke test says so."))
check("trailer is in the commit", body.includes(`Aide-Session: ${SESSION}`))

const committed = await git(root, ["show", "--name-only", "--format=", sha])
check("commits what the diff showed", committed.includes("app.ts") && committed.includes("new.ts"))
check(
  "does NOT commit the human's untracked file",
  !committed.includes("scratch.txt"),
  "a blanket `git add -A` sweeps this up",
)
check(
  "does NOT commit what the human staged by hand",
  !committed.includes("staged-by-hand.txt"),
  "naming paths on the commit is what stops the index leaking in",
)
check(
  "and it is still staged afterwards",
  (await git(root, ["status", "--porcelain"])).includes("A  staged-by-hand.txt"),
)

let threw = ""
try {
  await commitRun(root, [], "nothing here")
} catch (err) {
  threw = err instanceof Error ? err.message : String(err)
}
check("refuses an empty commit", threw.includes("nothing to commit"), threw)

{
  // A run that removes a file with `git rm` has already staged that deletion:
  // the path is gone from the worktree AND from the index. `git add` answers a
  // pathspec matching neither with a fatal, and that used to abort the whole
  // commit — over the one part of the change that was already staged correctly.
  await writeFile(join(root, "doomed.ts"), "export const doomed = true\n", "utf8")
  await git(root, ["add", "doomed.ts"])
  await git(root, ["commit", "-m", "Add a file for the next run to delete", "--", "doomed.ts"])

  const rmSession = "7f1c0e2a-0000-4000-8000-000000000009"
  const rmPoint = await takeCheckpoint(root, rmSession)
  await git(root, ["rm", "-q", "doomed.ts"])
  await writeFile(join(root, "kept.ts"), "export const kept = true\n", "utf8")

  const rmChanges = await runChanges(root, rmPoint.sha)
  check(
    "a `git rm`-ed file is in the run's paths",
    rmChanges.paths.includes("doomed.ts"),
    rmChanges.paths.join(","),
  )
  const rmSha = await commitRun(root, rmChanges.paths, "Delete doomed.ts\n")
  const named = await git(root, ["show", "--name-status", "--format=", rmSha])
  check(
    "and the commit records the deletion",
    named.includes("D\tdoomed.ts"),
    "`git add` on a path in neither the worktree nor the index is a fatal",
  )
  check("beside the file the same run created", named.includes("kept.ts"))
  check(
    "and the human's hand-staged file is still theirs",
    (await git(root, ["status", "--porcelain"])).includes("A  staged-by-hand.txt"),
  )
}

{
  // The same path, one step further gone. A conversation's paths are measured
  // against its checkpoint, so a long-lived chat can name a file whose deletion
  // an EARLIER commit already took — leaving it in neither the worktree, the
  // index nor HEAD. `git commit` refuses a pathspec matching nothing, and it
  // refuses the whole command, so one already-landed deletion used to take the
  // other nine files down with it.
  await writeFile(join(root, "stale.ts"), "export const stale = true\n", "utf8")
  await git(root, ["add", "stale.ts"])
  await git(root, ["commit", "-m", "Add a file whose deletion lands early", "--", "stale.ts"])

  const staleSession = "7f1c0e2a-0000-4000-8000-00000000000a"
  const stalePoint = await takeCheckpoint(root, staleSession)
  await git(root, ["rm", "-q", "stale.ts"])
  await git(root, ["commit", "-m", "Delete it, before the conversation commits", "--", "stale.ts"])
  await writeFile(join(root, "after.ts"), "export const after = true\n", "utf8")

  const staleChanges = await runChanges(root, stalePoint.sha)
  check(
    "an already-committed deletion is still in the run's paths",
    staleChanges.paths.includes("stale.ts"),
    staleChanges.paths.join(","),
  )
  const staleSha = await commitRun(root, staleChanges.paths, "Add after.ts\n")
  const staleNamed = await git(root, ["show", "--name-status", "--format=", staleSha])
  check(
    "the rest of the run commits anyway",
    staleNamed.includes("after.ts"),
    "one dead pathspec must not refuse the whole commit",
  )
  check(
    "and the dead path is not in it",
    !staleNamed.includes("stale.ts"),
    "its deletion is already in history — there is nothing left to record",
  )

  let allGone = ""
  try {
    await commitRun(root, ["stale.ts"], "Nothing left of this\n")
  } catch (err) {
    allGone = err instanceof Error ? err.message : String(err)
  }
  check(
    "a run with nothing BUT dead paths says so",
    allGone.includes("already been committed"),
    allGone || "(it committed something)",
  )
}

console.log("\nundo — the checkpoint is the whole safety net")
{
  const undoSession = "7f1c0e2a-0000-4000-8000-000000000002"
  await writeFile(join(root, "precious.txt"), "do not lose me\n", "utf8")
  const before = await readFile(join(root, "app.ts"), "utf8")
  const undo = await takeCheckpoint(root, undoSession)

  // A run goes wrong: clobbers a tracked file and deletes an untracked one.
  await writeFile(join(root, "app.ts"), "export const n = 999\n", "utf8")
  await rm(join(root, "precious.txt"))

  check("restore command names the ref", restoreCommand(undo.ref).includes(undo.ref))
  await git(root, ["restore", `--source=${undo.ref}`, "--worktree", "--", "."])
  check("the clobbered file is back", (await readFile(join(root, "app.ts"), "utf8")) === before)
  check(
    "the DELETED untracked file is back",
    existsSync(join(root, "precious.txt")),
    "the reason this is not `git stash create`",
  )
  await rm(join(root, "precious.txt"))
}

console.log("\nturn boundaries — a restore point per turn, not just per conversation")
{
  const turnSession = "7f1c0e2a-0000-4000-8000-000000000003"
  const base = await takeCheckpoint(root, turnSession)
  check("a conversation starts with no turn boundaries", (await listTurnCheckpoints(root, turnSession)).length === 0)

  await writeFile(join(root, "turnwork.txt"), "first turn\n", "utf8")
  const t1 = await takeTurnCheckpoint(root, turnSession)
  check("numbered from 1", t1?.n === 1, String(t1?.n))
  check("under refs/aide/turns/", t1?.ref === `refs/aide/turns/${turnSession}/1`, t1?.ref)
  check("turn 1 parents the conversation checkpoint", (await git(root, ["rev-parse", `${t1?.sha}^`])).trim() === base.sha)

  // Most messages are questions. A boundary identical to the one before it is
  // not a place you can return to, and one per message would bury the ones that
  // are.
  check("a turn that changed nothing gets no ref", (await takeTurnCheckpoint(root, turnSession)) === null)

  await writeFile(join(root, "turnwork.txt"), "first turn\nsecond turn\n", "utf8")
  const t2 = await takeTurnCheckpoint(root, turnSession)
  check("the next change is turn 2", t2?.n === 2, String(t2?.n))

  // Chained, so one turn's work is the diff between two adjacent refs rather
  // than something you subtract two conversation-wide diffs to get.
  const between = await git(root, ["diff", String(t1?.sha), String(t2?.sha)])
  check(
    "adjacent turns diff to exactly that turn's work",
    between.includes("+second turn") && !between.includes("+first turn"),
  )

  // `for-each-ref` sorts refnames LEXICOGRAPHICALLY, where 10 lands between 1
  // and 2 — so trusting its order would have a conversation renumber from 2 on
  // its tenth turn, straight over refs it already had.
  await git(root, ["update-ref", `refs/aide/turns/${turnSession}/10`, String(t2?.sha)])
  check(
    "turn 10 sorts after turn 2, not before it",
    (await listTurnCheckpoints(root, turnSession)).at(-1)?.n === 10,
  )
  await writeFile(join(root, "turnwork.txt"), "first turn\nsecond turn\neleventh\n", "utf8")
  check("so the next turn is 11", (await takeTurnCheckpoint(root, turnSession))?.n === 11)

  // The whole point: rewind one turn rather than the whole conversation.
  await git(root, ["restore", `--source=${t1?.ref}`, "--worktree", "--", "."])
  check(
    "restoring a boundary undoes the turns after it and no more",
    (await readFile(join(root, "turnwork.txt"), "utf8")) === "first turn\n",
  )
  check(
    "invisible to git branch",
    !(await git(root, ["branch", "--format=%(refname:short)"])).includes("turns"),
  )
  check(
    "invisible to the history view",
    !(await readLog(root, 50)).commits.some((c) => c.subject.startsWith("aide turn")),
  )
  await rm(join(root, "turnwork.txt"))
}

console.log("\neverything a run touches is a run's to commit")
// There used to be a carve-out here: `.aide/todos.md` was written by the daemon
// in the same tree a run was editing, so no commit could take it. Nothing writes
// it now and the pathspec is gone, which makes this section about the property
// that replaced it — the scope is simply "the repository", with no file that a
// human can see change and never commit.
await mkdir(join(root, STATE_DIR), { recursive: true })
await writeFile(join(root, STATE_DIR, "notes.md"), "# What it does\n", "utf8")
const scoped = await runChanges(root, cp.sha)
check(
  "a run's own file under .aide/ is in the diff",
  scoped.paths.includes(".aide/notes.md"),
  "project.md included — a change to what the project refuses to be lands with the code",
)
const scopedSha = await commitRun(root, scoped.paths, "Describe what it does\n")
const shown = await git(root, ["show", "--stat", "--format=", scopedSha])
check("commit matches the reviewed diff", shown.includes("notes.md"))

console.log("\nwhat is left to commit — the indicator, and the gate it drives")
{
  // A new conversation is refused while `pending` is non-empty, so the list has
  // to agree with git exactly: anything it reports has to be something a commit
  // can actually take, or the refusal would never lift.
  const before = await pending(root)
  check(
    "nothing is hidden from this list",
    (await repoStatus(root)).map((f) => f.path).sort().join(",") ===
      before.files.map((f) => f.path).sort().join(","),
    "there is no file a human can watch change and never be allowed to commit",
  )
  check("and it knows the branch", before.branch === "main", before.branch ?? "(detached)")

  await writeFile(join(root, "app.ts"), "export const n = 99\n", "utf8")
  const dirty = await pending(root)
  check(
    "a fresh edit does show",
    dirty.files.some((f) => f.path === "app.ts"),
    `${dirty.files.length} file(s)`,
  )
  check(
    "and git agrees with it, file for file",
    (await repoStatus(root)).map((f) => f.path).sort().join(",") ===
      dirty.files.map((f) => f.path).sort().join(","),
    "the rail is not a filtered view of git any more; it IS git",
  )
  // The invariant tying the rail to the gate: what the indicator lights on and
  // what a commit would take have to be the same set, or the screen explains
  // neither the refusal nor the button that clears it.
  const takeable = await runChanges(root, scopedSha)
  check(
    "and the list is exactly what a commit would take",
    [...takeable.paths].sort().join(",") ===
      dirty.files.map((f) => f.path).sort().join(","),
    takeable.paths.join(",") || "(nothing)",
  )
  await git(root, ["checkout", "--", "app.ts"])
  check(
    "putting it back drops it from the list again",
    !(await pending(root)).files.some((f) => f.path === "app.ts"),
  )
}

console.log("\nbash policy")
{
  const allow = ["pnpm", "npm", "git status", "git diff"]
  const deny = ["pnpm dev", "pnpm probe", "npx"]
  const verdict = (cmd: unknown) => checkBashCommand(cmd, allow, deny)

  check("allows pnpm typecheck", verdict("pnpm typecheck").allow)
  check("allows a bare allowed word", verdict("pnpm").allow)
  check("allows git diff with args", verdict("git diff --stat").allow)
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
  // is watching, so what still has to hold is that the two refusals hold: the
  // ways a run ends badly, and the two that end the REVIEW.
  const deny = [...["pnpm dev", "pnpm probe", "npx"], ...HUMAN_ONLY_COMMANDS]
  const verdict = (cmd: unknown) => checkBashCommand(cmd, null, deny)

  check("runs a command no allowlist mentions", verdict("rg --files").allow, "this is the point")
  check("runs node", verdict("node scripts/one-off.mjs").allow)
  check("still denies pnpm dev", !verdict("pnpm dev").allow, "it never exits")
  check("still denies npx", !verdict("npx cowsay").allow)
  check("denies git commit", !verdict("git commit -m x").allow, "the human commits, not the run")
  check("denies git push", !verdict("git push").allow)
  check("git status is not git push", verdict("git status").allow, "prefix must end at a word")
  // The blunt half of the rule survives the allowlist going away, and it has to:
  // an unattended run is exactly where `pnpm ls; git push` must not resolve to
  // an allowed leading word.
  check("denies chaining past a denied command", !verdict("pnpm ls; git push").allow)
  check("denies substitution", !verdict("echo $(git push)").allow)
  check("an empty command is still nothing", !verdict("   ").allow)
}

console.log("\ninherited chat mode")
{
  // The session store is shared with the CLI and the VS Code extension, and a
  // conversation carries the mode it was last driven at. Reading that back is
  // what stops a chat you were running on Auto elsewhere from quietly reverting
  // to Manual here and asking permission for the next command.
  check("default is what aide calls manual", chatModeFromSdk("default") === "manual")
  check("acceptEdits round-trips", chatModeFromSdk("acceptEdits") === "acceptEdits")
  check("plan round-trips", chatModeFromSdk("plan") === "plan")
  check("auto round-trips", chatModeFromSdk("auto") === "auto")
  // Null is the load-bearing case. It means "no opinion", and the browser keeps
  // whatever the human last picked — so an unknown mode can never widen one.
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

console.log("\ntelling a turn it left the daemon behind")
{
  // The other half of the same fact, and the half a human actually asks about:
  // not "should the dev server restart this" but "is the change I just asked for
  // in the thing I am looking at". These logs hold that question three times,
  // typed into a fresh chat, because the only answer was a badge in a rail.
  const BOOT = "aaaaaaaaaaaa"
  const verdict = (before: string | null, now: string | null) => staleVerdict(BOOT, before, now)

  check(
    "a turn that edits the daemon says so",
    verdict(BOOT, "bbbbbbbbbbbb")?.sourceId === "bbbbbbbbbbbb",
  )
  check(
    "a turn that changed nothing says nothing",
    verdict(BOOT, BOOT) === null,
    "most turns are questions, and a row on every one of them is a row nobody reads",
  )
  check(
    "an edit the human made before sending is not the turn's doing",
    verdict("bbbbbbbbbbbb", "bbbbbbbbbbbb") === null,
    "otherwise every turn repeats it until something restarts the process",
  )
  check(
    "but editing it further within the turn is",
    verdict("bbbbbbbbbbbb", "cccccccccccc")?.sourceId === "cccccccccccc",
  )
  check(
    "a turn that puts the source back is silent",
    verdict("bbbbbbbbbbbb", BOOT) === null,
    "reverted to what is loaded — there is nothing to restart for",
  )
  check("unknown is never stale", verdict(BOOT, null) === null)
  check("and neither is an unreadable boot", staleVerdict(null, BOOT, "bbbbbbbbbbbb") === null)
}

const project: Project = { id: "p1", name: "smoke", root, addedAt: new Date().toISOString() }

console.log("\na branch and a merge, for the history view to draw")
// Built with plain git, on purpose. aide does not make branches any more and has
// no `land` — but the repositories it manages are still full of branches and
// merges, and `repo.ts` has to draw them. So this is a FIXTURE for the history
// view rather than a feature under test, and building it by hand is what keeps
// that distinction visible.
//
// Everything above deliberately left the tree dirty; the merge below needs it
// clean, and this is a throwaway repo.
await git(root, ["reset", "-q"])
await git(root, ["checkout", "-q", "--", "."])
await git(root, ["clean", "-qfd"])

const BRANCH = "feature/wobble"
const forked = (await git(root, ["rev-parse", "HEAD"])).trim()
await git(root, ["checkout", "-q", "-b", BRANCH])
await writeFile(join(root, "wobble.ts"), "export const wobble = true\n", "utf8")
await git(root, ["add", "wobble.ts"])
await git(root, ["commit", "-m", "Teach it to wobble"])
await git(root, ["checkout", "-q", "main"])
// A branch that is NOT checked out, so ref classification has something to be
// wrong about.
await git(root, ["branch", "rival", forked])
await git(root, ["merge", "--no-ff", BRANCH, "-m", `Merge ${BRANCH}: teach it to wobble`])

const landed = { sha: (await git(root, ["rev-parse", "HEAD"])).trim(), into: "main" }
check(
  "is a merge commit",
  (await git(root, ["log", "-1", "--format=%P"])).trim().split(" ").length === 2,
  "--no-ff held",
)
check("the branch's file is in main", existsSync(join(root, "wobble.ts")))
check("the agent's earlier commit is still there", existsSync(join(root, "lib/new.ts")))

console.log("\nreading the repository")
{
  const view = await overview(root)
  check("knows the branch", view.branch === "main", view.branch ?? "(detached)")
  check("knows HEAD", view.head !== null && !view.unborn, view.head ?? "")
  check("invents no upstream", view.upstream === null, "this repo has no remote")

  const history = await readLog(root, 3)
  check("log honours the limit", history.commits.length === 3, `${history.commits.length}`)
  check("says there is more", history.more, "one extra is fetched so this is not a guess")
  check("newest first", history.commits[0]?.sha === landed.sha, history.commits[0]?.subject ?? "")
  // Read again unlimited rather than reusing the three above: this repo's
  // commits are all made inside the same second, so which of them `git log`
  // puts third is a tie-break, and an assertion about trailers must not depend
  // on it.
  const full = await readLog(root, 50)
  check("no more history than there is", !full.more, `${full.commits.length} commits`)

  // The assertion this section exists for. `git show` on a cleanly resolved
  // merge prints an empty combined diff, and every landed task is a --no-ff
  // merge — so without `-m --first-parent` the whole point of the view, seeing
  // what landed, is a commit that appears to have changed nothing.
  const detail = await commitDetail(root, landed.sha)
  check("finds the merge commit", detail !== null)
  check("merge has a diff", detail?.diff.includes("+export const wobble = true") === true, "-m --first-parent")
  check("merge has a stat", detail?.stat.includes("wobble.ts") === true)
  check("keeps the whole message", detail?.message.includes(`Merge ${BRANCH}`) === true)

  check("an option is not a sha", !isSha("--upload-pack=whatever"), "this value comes from the URL")
  check("a real sha is", isSha(landed.sha))
  check("and commitDetail refuses it", (await commitDetail(root, "--output=/tmp/x")) === null)

  // The `++i` that consumes a rename's second field is easy to get wrong in a
  // way that eats the NEXT entry rather than failing outright.
  const parsed = parseStatus("R  new name.txt\u0000old name.txt\u0000?? plain.txt\u0000")
  check("rename carries its old path", parsed[0]?.from === "old name.txt", parsed[0]?.from ?? "null")
  check("rename does not swallow the next entry", parsed.length === 2 && parsed[1]?.path === "plain.txt")

  await writeFile(join(root, "app.ts"), "export const n = 3\n", "utf8")
  await writeFile(join(root, "brand new.txt"), "untracked\n", "utf8")
  const tree = await workingTree(root)
  check("sees the edit", tree.files.some((f) => f.path === "app.ts" && f.unstaged === "modified"))
  check("edit is in the diff", tree.diff.includes("+export const n = 3"))
  const fresh = tree.files.find((f) => f.path === "brand new.txt")
  check("sees a new file whose name has a space", fresh?.code === "??", fresh?.path ?? "missing")
  check("new file's content is in the diff", tree.diff.includes("+untracked"), "--no-index against /dev/null")
  check("new file reads as new", tree.diff.includes("new file mode"))
  // The whole reason this view diffs new files the awkward way. `add -A -N` is
  // how the worktree routes do it, and doing that here would stage intent-to-add
  // across the human's own checkout because they opened a read-only page.
  check(
    "staged nothing to manage it",
    (await git(root, ["diff", "--cached", "--name-only"])).trim() === "",
    "read-only means read-only",
  )
  await rm(join(root, "brand new.txt"))
  await git(root, ["checkout", "--", "app.ts"])
}

console.log("\nthe drawn graph")
{
  // The half of the history view nobody can eyeball. A lane is a number, and a
  // wrong number is a line that goes somewhere the reader will believe. This
  // repo has the shape that matters by the time we get here: a branch that left
  // main and came back through a --no-ff merge, plus `rival`, which never did.
  const page = await readLog(root, 50)
  const rowFor = (sha: string) => page.graph.find((r) => r.sha === sha)

  check("a row per commit", page.graph.length === page.commits.length)
  check(
    "rows are in the same order as the commits",
    page.graph.every((r, i) => r.sha === page.commits[i]?.sha),
    "the UI pairs them by index; the sha is carried so this cannot drift silently",
  )

  check(
    "the newest commit has no line above it",
    rowFor(page.commits[0]?.sha ?? "")?.enters.length === 0,
    "nothing on the page points at it",
  )

  const merge = rowFor(landed.sha)
  check("the merge has two lines leaving it", merge?.leaves.length === 2, `${merge?.leaves.length}`)
  check(
    "and they leave in different lanes",
    merge?.leaves[0]?.lane !== merge?.leaves[1]?.lane,
    "both parents in one lane would draw a merge as a straight line",
  )
  check("the merge keeps its own lane for its first parent", merge?.leaves[0]?.lane === merge?.lane)

  const [firstParent, secondParent] = page.commits.find((c) => c.sha === landed.sha)?.parents ?? []
  check(
    "main keeps its colour across the merge",
    rowFor(firstParent ?? "")?.color === merge?.color,
    "a new colour at every merge is how a graph turns into spaghetti",
  )
  check(
    "the branch that landed runs beside it, not on top of it",
    rowFor(secondParent ?? "")?.lane !== merge?.lane,
  )
  check(
    "every lane drawn fits the width the page reports",
    page.lanes >= 2 &&
      page.graph.every((r) =>
        [r.lane, ...[...r.through, ...r.enters, ...r.leaves].map((l) => l.lane)].every(
          (l) => l < page.lanes,
        ),
      ),
    `${page.lanes} lanes wide`,
  )
  check(
    "nothing is drawn twice in one lane",
    page.graph.every(
      (r) =>
        new Set(r.leaves.map((l) => l.lane)).size === r.leaves.length &&
        new Set(r.enters.map((l) => l.lane)).size === r.enters.length,
    ),
    "two lines in one lane are one line as far as the reader is concerned",
  )

  // Where the branch left main. Every line still looking for this commit ends
  // here, and all but one of them is drawn joining in.
  const base = (await git(root, ["merge-base", firstParent ?? "", secondParent ?? ""])).trim()
  check(
    "the lines meet again at the fork point",
    (rowFor(base)?.enters.length ?? 0) >= 2,
    `${base.slice(0, 8)} — its own line plus at least one branch joining it`,
  )

  // Ref classification, which is the reason the log asks for --decorate=full.
  // Slashed LOCAL branch names are ordinary in any real repo, and "a slash means
  // a remote" would label every one of them as somebody else's.
  const refs = page.commits.flatMap((c) => c.refs)
  const rowBranch = refs.find((r) => r.name === BRANCH)
  check("a slashed local branch is a branch", rowBranch?.kind === "branch", rowBranch?.kind ?? "missing")
  check("the checked-out branch says so", refs.some((r) => r.name === "main" && r.head))
  check("and the others do not", refs.find((r) => r.name === "rival")?.head === false)
  check("no ref path leaks through", !refs.some((r) => r.name.startsWith("refs/")), "the UI prints these")

  const first = page.commits.find((c) => c.parents.length === 0)
  check("the first commit's line simply stops", rowFor(first?.sha ?? "")?.leaves.length === 0)

  // Synthetic, because the case that decides whether a long history stays
  // readable is one no throwaway repo makes by accident: a lane freed in the
  // middle of the page, with a line still running to the left of it, has to be
  // handed to the next tip that needs one.
  const commit = (sha: string, parents: string[]) => ({
    sha,
    parents,
    short: sha,
    author: "",
    authorEmail: "",
    date: "",
    refs: [],
    rows: [],
    subject: "",
  })
  const synth = buildGraph([
    commit("d", ["c", "b"]),
    commit("c", ["a"]),
    commit("b", ["a"]),
    commit("a", ["a0"]),
    commit("z", []),
    commit("a0", []),
  ])
  check(
    "a commit in the middle of a branch is joined to the one above it",
    synth.graph[1]?.enters.length === 1 && synth.graph[1]?.enters[0]?.lane === synth.graph[1]?.lane,
    "without this every dot is drawn with a gap over it",
  )
  check("the merged-in branch takes the lane beside it", synth.graph[2]?.lane === 1, `${synth.graph[2]?.lane}`)
  check(
    "both lines land on the shared parent",
    synth.graph[3]?.enters.length === 2,
    "one is the lane it continues in, the other is the branch joining it",
  )
  check(
    "the freed lane is reused, not abandoned",
    synth.graph[4]?.lane === 1,
    "an unrelated tip must not push the graph one column further right forever",
  )
  check("so the whole page is two lanes wide", synth.lanes === 2, `${synth.lanes}`)
}

// ---------------------------------------------------------------------------
console.log("\ncommitting a conversation")
// The review gate end to end, with a conversation's identifiers. The message is
// supplied here rather than drafted, so this exercises the git plumbing without
// spending anything.
{
  const { commitReview } = await import("./review.js")

  const rowId = "0042"
  const session = "11111111-2222-3333-4444-555555555555"
  const project = { id: "p", name: "p", root, addedAt: "" }

  // A conversation begins: snapshot first, then the agent writes.
  const baseline = await takeCheckpoint(root, session)
  await writeFile(join(root, "wobble.txt"), "it wobbles\n", "utf8")

  const { sha } = await commitReview({
    project,
    sessionId: session,
    checkpoint: baseline.sha,
    message: "Teach the widget to wobble",
  })
  check("it commits", /^[0-9a-f]{40}$/.test(sha), sha.slice(0, 8))

  const body = await git(root, ["log", "-1", "--format=%B"])
  check("and its session, which outlives every run in it", body.includes(`Aide-Session: ${session}`))

  const tracked = await git(root, ["show", "--name-only", "--format=", "HEAD"])
  check(
    "it commits exactly what the conversation changed",
    tracked.includes("wobble.txt"),
    "measured against the checkpoint, not against HEAD",
  )

  check(
    "the work is visible in the project itself",
    existsSync(join(root, "wobble.txt")),
    "no worktree to go and look in — this IS the tree the dev server serves",
  )
  check(
    "and the checkpoint is still there to undo it",
    (await readCheckpoint(root, session))?.sha === baseline.sha,
    "committing must not throw away the only way back",
  )
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
