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
import { createHash } from "node:crypto"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { chatModeFromSdk } from "@aide/protocol"
import { HUMAN_ONLY_COMMANDS, checkBashCommand } from "./policy.js"
import { restartDecision, type Health } from "@aide/protocol"
import { staleVerdict } from "./source.js"
import { runCheck, runChecks } from "./verify.js"
import { parseProjectDoc } from "@aide/protocol/node"
import { planChecks } from "@aide/protocol"
import { connectableHosts, parseSshConfig, sshTarget } from "@aide/protocol"
import { cleanSshError } from "./ssh.js"
import type { Runner } from "./runner.js"
import type { FromWorker, ToWorker } from "./worker/main.js"
import {
  buildGraph,
  buildTree,
  commitDetail,
  isSha,
  log as readLog,
  overview,
  parseStatus,
  pending,
  status as repoStatus,
  tree as readTree,
  workingTree,
} from "./repo.js"
import {
  commitRun,
  currentBranch,
  recentSubjects,
  runChanges,
  treeChanges,
  withSessionTrailer,
} from "./changes.js"
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

// A commit message is written by a MODEL and then written to a file that git
// reads. Remotely that file is created by `cat >` over ssh with the body on
// stdin, precisely so the message is never parsed by the far shell — put it on
// the command line instead and `$(…)`, a backtick or a quote in a subject line
// stops being prose and starts being something the far side evaluates. This
// pins the local half of that promise; the remote half shares `withMessageFile`
// and cannot diverge without this failing too.
{
  await writeFile(join(root, "hostile.ts"), "export const hostile = true\n", "utf8")
  const nasty = [
    "aide: $(echo pwned) and `echo also`",
    "",
    "A body with 'single' and \"double\" quotes, a $VAR, and a trailing backslash \\",
  ].join("\n")
  const hostileSha = await commitRun(root, ["hostile.ts"], nasty)
  const written = await git(root, ["log", "-1", "--format=%B", hostileSha])
  check(
    "a message is bytes, not something a shell evaluates",
    written.includes("$(echo pwned)") && written.includes("`echo also`"),
    written.split("\n")[0],
  )
  check(
    "and quotes, variables and backslashes survive it",
    written.includes("'single'") &&
      written.includes('"double"') &&
      written.includes("$VAR") &&
      written.includes("\\"),
  )
}

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

console.log("\nthe project's own brief")
{
  const { readProjectDoc } = await import("./registry.js")
  const { readRepoFile, refPath } = await import("./git.js")

  await writeFile(
    join(root, STATE_DIR, "project.md"),
    ["---", "verify:", "  - pnpm typecheck", "---", "", "# smoke", "", "What it is.", ""].join("\n"),
    "utf8",
  )
  const doc = await readProjectDoc(root)
  check("the brief is read", doc.body.includes("What it is."), `${doc.body.length} chars`)
  check(
    "and its verify: commands come with it",
    doc.verify.map((v) => v.command).join(",") === "pnpm typecheck",
    doc.verify.map((v) => v.command).join(",") || "(none)",
  )

  // The remote half cannot be exercised without a host, so what is pinned here
  // is the thing that made it wrong: a path built for the machine that HOLDS the
  // repo. `join` answers with backslashes on Windows, which a POSIX shell reads
  // as escapes rather than separators — so a remote path must be POSIX no matter
  // what platform the daemon runs on. Both halves share `readRepoFile`, so a
  // remote read cannot diverge from the local one that is asserted above.
  const remote = { root: "/root/code/app", host: "somewhere" }
  check(
    "a remote path is POSIX, whatever this machine spells paths like",
    refPath(remote, STATE_DIR, "project.md") === "/root/code/app/.aide/project.md",
    refPath(remote, STATE_DIR, "project.md"),
  )

  // A missing brief is a legal answer, NOT an error — and it has to stay legal,
  // because that is what a project with no `.aide/` looks like. It is also why
  // the remote bug was invisible for so long: reading the wrong machine's disk
  // produced exactly this, and nothing anywhere said so.
  check("a missing file reads as absent, not as a failure", (await readRepoFile(root, "no-such-file.md")) === null)
  const bare = await readProjectDoc(join(root, "does-not-exist"))
  check("and a project with no brief still answers", bare.body === "" && bare.verify.length === 0)
}

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
  // `ahead` rides in this call's existing batch so the push button can say what
  // it would send without costing the hardest-polled call a second connection.
  // Null is the load-bearing case and this repo is it: no remote, so there is
  // nothing to be ahead OF. Reporting 0 there would read as "in step" and
  // disable the button on exactly the branch that has never been pushed.
  check(
    "a repo with no upstream reports null, not zero",
    before.ahead === null,
    String(before.ahead),
    )

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
  // neither the refusal nor the button that clears it. Both sides are read the
  // way the app reads them — `pending` for the rail, `treeChanges` for the
  // commit — because the bug this guards against was those two answering
  // different questions, not either one answering its own question wrongly.
  const takeable = await treeChanges(root)
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
  // `ExitPlanMode` is the deliberate exception and must NOT be swept up by the
  // same rule: it ends the turn rather than parking it, so nothing is held while
  // the human reads. Not asserted here — the two are string literals, so tsc
  // rejects the comparison as provably false, which is a stronger guarantee than
  // a runtime check and costs nothing to keep.
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

console.log("\na failed turn says what failed")
{
  // Nine turns in this machine's logs ended in a failure that carried no reason
  // — one after 62 turns, 13 minutes and $9.59 — because the SDK's `errors` was
  // read by nobody. What follows five of them is the same message typed again
  // from memory. These pin the mapping that lost it.
  const { normalizeSdkMessage } = await import("./agent.js")
  const ctx = { taskId: "", projectId: "p1", cwd: root, fallbackModel: "m" }
  const finish = (m: Record<string, unknown>) => {
    const out = normalizeSdkMessage({ type: "result", ...m }, ctx)
    const ev = out.find((e) => e.type === "run.finished")
    return ev?.type === "run.finished" ? ev : null
  }

  check("a clean success is a success", finish({ subtype: "success", is_error: false })?.status === "success")
  check(
    "an error subtype keeps what the SDK said",
    finish({ subtype: "error_during_execution", errors: ["tool loop detected"] })?.errors?.[0] ===
      "tool loop detected",
    "the subtype names the wall; only this says what hit it",
  )
  check(
    "a turn that died on an API error is NOT filed as done",
    finish({ subtype: "success", is_error: true, result: "overloaded_error" })?.status === "failed",
    "the SDK puts the error text in `result` under subtype success; reading the subtype alone called that a finished turn",
  )
  check(
    "and its error text is kept too",
    finish({ subtype: "success", is_error: true, result: "overloaded_error" })?.errors?.[0] ===
      "overloaded_error",
  )
  check(
    "nothing to explain adds no field",
    finish({ subtype: "success", is_error: false })?.errors === undefined,
    "absent rather than empty, so every outcome written before this reads the same",
  )
  check("blank entries are dropped", finish({ subtype: "error_max_turns", errors: ["", "  "] })?.errors === undefined)
}

console.log("\nthe checks a commit has to get past")
{
  // The gate on the code was half a gate: an agent ran the project's checks
  // about two thirds of the time and then reported the result itself, so the
  // only evidence a diff was sound was a sentence written by the thing being
  // checked. These are the two halves of taking that out of the model's hands —
  // reading what the human declared, and running it.
  check("a project that declares none has no gate", parseProjectDoc("# hi").verify.length === 0)
  check(
    "the commands come off the frontmatter in order",
    parseProjectDoc("---\nverify:\n  - pnpm typecheck\n  - pnpm smoke\n---\nbody")
      .verify.map((v) => v.command)
      .join("|") === "pnpm typecheck|pnpm smoke",
  )
  check(
    "a bare command has no scope, so it always runs",
    parseProjectDoc("---\nverify:\n  - pnpm typecheck\n---\n").verify[0]?.unless.length === 0,
    "the old one-line form must keep meaning exactly what it meant",
  )
  {
    const scoped = parseProjectDoc(
      "---\nverify:\n  - run: pnpm smoke\n    unless: [packages/web, .aide/]\n---\n",
    ).verify[0]
    check("a scoped entry reads its command off `run:`", scoped?.command === "pnpm smoke")
    check(
      "and normalises the paths it is given",
      scoped?.unless.join("|") === "packages/web|.aide",
      "a trailing slash makes `packages/web/` and `packages/web` two different prefixes",
    )
  }
  check(
    "a scoped entry with no command throws",
    (() => {
      try {
        parseProjectDoc("---\nverify:\n  - unless: [packages/web]\n---\n")
        return false
      } catch {
        return true
      }
    })(),
    "settings with nothing to run is a gate entry that quietly does nothing",
  )
  check(
    "a path that could never match one throws",
    (() => {
      try {
        parseProjectDoc("---\nverify:\n  - run: pnpm smoke\n    unless: [/etc]\n---\n")
        return false
      } catch {
        return true
      }
    })(),
    "an absolute path matches nothing, so the scope silently does nothing",
  )
  check(
    "the prose still reaches the agent",
    parseProjectDoc("---\nverify:\n  - pnpm typecheck\n---\nthe brief").body === "the brief",
    "frontmatter aide acts on must not leak into what the model reads",
  )
  check(
    "a mistyped verify throws rather than silently opening the gate",
    (() => {
      try {
        parseProjectDoc("---\nverify: pnpm typecheck\n---\n")
        return false
      } catch {
        return true
      }
    })(),
    "a scalar where a list belongs would otherwise become an empty list, and every commit would sail through",
  )

  // Which checks a given diff is worth running. Every assertion here is about
  // the same property from a different angle: this may only ever skip a check
  // the diff provably cannot break, because the alternative is a gate that
  // silently stopped being one.
  {
    const gate = parseProjectDoc(
      "---\nverify:\n" +
        "  - pnpm typecheck\n" +
        "  - run: pnpm smoke\n    unless: [packages/web, CLAUDE.md]\n" +
        "  - run: pnpm build\n    unless: [packages/daemon]\n" +
        "---\n",
    ).verify
    const ran = (paths: string[]) =>
      planChecks(gate, paths).run.map((c) => c.command).join("|")

    check(
      "a web-only commit skips the git plumbing suite",
      ran(["packages/web/src/App.tsx", "CLAUDE.md"]) === "pnpm typecheck|pnpm build",
      "the whole point: twelve seconds not spent re-proving what nothing touched",
    )
    check(
      "a daemon-only commit skips the bundle instead",
      ran(["packages/daemon/src/chat.ts"]) === "pnpm typecheck|pnpm smoke",
    )
    check(
      "ONE path outside the scope brings the check back",
      ran(["packages/web/src/App.tsx", "packages/daemon/src/git.ts"]) ===
        "pnpm typecheck|pnpm smoke|pnpm build",
      "skipping needs every path covered, not most of them",
    )
    check(
      "a path nobody anticipated counts as relevant",
      ran(["packages/protocol/src/events.ts"]) === "pnpm typecheck|pnpm smoke|pnpm build",
      "this is why `unless` names irrelevance: an unlisted file must not silence a check",
    )
    check(
      "a prefix does not match a sibling that merely starts the same way",
      ran(["packages/web-extras/thing.ts"]) === "pnpm typecheck|pnpm smoke|pnpm build",
      "`packages/web` covering `packages/web-extras` would skip a check over a name collision",
    )
    check(
      "an unscoped check is never skipped",
      planChecks(gate, ["packages/web/src/App.tsx"]).run.some((c) => c.command === "pnpm typecheck"),
    )
    check(
      "and a diff nobody could read runs everything",
      ran([]) === "pnpm typecheck|pnpm smoke|pnpm build",
      "\"we cannot tell what changed\" has to mean run them, or this becomes a way past the gate",
    )
    check(
      "a skipped check says why, naming only the paths that did the covering",
      planChecks(gate, ["packages/web/src/App.tsx"]).skipped[0]?.reason ===
        "everything that changed is under packages/web",
      "CLAUDE.md is in the scope but not in this diff; listing it would read as an explanation",
    )
  }

  const ok = await runCheck("git --version", root).done
  check("a passing check reports its exit code", ok.ok && ok.exitCode === 0, ok.output.slice(0, 40))
  const bad = await runCheck("git nope-not-a-command", root).done
  check("a failing one does not", !bad.ok && bad.exitCode !== 0)
  check("and it keeps what the command printed", /nope-not-a-command/.test(bad.output), bad.output.slice(0, 60))

  const seen: string[] = []
  const run = await runChecks(["git --version", "git nope-not-a-command", "git --version"], root, {
    onResult: (r) => seen.push(r.command),
  })
  check(
    "the run stops at the first failure",
    seen.length === 2 && run.failed?.command === "git nope-not-a-command",
    `ran ${seen.length}`,
  )
  check(
    "all-green reports nothing failed",
    (await runChecks(["git --version"], root)).failed === null,
  )
  check(
    "a stop is honoured before the next check",
    (await runChecks(["git --version", "git --version"], root, { stopped: () => true })).results
      .length === 0,
    "a human who pressed stop is not waiting out a ten-minute build",
  )
}

console.log("\nthe gate is re-read after the fix, not just the tree")
{
  const { commitWorkingTree } = await import("./review.js")

  // `.aide/project.md` is a file in the tree the commit is about to take, so the
  // one repair attempt can rewrite the GATE as well as the code — and when the
  // gate is what is broken, that is the only fix there is. Watched failing for
  // real: a project whose `verify:` called `pnpm` on a host with no pnpm, where
  // the agent correctly rewrote the block to call `node_modules/.bin` directly
  // and the retry ran `pnpm exec tsc -b` a second time anyway. One automatic
  // attempt that cannot reach the thing it needs to change is not an attempt.
  //
  // The stub is the whole test: `verify` is a reader, so counting how many times
  // it is CALLED is how you tell a gate that re-reads from one that was frozen
  // when the run started.
  await writeFile(join(root, "gate-work.txt"), "something to commit\n", "utf8")
  let reads = 0
  let repairs = 0
  const commands = ["git nope-not-a-command", "git --version"]
  const spend = await commitWorkingTree({
    project: { id: "p", name: "n", root, addedAt: "" },
    sessionId: null,
    request: "",
    // Fails on the first pass, passes on the second — exactly what fixing the
    // gate itself looks like from in here.
    verify: async () => [{ command: commands[reads++] ?? "git --version", unless: [] }],
    force: false,
    // The throwaway repo has no remote, and this is not what is under test here.
    push: false,
    hasUpstream: false,
    repair: async () => {
      repairs += 1
      return { status: "success", costUsd: 0, modelUsage: {}, errors: [] }
    },
    emit: () => {},
    delta: () => {},
    stopped: () => false,
  })

  check("the gate was asked for twice, not once", reads === 2, `${reads}`)
  check("and the one repair attempt ran", repairs === 1, `${repairs}`)
  check(
    "so a commit whose fix corrected the gate goes through",
    Boolean(spend),
    "with the gate read once, the retry re-runs the command the fix removed and refuses forever",
  )
  await git(root, ["reset", "--hard", "HEAD~1"])
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

console.log("\nnumbering the history")
{
  // The number beside a commit is the one thing on that row a human tracks
  // across days, so what it must not be is the row's position on the page —
  // that slides down by one for every commit made after it, and a progress
  // counter that renumbers the past counts nothing.
  const page = await readLog(root, 50)
  const total = Number((await git(root, ["rev-list", "--count", "--first-parent", "HEAD"])).trim())
  const firstEver = (await git(root, ["rev-list", "--max-parents=0", "HEAD"])).trim().split("\n")[0]
  // Off the page rather than out of `rev-parse HEAD^2`: the merge's parents are
  // already on the wire, and the second of them is the commit that arrived on
  // the branch.
  const arrived = page.commits.find((c) => c.sha === landed.sha)?.parents[1]

  check(
    "HEAD's number is how many there are",
    page.numbers[landed.sha] === total,
    `${page.numbers[landed.sha]} of ${total}`,
  )
  check("the first commit ever made is 1", page.numbers[firstEver ?? ""] === 1)

  const mainline = (await git(root, ["rev-list", "--first-parent", "HEAD"]))
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
  check(
    "every step down the line is one lower",
    mainline.every((sha, i) => page.numbers[sha] === total - i),
    `${mainline.length} commits on the line`,
  )

  check(
    "a commit that arrived on a branch has none",
    arrived !== undefined && page.numbers[arrived] === undefined,
    "a plausible wrong number is worse than a blank column",
  )

  // The assertion the whole design is for. Asked for three rows instead of
  // fifty, a position-derived number would call this commit 1.
  const short = await readLog(root, 3)
  check(
    "a shorter page numbers them the same",
    short.numbers[landed.sha] === total,
    `${short.numbers[landed.sha]} either way`,
  )
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

console.log("\nthe tree of files")
{
  // The rail's other reading of the repo. Everything here fails QUIETLY if it
  // fails: a prefix compared without its slash puts one directory's files under
  // another's name, a deleted file stays in the list as a row that opens
  // nothing, and a folder that knows only about its own children goes unmarked
  // over a change three levels down. None of those look wrong on screen.

  // `-z` output, as `ls-tree` really writes it: `<mode> <type> <sha>\t<path>`.
  const entry = (type: string, path: string) => `100644 ${type} ${"0".repeat(40)}\t${path}`
  const lsTree = [
    entry("tree", "src"),
    // The sibling whose name BEGINS with the directory under test. This is the
    // one that catches a prefix compared as `src` rather than as `src/`.
    entry("tree", "src2"),
    entry("blob", "README.md"),
  ].join("\0")

  const rootLevel = buildTree("", lsTree, [
    { path: "src/deep/new.ts", from: null, code: "??", staged: null, unstaged: "untracked" },
  ])
  check(
    "directories come before files",
    rootLevel.map((e) => e.kind).join(",") === "directory,directory,file",
    rootLevel.map((e) => `${e.name}:${e.kind}`).join(" "),
  )
  check(
    "a folder is marked from a change any depth below it",
    rootLevel.find((e) => e.name === "src")?.dirty === true,
    "the mark is what you navigate by, so it cannot stop at the first level",
  )
  check(
    "and a folder whose name merely starts the same is not",
    rootLevel.find((e) => e.name === "src2")?.dirty === false,
    "src/ vs src — the slash is the whole check",
  )

  const inner = buildTree("src", entry("blob", "src/app.ts"), [
    { path: "src/app.ts", from: null, code: " M", staged: null, unstaged: "modified" },
    { path: "src/deep/new.ts", from: null, code: "??", staged: null, unstaged: "untracked" },
  ])
  check(
    "a file carries its own status",
    inner.find((e) => e.name === "app.ts")?.state === "modified",
    "so the tree and the list above it colour one file one way",
  )
  check(
    "an untracked file two levels down contributes its directory",
    inner.find((e) => e.name === "deep")?.kind === "directory",
    "`ls-tree` has never heard of an untracked folder, so nothing else would list it",
  )
  check(
    "and that directory is not also listed as a file",
    inner.filter((e) => e.name === "deep").length === 1,
    `${inner.map((e) => e.name).join(",")}`,
  )

  const gone = buildTree("", entry("blob", "old.ts"), [
    { path: "old.ts", from: null, code: " D", staged: null, unstaged: "deleted" },
  ])
  check(
    "a deleted file is not in the tree",
    gone.length === 0,
    "it is in HEAD and not on disk; a row that opens nothing is worse than no row",
  )

  const moved = buildTree("", [entry("blob", "was.ts"), entry("blob", "now.ts")].join("\0"), [
    { path: "now.ts", from: "was.ts", code: "R ", staged: "renamed", unstaged: null },
  ])
  check(
    "a rename leaves its old name behind",
    moved.map((e) => e.name).join(",") === "now.ts",
    `${moved.map((e) => e.name).join(",")} — git names both in one entry, so the old one has to be dropped by hand`,
  )

  // And against the real repository, which is what says the flags above are the
  // ones git actually wants — a `ls-tree HEAD src` without its trailing slash
  // returns the directory itself and every folder opens to show only itself.
  await mkdir(join(root, "nested"), { recursive: true })
  await writeFile(join(root, "nested", "leaf.ts"), "export const leaf = 1\n", "utf8")
  await git(root, ["add", "-A"])
  await git(root, ["commit", "-m", "Add a nested file"])

  const top = await readTree(root, "")
  check("reads the root", top.entries.some((e) => e.name === "README.md"), top.entries.map((e) => e.name).join(","))
  check("finds the directory", top.entries.some((e) => e.name === "nested" && e.kind === "directory"))
  check(
    "the root lists no nested paths",
    top.entries.every((e) => !e.path.includes("/")),
    "one level at a time is the whole design",
  )

  const sub = await readTree(root, "nested")
  check(
    "opens a directory to its contents, not to itself",
    sub.entries.length === 1 && sub.entries[0]?.name === "leaf.ts",
    `${sub.entries.map((e) => e.name).join(",")} — without the trailing slash ls-tree answers with the folder`,
  )
  check("and the path it reports is the full one", sub.entries[0]?.path === "nested/leaf.ts")

  // A LOCAL project prefetches nothing, and that asymmetry is worth pinning
  // because it is invisible: the feature it turns off is a latency fix for a
  // 1.4s ssh handshake, and here a read is ~30ms. Prefetching locally would be
  // an `ls-tree` per directory on screen, every time, bought on the chance
  // somebody expands one.
  check(
    "a local read prefetches nothing",
    Object.keys(top.children).length === 0,
    "there is no handshake to amortise, so this would be work done on spec",
  )
}

// ---------------------------------------------------------------------------
console.log("\ncommitting, with a conversation to attribute it to")
// The commit gate end to end. The message is supplied here rather than drafted,
// so this exercises the git plumbing without spending anything.
{
  const { commitTree } = await import("./review.js")

  const session = "11111111-2222-3333-4444-555555555555"
  const project = { id: "p", name: "p", root, addedAt: "" }

  // A conversation begins: snapshot first, then the agent writes.
  const baseline = await takeCheckpoint(root, session)
  await writeFile(join(root, "wobble.txt"), "it wobbles\n", "utf8")

  const rail = await pending(root)
  const changes = await treeChanges(root)
  check(
    "what a commit takes is exactly what the rail lists",
    [...changes.paths].sort().join(",") === rail.files.map((f) => f.path).sort().join(","),
    changes.paths.join(","),
  )

  const sha = await commitTree({
    project,
    sessionId: session,
    paths: changes.paths,
    message: "Teach the widget to wobble",
  })
  check("it commits", /^[0-9a-f]{40}$/.test(sha), sha.slice(0, 8))

  const body = await git(root, ["log", "-1", "--format=%B"])
  check("and its session, which outlives every run in it", body.includes(`Aide-Session: ${session}`))

  const tracked = await git(root, ["show", "--name-only", "--format=", "HEAD"])
  check("it commits what the agent wrote", tracked.includes("wobble.txt"))

  check(
    "the work is visible in the project itself",
    existsSync(join(root, "wobble.txt")),
    "no worktree to go and look in — this IS the tree the dev server serves",
  )
  check(
    "and the rail is empty afterwards",
    (await pending(root)).files.length === 0,
    "a commit that leaves files in the rail leaves the project blocked from its next chat",
  )
  check(
    "and the checkpoint is still there to undo it",
    (await readCheckpoint(root, session))?.sha === baseline.sha,
    "committing must not throw away the only way back",
  )
}

// ---------------------------------------------------------------------------
console.log("\ncommitting work no conversation made")
// The wedge this whole path was rebuilt for. A tree gets dirty from things that
// are not chats — your own editor, a formatter, an install that rewrote a
// lockfile — and while it is dirty the daemon refuses to start a new
// conversation. The button that clears it used to measure against a
// conversation's checkpoint and so could not be pressed without one open, which
// left the project blocked with no way out of aide at all.
{
  const { commitTree } = await import("./review.js")
  const project = { id: "p", name: "p", root, addedAt: "" }

  await writeFile(join(root, "by-hand.txt"), "typed into an editor\n", "utf8")
  check(
    "it shows in the rail, which blocks the next chat",
    (await pending(root)).files.some((f) => f.path === "by-hand.txt"),
  )

  const changes = await treeChanges(root)
  check("and a commit can take it with no conversation at all", changes.paths.includes("by-hand.txt"))

  const sha = await commitTree({
    project,
    sessionId: null,
    paths: changes.paths,
    message: "Add a note",
  })
  check("it commits", /^[0-9a-f]{40}$/.test(sha), sha.slice(0, 8))
  check(
    "with no session trailer",
    !(await git(root, ["log", "-1", "--format=%B"])).includes("Aide-Session"),
    "pointing it at whichever chat was on screen would be a lie in the permanent record",
  )
  check(
    "and the block lifts",
    (await pending(root)).files.length === 0,
    "the list that refuses the next chat and the list the button takes are one list",
  )
}

// ---------------------------------------------------------------------------
console.log("\nthe first commit in a repository that has none")
// Its own repo, because there is exactly one moment in a project's life when
// HEAD does not resolve and it cannot be reached from the one above. Naming HEAD
// to `diff --cached` there is a fatal rather than an empty diff, so getting this
// wrong means aide can never make a first commit — and never says why.
{
  const { commitTree } = await import("./review.js")
  const fresh = await mkdtemp(join(tmpdir(), "aide-smoke-unborn-"))
  await git(fresh, ["init", "-b", "main"])
  await git(fresh, ["config", "user.email", "smoke@aide.test"])
  await git(fresh, ["config", "user.name", "aide smoke"])
  await writeFile(join(fresh, "first.txt"), "hello\n", "utf8")

  const changes = await treeChanges(fresh)
  check("the diff is against the empty tree", changes.paths.includes("first.txt"), changes.paths.join(","))
  check("and it has hunks to read", changes.diff.includes("+hello"))

  const sha = await commitTree({
    project: { id: "p", name: "p", root: fresh, addedAt: "" },
    sessionId: null,
    paths: changes.paths,
    message: "Add the first file",
  })
  check("it commits", /^[0-9a-f]{40}$/.test(sha), sha.slice(0, 8))
  check("and the rail is empty afterwards", (await pending(fresh)).files.length === 0)
  await rm(fresh, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// ~/.aide/ssh_config
// ---------------------------------------------------------------------------
//
// A parser over a hand-edited file, which is the one kind of input this project
// validates rather than trusting. It does not throw on a bad line — a machine
// that fails to appear is visible in the picker, unlike a `verify:` gate that
// silently stops running — so what is asserted here is that the SHAPES people
// actually write come back right.
console.log("\nssh config")
{
  const hosts = parseSshConfig(`
Host raspberrypi.local
  HostName raspberrypi.local
  User pi

Host 192.168.3.161
  HostName 192.168.3.161
  User orangepi

Host orangepi
    HostName 192.168.3.81
    User orangepi
    IdentityFile ~/.ssh/id_ed25519

Host tg
  HostName 88.214.24.214
  User root
`)
  check("every host is found", hosts.length === 4, String(hosts.length))
  // Four-space indentation, which the file above mixes with two on purpose:
  // OpenSSH does not care and neither may this.
  const orange = hosts.find((h) => h.alias === "orangepi")
  check("an alias keeps its own HostName", orange?.hostName === "192.168.3.81", orange?.hostName)
  check("indentation does not matter", orange?.user === "orangepi", String(orange?.user))
  check("IdentityFile is kept unexpanded", orange?.identityFile === "~/.ssh/id_ed25519")
  // `~` stays as written: only the daemon knows whose home directory this is,
  // and expanding it here would bake this machine's path into the wire type.
  check("and the alias is what ssh is handed", sshTarget(orange!) === "orangepi@orangepi")
  const pi = hosts.find((h) => h.alias === "raspberrypi.local")
  check("a host with no key parses", pi?.identityFile === null && pi?.user === "pi")
  check("a port defaults to unstated", pi?.port === null)
}

{
  // The shapes OpenSSH allows that the file above does not use. Each of these
  // silently dropped a host or a setting at some point while this was written.
  const hosts = parseSshConfig(
    [
      "Host *",
      "  User nobody",
      "Host a b",
      "  HostName shared.example",
      "  Port 2222",
      "Host eq",
      "  HostName=equals.example",
      "HOST upper",
      "  hostname UPPER.example",
      "  USER Bob",
      'Host quoted',
      '  IdentityFile "C:/Program Files/key"',
    ].join("\n"),
  )
  const byAlias = (alias: string) => hosts.find((h) => h.alias === alias)
  check("a wildcard block parses", byAlias("*")?.user === "nobody")
  check("but is not offered as a machine", !connectableHosts(hosts).some((h) => h.alias === "*"))
  // One `Host` line naming two aliases is two rows sharing every keyword under
  // it — the bug being guarded is the settings reaching only the last one.
  check("two aliases on one line both appear", !!byAlias("a") && !!byAlias("b"))
  check("and both get the shared settings", byAlias("a")?.port === 2222 && byAlias("b")?.hostName === "shared.example")
  check("`Key=value` is read", byAlias("eq")?.hostName === "equals.example")
  // Keywords are case-insensitive, values are not: a username's case matters.
  check("keywords ignore case", byAlias("upper")?.hostName === "UPPER.example")
  check("values keep theirs", byAlias("upper")?.user === "Bob")
  check("quotes are stripped from a path", byAlias("quoted")?.identityFile === "C:/Program Files/key")
}

{
  // The bug that made `siblings` a local: held at module scope it survived
  // between calls, so a file beginning with a stray keyword wrote onto the last
  // host of whatever was parsed before it.
  const first = parseSshConfig("Host one\n  User first\n")
  const second = parseSshConfig("User ghost\nHost two\n  User second\n")
  check("a global keyword before any Host is ignored", second.length === 1 && second[0]?.user === "second")
  check("and does not reach the previous parse", first[0]?.user === "first")
}

{
  // What ssh says, turned into what to do about it. The two host-key failures
  // are the point: they end in the SAME "Host key verification failed" line,
  // and the advice for one is useless for the other. Getting this wrong sends
  // someone round a loop running a command that cannot work — which it did,
  // against a real machine, before these were separated.
  const host = { alias: "tg", hostName: "88.214.24.214", user: "root", identityFile: null, port: null, line: 1 }

  const changed = cleanSshError(
    [
      "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@",
      "Offending ECDSA key in /c/Users/loki/.ssh/known_hosts:28",
      "Host key verification failed.",
    ].join("\n"),
    host,
  )
  check("a changed host key is not called an unknown one", !/unknown host key/.test(changed))
  check("and it names the line to remove", changed.includes("known_hosts line 28"), changed.slice(0, 60))
  // aide must not offer to clear it: this is also what interception looks like.
  check("and it does not offer to fix it", !/keygen|aide will clear/i.test(changed))

  const unknown = cleanSshError("No ECDSA host key is known for tg\nHost key verification failed.", host)
  check("an unknown key still says to accept it once", unknown.includes("ssh root@tg"), unknown.slice(0, 50))

  const denied = cleanSshError("root@tg: Permission denied (publickey).", host)
  check("a refused key says aide never asks for a password", /never asks for a password/.test(denied))

  // Anything unrecognised still reaches the person, on one line.
  const other = cleanSshError("ssh: connect to host tg port 22: Connection timed out\n", host)
  check("an unclassified error is passed through", other === "tg: ssh: connect to host tg port 22: Connection timed out")
}

// ---------------------------------------------------------------------------
// The runner seam
// ---------------------------------------------------------------------------
//
// `chat.ts` drives its agent through `Runner`, so a project on another machine
// can put an ssh transport behind the same protocol. What is asserted here is
// the property that makes that possible and that a refactor could quietly lose:
// the interface is satisfiable by something that is NOT a child process.
//
// This is a compile-time claim as much as a runtime one — if `Runner` ever grows
// a member only a local `ChildProcess` can provide (a pid, a stdio handle), this
// object stops type-checking, which is the point at which the seam has closed.
console.log("\nrunner seam")
{
  const outbox: ToWorker[] = []
  // Typed through a holder rather than a bare `let`: assigning the callback
  // inside `onMessage` and reading it later narrows a plain local to `never`.
  const sink: { deliver: ((msg: FromWorker) => void) | null } = { deliver: null }
  let killed = false

  const fake: Runner = {
    send: (msg) => outbox.push(msg),
    onMessage: (fn) => {
      sink.deliver = fn
    },
    onError: () => {},
    onExit: () => {},
    kill: () => {
      killed = true
    },
  }

  fake.send({ cmd: "interrupt" })
  check("a runner needs no process to send", outbox[0]?.cmd === "interrupt")

  // Both directions, because a transport that can only talk is not a seam.
  const inbox: FromWorker[] = []
  fake.onMessage((m) => inbox.push(m))
  sink.deliver?.({ type: "ready" })
  check("and none to be heard from", inbox[0]?.type === "ready")

  fake.kill()
  // `kill()` rather than a pid, which is the one thing a remote runner could not
  // honestly provide: `killTree` is taskkill against a LOCAL process id.
  check("and it is stopped without a pid", killed)
}

{
  // The framing an ssh transport rides on. A pipe is a byte stream, so the one
  // thing that must hold is that a message survives being cut anywhere — this
  // is the bug that works on short messages and fails on a pasted screenshot.
  const frame = (msgs: FromWorker[]) => msgs.map((m) => `${JSON.stringify(m)}\n`).join("")
  const messages: FromWorker[] = [
    { type: "ready" },
    { type: "done", runId: "r1", interrupted: false },
    // A payload with newlines and quotes IN it, which is what makes the frame
    // ambiguous if anything but JSON string-escaping is trusted.
    { type: "event", runId: "r2", body: { type: "assistant.text", text: 'line\none"two', parentToolUseId: null } },
  ]
  const wire = frame(messages)
  check("a newline never appears raw inside a framed message", wire.split("\n").length === 4, `${wire.split("\n").length - 1} lines`)

  // Reassemble it one byte at a time — the worst case a chunked pipe can hand
  // over, and the one a naive `chunk.split("\n")` fails.
  const got: FromWorker[] = []
  let buffer = ""
  for (const ch of wire) {
    buffer += ch
    let cut = buffer.indexOf("\n")
    while (cut !== -1) {
      const line = buffer.slice(0, cut).trim()
      buffer = buffer.slice(cut + 1)
      if (line) got.push(JSON.parse(line) as FromWorker)
      cut = buffer.indexOf("\n")
    }
  }
  check("byte-at-a-time delivery reassembles every message", got.length === 3, `${got.length} of 3`)
  const text = got[2]?.type === "event" && got[2].body.type === "assistant.text" ? got[2].body.text : ""
  check("and a payload's own newline survives it", text === 'line\none"two', JSON.stringify(text))
}

// ---------------------------------------------------------------------------
// Project ids, once a project can live somewhere else
// ---------------------------------------------------------------------------
//
// The id is a content hash of where a project is, and "where" grew a second
// half. What is asserted is the pair that makes the registry correct: two
// machines must not collide, and a LOCAL id must not have changed — every entry
// already in `registry.json` keeps its value, and its board links with it.
// Batching several reads into one round trip is what makes a remote project's
// rail usable, and the delimiter is the whole of its correctness. Asserted
// LOCALLY — `gitBatch` runs the commands in parallel here rather than over ssh —
// so what is pinned is that both paths answer identically. The remote form's own
// hazard is that `git status -z` ends in a NUL with no newline, so a delimiter
// that adds a byte of its own splits the output one byte early and the rail's
// file list comes back mangled; that is why the remote script uses `printf %s`
// and not `echo`.
console.log("\nbatched reads")
{
  const { gitBatch } = await import("./git.js")
  const [branch, statusZ, bogus] = await gitBatch(root, [
    ["rev-parse", "--abbrev-ref", "HEAD"],
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    ["rev-parse", "--verify", "refs/heads/does-not-exist"],
  ])
  check("a batch answers each command in order", (branch ?? "").trim() === "main", (branch ?? "").trim())
  // The one that must survive a delimiter: NUL-separated, no trailing newline.
  const named = (statusZ ?? "").split("\0").filter(Boolean)
  check(
    "NUL-separated output is not truncated or split early",
    named.every((entry) => /^.. \S/.test(entry)),
    named.join(" | ").slice(0, 60),
  )
  check(
    "and it agrees with the same call made alone",
    named.length === (await repoStatus(root)).length,
  )
  // A failing command must not take the batch down with it — the questions are
  // independent, and "no upstream" must not cost you the branch name.
  check("a failing command yields empty rather than aborting", (bogus ?? "").trim() === "")

  // The batch carries an env, which is what lets the three reads of a SCRATCH
  // index share one round trip — the thing that took a remote commit's first
  // step from eight ssh connections to two. If this stops being honoured the
  // reads silently fall back to the REAL index: no error, just a diff measured
  // against the human's staging area instead of the working tree.
  const { withWorkingTreeIndex } = await import("./git.js")
  // Dirtied on purpose, and with an UNTRACKED file specifically: it is in the
  // working tree and not in the real index, so it is the one reading that tells
  // the two indexes apart. Against a clean tree both answer empty and the check
  // below passes without proving anything.
  await writeFile(join(root, "batch-edit.ts"), "export const batched = true\n", "utf8")
  const before = await repoStatus(root)
  const [batchDiff, batchNames] = await withWorkingTreeIndex(root, (_g, batchTemp) =>
    batchTemp([
      ["diff", "--cached", "--stat", "HEAD", "--"],
      ["diff", "--cached", "--name-only", "-z", "HEAD", "--"],
    ]),
  )
  const batched = (batchNames ?? "").split("\0").filter(Boolean)
  check(
    "a batched read sees the scratch index, not the real one",
    batched.includes("batch-edit.ts") && (batchDiff ?? "").includes("batch-edit.ts"),
    `${batched.length} paths`,
  )
  check(
    "and the human's own index is untouched by it",
    JSON.stringify(await repoStatus(root)) === JSON.stringify(before),
  )
}

console.log("\nproject identity")
{
  const { projectIdFor } = await import("./registry.js")

  const a = projectIdFor("/root/code", "tg")
  const b = projectIdFor("/root/code", "orangepi")
  check("the same path on two machines is two projects", a !== b, `${a} vs ${b}`)
  check("and each is stable", projectIdFor("/root/code", "tg") === a)

  // The local form is unchanged: hostless, resolved, lower-cased. If this ever
  // fails, every project on disk has been renamed.
  const local = projectIdFor("C:/Users/loki/code/aide")
  const expected = createHash("sha1")
    .update(resolve("C:/Users/loki/code/aide").toLowerCase())
    .digest("hex")
    .slice(0, 12)
  check("a local id is what it always was", local === expected, local)
  check("and differs from the same path claimed by a host", local !== projectIdFor("C:/Users/loki/code/aide", "tg"))

  // A remote root is NOT resolved against this filesystem — `resolve("/root")`
  // on Windows is `C:\root` — nor lower-cased, because POSIX paths are
  // case-sensitive and `/root/Code` is a different directory from `/root/code`.
  check("a remote path keeps its case", projectIdFor("/root/Code", "tg") !== projectIdFor("/root/code", "tg"))
}

console.log("\nactivity")
{
  const { localDay, reduceActivity, windowStart } = await import("./activity.js")
  const { projectIdFor } = await import("./registry.js")

  // A fixed local noon, so nothing here depends on when the suite is run. Noon
  // rather than midnight: a test anchored to a day boundary passes or fails on
  // which side of it the machine's timezone falls.
  const now = new Date(2026, 8, 2, 12, 0, 0).getTime()
  const at = (daysAgo: number, hour = 12) =>
    new Date(2026, 8, 2 - daysAgo, hour, 0, 0).getTime()

  const run = (
    id: string,
    projectId: string,
    sessionId: string,
    openedAt: number,
    costUsd: number,
    tokens: number,
    model = "opus",
  ) => ({
    runId: id,
    sessionId,
    projectId,
    openedAt,
    activeMs: 1000,
    costUsd,
    tokens,
    byModel: { [model]: { costUsd, tokens } },
  })

  const alpha = projectIdFor("C:/tmp/alpha")
  const beta = projectIdFor("C:/tmp/beta")
  const projects = [
    { id: alpha, name: "alpha", root: "C:/tmp/alpha", addedAt: "2026-08-01T00:00:00Z" },
    { id: beta, name: "beta", root: "/root/beta", host: "tg", addedAt: "2026-08-01T00:00:00Z" },
  ]

  const runs = [
    run("r1", alpha, "s1", at(0), 1, 100),
    run("r2", alpha, "s1", at(1), 2, 200),
    run("r3", alpha, "s2", at(2), 3, 300),
    run("r4", beta, "s3", at(3), 4, 400, "sonnet"),
    // Outside a 7-day window, inside a 30-day one. This is the run that catches
    // an off-by-one in the window arithmetic.
    run("r5", alpha, "s4", at(8), 8, 800),
    // A project the registry no longer has.
    run("r6", "deadbeef0000", "s5", at(1), 5, 500),
  ]

  const week = reduceActivity(runs, projects, now, 7, [], 0)

  check("a run from today is in the window", week.runs === 5, `${week.runs}`)
  check("and one from eight days ago is not", !week.daily.some((d) => d.day === localDay(at(8))))
  check(
    "a 30-day window reaches back further",
    reduceActivity(runs, projects, now, 30, [], 0).runs === 6,
  )

  // The arithmetic that has to hold or the page lies: every breakdown sums to
  // the headline it sits under. Verified against the real logs at 373 runs and
  // $859.57 when this was written; pinned here so it stays true.
  const sumBy = (ns: number[]) => ns.reduce((a, b) => a + b, 0)
  check(
    "the project table sums to the total",
    Math.abs(sumBy(week.projects.map((p) => p.costUsd)) - week.costUsd) < 1e-9,
  )
  check(
    "the daily bars sum to the total",
    Math.abs(sumBy(week.daily.map((d) => d.costUsd)) - week.costUsd) < 1e-9,
  )
  check(
    "the model split sums to the total tokens",
    sumBy(week.models.map((m) => m.tokens)) === week.tokens,
  )
  check("shares sum to 1", Math.abs(sumBy(week.projects.map((p) => p.share)) - 1) < 1e-9)

  // Conversations, not runs: three runs over two sessions in alpha, and the
  // count that matters for "how many pieces of work" is the sessions.
  const alphaRow = week.projects.find((p) => p.projectId === alpha)
  check("a project counts chats, not turns", alphaRow?.chats === 2, `${alphaRow?.chats}`)
  check("and counts its turns too", alphaRow?.runs === 3, `${alphaRow?.runs}`)
  check("the newest run dates the row", alphaRow?.lastRunAt === at(0))

  // A removed project keeps its history rather than vanishing, or the table
  // would stop summing to the total above it.
  const gone = week.projects.find((p) => p.projectId === "deadbeef0000")
  check("a removed project still has a row", gone !== undefined)
  check("and is named as unknown rather than dropped", gone?.name === null)
  check("a remote project carries its host", week.projects.find((p) => p.projectId === beta)?.host === "tg")

  // The empty days are the signal. A chart that omits them draws a solid week
  // over a week that had four days in it.
  check("every day in the window gets a bucket", week.daily.length === 7, `${week.daily.length}`)
  check("including the ones with nothing in them", week.daily.some((d) => d.runs === 0))
  check("oldest first", (week.daily[0]?.day ?? "") < (week.daily[6]?.day ?? ""))
  check("and today is last", week.daily[6]?.day === localDay(now))

  // Lifetime ignores the window entirely — it is the one figure on the page
  // that answers "since when", so a window filter leaking into it would make
  // the number shrink as you narrowed the view.
  check("lifetime counts every run", week.lifetime.runs === 6)
  check("lifetime cost ignores the window", Math.abs(week.lifetime.costUsd - 23) < 1e-9)
  check("and lifetime starts at the oldest run", week.lifetime.since === at(8))

  // The window a query string asks for, as `/api/activity` reads it. Kept in
  // step with the route by hand, which is worth it for the one case that is
  // wrong in the obvious spelling: `Number("")` is 0, not NaN, so an empty
  // `?days=` clamps to a ONE-day window instead of falling back to the default
  // — a parameter that looks absent quietly asking for today only.
  const askedDays = (asked: unknown) => {
    const n = typeof asked === "string" && asked.trim() !== "" ? Number(asked) : Number.NaN
    return Number.isFinite(n) ? Math.min(365, Math.max(1, Math.floor(n))) : 30
  }
  check("an empty ?days= is the default, not one day", askedDays("") === 30, `${askedDays("")}`)
  check("an absent one too", askedDays(undefined) === 30)
  check("nonsense too", askedDays("banana") === 30)
  check("zero and below clamp up", askedDays("0") === 1 && askedDays("-5") === 1)
  check("and a huge window clamps down", askedDays("99999") === 365)

  check("no runs is not a crash", reduceActivity([], projects, now, 7, [], 0).runs === 0)
  check("and shares do not divide by zero", reduceActivity([], projects, now, 7, [], 0).projects.length === 0)

  // Local days, not UTC. A turn taken at 1am belongs to that date for the
  // person who took it; `toISOString()` files it under the day before for
  // anyone west of Greenwich, and only for the turns taken late at night.
  check("a 1am run stays on its own local day", localDay(at(0, 1)) === localDay(at(0, 23)))
  check(
    "a window starts at local midnight",
    new Date(windowStart(now, 7)).getHours() === 0,
  )
  check("and spans the right number of days", (now - windowStart(now, 7)) / 86400000 > 6)
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
