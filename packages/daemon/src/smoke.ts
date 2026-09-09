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
 * It is deliberately not a test framework: one command, plain output, and an
 * assertion that is a function call rather than a registration. Three files
 * rather than one, though — `smoke-policy.ts` holds the checks that need no
 * repository, and `smoke-check.ts` the single `check` and failure count they
 * share. Everything here needs the repository built below, in the order it is
 * built, which is why the rest did not follow.
 */
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises"
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
import type { Project, RunEvent, RunStatus } from "@aide/protocol"
import { check, report } from "./smoke-check.js"

const run = promisify(execFile)
const git = async (cwd: string, args: string[]) =>
  (await run("git", ["-C", cwd, ...args], { windowsHide: true })).stdout

// The assertion and the tally are shared with `smoke-policy.ts` — see there, and
// see `smoke-check.ts` for why one counter rather than one per file.


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

// The checks that need no repository, in the place they used to be written out.
// A dynamic import rather than a static one at the top, and that is the whole
// reason it is down here: a static `import` is hoisted and evaluated before the
// first line of this file runs, so its output would print above `repo: <path>`
// and above the checkpoint section — the run would still be correct and would
// read as though the sections had been shuffled.
await import("./smoke-policy.js")

console.log("\na failed turn says what failed")
{
  // Nine turns in this machine's logs ended in a failure that carried no reason
  // — one after 62 turns, 13 minutes and $9.59 — because the SDK's `errors` was
  // read by nobody. What follows five of them is the same message typed again
  // from memory. These pin the mapping that lost it.
  const { normalizeSdkMessage } = await import("./agent.js")
  const ctx = { projectId: "p1", cwd: root, fallbackModel: "m" }
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

console.log("\na commit whose message could not be written")
{
  const { fallbackMessage } = await import("./review.js")

  // The drafting is the one part of a commit that can fail for a reason that has
  // nothing to do with the work, and it used to take the commit down with it: a
  // helper budget sized against the OUTPUT met a prompt carrying the whole diff,
  // and a 14-file tree died on `Reached maximum budget ($0.5)` after the checks
  // had already been paid for. The button that exists to clear the rail could not
  // clear it. So a failed draft degrades to this instead of throwing.
  const msg = fallbackMessage("fix the IMU health tab", ["src/a.ts", "src/b.ts"])
  const [subject, blank] = msg.split("\n")
  check("the request becomes the subject", subject === "fix the IMU health tab", subject)
  check(
    "and a blank line follows it",
    blank === "",
    "a body running straight on from the subject is one paragraph to git",
  )
  check(
    "it says the message is mechanical",
    /could not write a message/.test(msg),
    "a subject nobody chose, appearing unexplained, reads as aide having stopped bothering",
  )
  check(
    "the staged paths are in the body",
    msg.includes("  src/a.ts") && msg.includes("  src/b.ts"),
    "the file list is the part a reader can check against the diff",
  )

  const long = fallbackMessage("x".repeat(200), [])
  const first = long.split("\n")[0] ?? ""
  check("a long request is cut to 72 columns", first.length <= 72, `${first.length}`)
  check("and says it was cut", first.endsWith("…"), first.slice(-8))

  const empty = fallbackMessage("   \n  ", [])
  check(
    "a commit with no request still gets a subject",
    (empty.split("\n")[0] ?? "") === "uncommitted work",
    "git refuses an empty message, so this is the difference between a fallback and a second failure",
  )
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

console.log("\none way to read the head of a run log")
{
  const { scanHead } = await import("./spend.js")

  // `sessionOfRun` and `isLiveFormat` were the same bounded head-scan written
  // twice, and the two copies had already drifted over which failure each
  // swallowed. What follows pins the behaviours both of them depend on.
  const logPath = join(root, "head-scan.ndjson")
  const line = (o: object) => `${JSON.stringify(o)}\n`
  await writeFile(
    logPath,
    line({ type: "user.message", ts: 1000, text: "hi" }) +
      "\n" + // a blank line, which must not count against the budget
      line({ type: "checkpoint.taken", ts: 1001 }) +
      line({ type: "run.started", ts: 1002, sessionId: "s1", projectId: "p1" }),
    "utf8",
  )

  const found = await scanHead(logPath, 8, (e, openedAt) =>
    e.type === "run.started" ? { id: e.sessionId, openedAt } : undefined,
  )
  check("it finds the event it was sent for", found?.id === "s1", JSON.stringify(found))
  // The distinction the shared version has to preserve: the timestamp reported
  // is the LOG's first, not the matched event's. Reporting the match would date
  // every turn from its third line rather than from when it opened.
  check(
    "and reports when the log opened, not when the match landed",
    found?.openedAt === 1000,
    `${found?.openedAt}`,
  )

  // The budget is what stops a reader walking megabytes of transcript looking
  // for an event a dead turn never wrote.
  const capped = await scanHead(logPath, 2, (e) =>
    e.type === "run.started" ? "found" : undefined,
  )
  check("a budget too small to reach it gives up", capped === null, `${capped}`)

  // A torn line is the one being written right now. Skipping it rather than
  // aborting is what lets a whole line after it still be read.
  const tornPath = join(root, "head-torn.ndjson")
  await writeFile(
    tornPath,
    `{"type":"user.message","ts":1,` + "\n" + line({ type: "run.started", ts: 2, sessionId: "s2" }),
    "utf8",
  )
  check(
    "a torn line is skipped, not fatal",
    (await scanHead(tornPath, 8, (e) => (e.type === "run.started" ? e.sessionId : undefined))) ===
      "s2",
  )

  check(
    "a log that is not there reads as nothing",
    (await scanHead(join(root, "no-such.ndjson"), 8, () => true)) === null,
  )
}

console.log("\nthe dashboard's prefilter cannot drift from its reducer")
{
  // The prefilter skips a line before `JSON.parse` sees it, so an event added to
  // the reducer and not to the filter is dropped with no error and no failing
  // check — invisible even to a grep for the new event's name. Both now come
  // from one list, and this is the property that says so.
  const src = await readFile(
    fileURLToPath(new URL("./activity.ts", import.meta.url)),
    "utf8",
  )
  const listed = [...(src.match(/^const COUNTED = \[([\s\S]*?)\] as const/m)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(
    (m) => m[1],
  )
  // Only the branches inside `bodyOfRun` — `isLiveFormat` further down the file
  // tests `event.type` too, and those types are deliberately NOT counted.
  const body = src.slice(src.indexOf("async function bodyOfRun"))
  const branched = [
    ...new Set(
      [...body.slice(0, body.indexOf("\n}")).matchAll(/event\.type === "([^"]+)"/g)].map(
        (m) => m[1] as string,
      ),
    ),
  ]

  check("the counted list is not empty", listed.length > 0, listed.join(","))
  check("and the reducer's branches were found", branched.length > 0, branched.join(","))
  // Every type the reducer branches on must be in the list the filter is built
  // from, or the line is skipped before `JSON.parse` and the branch is dead. The
  // reverse is allowed: a listed type may exist only to admit a line.
  const missing = branched.filter((t) => !listed.includes(t))
  check(
    "every event bodyOfRun branches on survives the prefilter",
    missing.length === 0,
    missing.length ? `dropped before parse: ${missing.join(",")}` : `${branched.length} branches`,
  )
  check(
    "and the markers are quoted, so a tool result cannot masquerade as one",
    src.includes('`"${type}"`'),
    "an unquoted substring matches any line mentioning the words",
  )
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
    status: RunStatus | null = "success",
    activeMs = 1000,
  ) => ({
    runId: id,
    sessionId,
    projectId,
    openedAt,
    activeMs,
    costUsd,
    tokens,
    byModel: { [model]: { costUsd, tokens } },
    status,
  })

  /** What a window's log bodies contributed. Empty unless a check needs one. */
  const NO_BODY = { tools: [], checks: [], commits: 0, asks: 0 }

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

  const week = reduceActivity(runs, projects, now, 7, NO_BODY, 0)

  check("a run from today is in the window", week.runs === 5, `${week.runs}`)
  check("and one from eight days ago is not", !week.daily.some((d) => d.day === localDay(at(8))))
  check(
    "a 30-day window reaches back further",
    reduceActivity(runs, projects, now, 30, NO_BODY, 0).runs === 6,
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

  // The punchcard. The weekday shift is the silent one: JS says 0=Sunday and the
  // grid is drawn Monday-first, so getting it wrong mislabels every row by one
  // and looks like the data rather than the arithmetic.
  check("the grid is always 168 cells", week.hours.length === 168, `${week.hours.length}`)
  check(
    "including the empty ones",
    week.hours.filter((h) => h.runs === 0).length > 100,
  )
  {
    // 2026-09-02 is a Wednesday, so Monday-first index 2.
    const today = new Date(at(0))
    check("today is a Wednesday", today.getDay() === 3, `${today.getDay()}`)
    const cell = week.hours.find((h) => h.weekday === 2 && h.hour === 12)
    check("a noon Wednesday run lands on row 2", cell?.runs === 1, JSON.stringify(cell))
    // Every run in this fixture is at noon, so no cell outside hour 12 can hold
    // one. A weekday shift that was off by one would still pass the row check
    // above on its own; this is what pins the hour half of the coordinate.
    check(
      "and nothing lands outside noon",
      week.hours.filter((h) => h.hour !== 12).every((h) => h.runs === 0),
    )
    check(
      "every run is somewhere in the grid",
      week.hours.reduce((n, h) => n + h.runs, 0) === week.runs,
    )
  }

  // Outcomes. A turn still in flight has no outcome and must be in none of the
  // three buckets — folding null into `failed` would report every running turn
  // as broken for as long as it ran.
  {
    const mixed = [
      run("o1", alpha, "s1", at(0), 1, 10, "opus", "success"),
      run("o2", alpha, "s1", at(0), 1, 10, "opus", "cancelled"),
      run("o3", alpha, "s1", at(0), 1, 10, "opus", "failed"),
      run("o4", alpha, "s1", at(0), 1, 10, "opus", null),
    ]
    const out = reduceActivity(mixed, projects, now, 7, NO_BODY, 0).outcomes
    check(
      "outcomes split three ways",
      out.success === 1 && out.cancelled === 1 && out.failed === 1,
      JSON.stringify(out),
    )
    check(
      "and a turn in flight is in none of them",
      out.success + out.cancelled + out.failed === 3,
    )
  }

  // Durations, by nearest rank so every figure is a turn that really took that
  // long. A zero-duration turn never ran and must not drag the median down.
  {
    const spread = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((ms, i) =>
      run(`d${i}`, alpha, "s1", at(0), 0, 0, "opus", "success", ms),
    )
    const d = reduceActivity(
      [...spread, run("dz", alpha, "s1", at(0), 0, 0, "opus", "cancelled", 0)],
      projects,
      now,
      7,
      NO_BODY,
      0,
    ).durations
    // Nearest rank over ten values: ceil(0.5 * 10) - 1 = index 4, the 5th
    // smallest. Every percentile here is therefore a duration some turn really
    // had, which is the property this page's numbers are supposed to keep.
    check("p50 is a real value", d.p50Ms === 50, `${d.p50Ms}`)
    check("p90 is a real value", d.p90Ms === 90, `${d.p90Ms}`)
    check("max is the longest", d.maxMs === 100, `${d.maxMs}`)
    check("a turn that never ran is not counted", d.counted === 10, `${d.counted}`)
  }

  // Where the wall-clock went. The figure this page exists to answer and the
  // one whose failure mode is entirely silent: a split that stops partitioning
  // its span still draws as a perfectly plausible two-segment bar, and every
  // number on it stays the right order of magnitude.
  {
    const { IDLE_BREAK_MS, reduceTime, sittingsOf } = await import("./activity.js")
    const MIN = 60_000
    // A turn opening `openedAt` and running `activeMs`, at a minute offset from
    // a fixed base — so every case below reads as a timeline rather than as
    // epoch arithmetic.
    const base = at(0, 9)
    const turn = (id: string, startMin: number, lenMin: number, projectId = alpha) =>
      run(id, projectId, "s1", base + startMin * MIN, 0, 0, "opus", "success", lenMin * MIN)

    {
      // Two turns 5 minutes apart: one sitting, and the gap is yours.
      const s = sittingsOf([turn("a", 0, 10), turn("b", 15, 5)])
      check("turns close together are one sitting", s.length === 1, `${s.length}`)
      check("whose span reaches from first open to last end", s[0]?.spanMs === 20 * MIN)
      check("agent time is the turns", s[0]?.activeMs === 15 * MIN, `${s[0]?.activeMs}`)
      check("and the gap between them is yours", s[0]?.humanMs === 5 * MIN, `${s[0]?.humanMs}`)
    }
    {
      // A gap longer than the break splits them. The hours between are away,
      // and belong to neither sitting.
      const far = IDLE_BREAK_MS / MIN + 10
      const s = sittingsOf([turn("a", 0, 5), turn("b", far, 5)])
      check("a long gap ends the sitting", s.length === 2, `${s.length}`)
      check("and no sitting absorbs the time between", s[0]?.humanMs === 0 && s[1]?.humanMs === 0)
    }
    {
      // The bug that made summing wrong: two projects running at the same time.
      // One agent per project, several projects at once — so 10 minutes of
      // clock can hold 20 minutes of turn duration, and a share built on the
      // sum would exceed 100%.
      const s = sittingsOf([turn("a", 0, 10, alpha), turn("b", 0, 10, beta)])
      check("concurrent turns are one sitting", s.length === 1, `${s.length}`)
      check("spanning the clock, not the sum", s[0]?.spanMs === 10 * MIN, `${s[0]?.spanMs}`)
      check(
        "agent time is the union, so it cannot exceed the span",
        s[0]?.activeMs === 10 * MIN,
        `${s[0]?.activeMs} — summing would give ${20 * MIN}`,
      )
      check("and none of it is charged to you", s[0]?.humanMs === 0, `${s[0]?.humanMs}`)
      check("the sitting counts both projects", s[0]?.projects === 2, `${s[0]?.projects}`)
    }
    {
      // A short turn wholly inside a long one. The nested turn must neither
      // shorten the sitting nor open a gap that never existed.
      const s = sittingsOf([turn("long", 0, 30, alpha), turn("short", 10, 5, beta)])
      check("a nested turn does not shorten the sitting", s[0]?.spanMs === 30 * MIN, `${s[0]?.spanMs}`)
      check("nor invent idle time inside it", s[0]?.humanMs === 0, `${s[0]?.humanMs}`)
    }
    {
      // The property the whole section rests on, over a messier timeline: the
      // two halves partition the span EXACTLY. Not "approximately", and not
      // "after a clamp" — a clamp is what hides the sign error this catches.
      const messy = [
        turn("a", 0, 10, alpha),
        turn("b", 4, 12, beta),
        turn("c", 20, 3, alpha),
        turn("d", 21, 1, beta),
        turn("e", 40, 8, alpha),
      ]
      const s = sittingsOf(messy)
      check(
        "every sitting's halves sum to its span",
        s.every((x) => x.activeMs + x.humanMs === x.spanMs),
        JSON.stringify(s.map((x) => [x.spanMs, x.activeMs, x.humanMs])),
      )
      check("and none of them is negative", s.every((x) => x.humanMs >= 0 && x.activeMs >= 0))
      check("nor over-busy", s.every((x) => x.activeMs <= x.spanMs))

      const t = reduceTime(messy, base - 864e5, base + 864e5)
      check("the totals partition too", t.activeMs + t.humanMs === t.engagedMs)
      check("engaged is the sittings' spans", t.engagedMs === s.reduce((n, x) => n + x.spanMs, 0))
    }
    {
      // `runIndex` is a directory listing, so runs arrive in whatever order the
      // filesystem gives. Clustering an unsorted list produces one sitting per
      // run — a machine that reads as 100% busy, since a one-turn sitting has
      // no gaps in it. The reducer sorts its own copy; this is what says so.
      const ordered = [turn("a", 0, 5), turn("b", 10, 5), turn("c", 20, 5)]
      const shuffled = [ordered[2]!, ordered[0]!, ordered[1]!]
      check(
        "runs are clustered in time order, whatever order they arrive in",
        sittingsOf(shuffled).length === 1,
        `${sittingsOf(shuffled).length}`,
      )
      check(
        "and the caller's array is not reordered underneath it",
        shuffled[0]?.runId === "c",
      )
    }
    {
      // Away is everything outside a working day, and is never a denominator —
      // but it must not go negative either, which it would for a window wider
      // than the history it covers.
      const t = reduceTime([turn("a", 0, 10)], base - 5 * MIN, base + 20 * MIN)
      check("away is what the window has left over", t.awayMs === 15 * MIN, `${t.awayMs}`)
      const narrow = reduceTime([turn("a", 0, 10)], base, base + MIN)
      check("and never negative", narrow.awayMs === 0, `${narrow.awayMs}`)
    }
    {
      // The scoreboard. Its denominator is the working days, and the property
      // that has to hold is that the score cannot be gamed by NOT working: a
      // day with no turns must not appear, and the two halves must partition
      // the working span exactly or a target can be hit by losing time
      // somewhere it is not counted.
      const t = reduceTime(
        // 9am-9:10, then 2pm-2:20 the same day: one working day, two sittings,
        // and the ~4h50m between them is the recoverable idle.
        [turn("a", 0, 10), turn("b", 300, 20)],
        base - 864e5,
        base + 864e5,
      )
      check("a day with work is an active day", t.activeDayCount === 1, `${t.activeDayCount}`)
      check(
        "whose span runs first turn to last",
        t.activeDaySpanMs === 320 * MIN,
        `${t.activeDaySpanMs}`,
      )
      check("aide's share is the union of its turns", t.activeMs === 30 * MIN, `${t.activeMs}`)
      check(
        "and the idle is the rest, exactly",
        t.idleWithinDaysMs === 290 * MIN,
        `${t.idleWithinDaysMs}`,
      )
      check(
        "the two halves partition the working span",
        t.activeMs + t.idleWithinDaysMs === t.activeDaySpanMs,
      )
      check(
        "the per-day rows sum to the headline idle",
        t.activeDays.reduce((n, d) => n + d.idleMs, 0) === t.idleWithinDaysMs,
      )
      check(
        "and no day claims more aide time than it has span",
        t.activeDays.every((d) => d.activeMs <= d.spanMs),
      )
    }
    {
      // Sleep is not charged to the goal, and this is the case that broke two
      // earlier rules. Work at 11pm, then again at 10am: the gap is mostly
      // night, so it must not appear as recoverable idle — otherwise the score
      // is lost by going to bed, and the target is unreachable by construction.
      const late = new Date(2026, 8, 2, 23, 0, 0).getTime()
      const nightRun = (id: string, startMin: number, lenMin: number) =>
        run(id, alpha, "s1", late + startMin * MIN, 0, 0, "opus", "success", lenMin * MIN)
      const t = reduceTime([nightRun("a", 0, 10), nightRun("b", 660, 10)], late - 864e5, late + 864e5)
      const overnight = t.idleStretches.find((s) => s.ms > 60 * MIN)
      check("an overnight gap is found", overnight !== undefined)
      // It IS on the worklist: it happened between two working days, and only a
      // day off takes a stretch off the list. Sleep is removed from it by
      // overlap, not by discarding the whole thing — the version that discarded
      // it threw away the waking hours either side with it.
      check(
        "an overnight gap between working days is still counted",
        overnight?.withinDay === true,
        "only a day nobody worked takes a stretch off the list",
      )
      // 23:10 -> 10:00 is 10h50m, of which 01:00-08:00 is sleep. What is left is
      // 110 minutes of evening and 120 of morning: real waking time in which
      // nothing ran, and exactly what the goal is about. Forgiving all of it —
      // which "mostly night, discard" did — is how a target quietly stops
      // measuring the thing it is for.
      check(
        "only the sleeping part is forgiven",
        t.idleWithinDaysMs === 230 * MIN,
        `${t.idleWithinDaysMs / MIN}m, expected 230m (110m evening + 120m morning)`,
      )
      check(
        "the night itself is charged to nobody",
        t.activeDaySpanMs === (20 + 230) * MIN,
        `${t.activeDaySpanMs / MIN}m`,
      )
      check("the halves still partition", t.activeMs + t.idleWithinDaysMs === t.activeDaySpanMs)
      check(
        "and a gap between sittings is dead time, not review",
        t.split.deadMs === 230 * MIN && t.split.reviewMs === 0,
        `dead ${t.split.deadMs / MIN}m review ${t.split.reviewMs / MIN}m`,
      )
    }
    {
      // The case the night subtraction exists for, and the one that only shows
      // up on a machine that works past midnight — which this one does: its
      // five busiest hours are between 1am and 5am. Both sittings start on the
      // same calendar day (00:30 and 09:30), so they are ONE working day whose
      // span contains the 01:00-08:00 window. Without the subtraction that
      // sleep is idle charged to the goal.
      const small = new Date(2026, 8, 2, 0, 30, 0).getTime()
      const nightRun = (id: string, startMin: number, lenMin: number) =>
        run(id, alpha, "s1", small + startMin * MIN, 0, 0, "opus", "success", lenMin * MIN)
      // 00:30-00:40, then 09:30-09:40: 9h10m of clock holding a 7h night.
      const t = reduceTime([nightRun("a", 0, 10), nightRun("b", 540, 10)], small - 864e5, small + 864e5)
      check("both sittings fall on one working day", t.activeDayCount === 1, `${t.activeDayCount}`)
      check(
        "whose span has the night taken out of it",
        t.activeDaySpanMs === (550 - 420) * MIN,
        `${t.activeDaySpanMs / MIN}m, expected ${(550 - 420)}m`,
      )
      check(
        "so only the waking gap is the target",
        t.idleWithinDaysMs === (550 - 420 - 20) * MIN,
        `${t.idleWithinDaysMs / MIN}m`,
      )
      check("and the halves still partition", t.activeMs + t.idleWithinDaysMs === t.activeDaySpanMs)
      check("the day never claims more aide than span", t.activeDays.every((d) => d.activeMs <= d.spanMs))
    }
    {
      // A gap that crosses a day nobody worked is a day off, not idle. This is
      // the 43-hour stretch in this machine's history, which was the largest
      // item on the worklist before the rule existed — and nothing aide does
      // can recover a day the laptop stayed shut.
      const t = reduceTime(
        [turn("a", 0, 10), turn("b", 60 * 48, 10)],
        base - 864e5,
        base + 5 * 864e5,
      )
      const long = t.idleStretches.find((s) => s.ms > 24 * 60 * MIN)
      check("a multi-day absence is found", long !== undefined, `${t.idleStretches.length}`)
      check(
        "and is not called recoverable",
        long?.withinDay === false,
        "a day with no work at all is not the product's fault",
      )
      check("it is two working days, not one span", t.activeDayCount === 2, `${t.activeDayCount}`)
    }
    {
      // An idle stretch that crosses midnight must land ON a day, and this is
      // the bug the whole shape was rewritten for. When a day's span was
      // `end - start` of its own sittings, a gap running from one day into the
      // next belonged to NEITHER: on this machine the four largest gaps all
      // cross midnight, and 71.5 of 111.6 recoverable hours were missing from
      // the score while being listed underneath it as the top of the worklist.
      // The page disagreed with itself and the wrong half was the headline.
      const evening = new Date(2026, 8, 2, 20, 0, 0).getTime()
      const acrossRun = (id: string, startMin: number, lenMin: number) =>
        run(id, alpha, "s1", evening + startMin * MIN, 0, 0, "opus", "success", lenMin * MIN)
      // 20:00-20:10, then 22:00-22:10 the NEXT day: a 25h50m gap over two
      // working days, all of it waking except one night.
      const t = reduceTime(
        [acrossRun("a", 0, 10), acrossRun("b", 26 * 60, 10)],
        evening - 864e5,
        evening + 3 * 864e5,
      )
      const crossing = t.idleStretches.find((s) => s.ms > 24 * 60 * MIN)
      check("a gap crossing midnight is found", crossing !== undefined)
      check("and it counts, since both ends are working days", crossing?.withinDay === true)
      check(
        "its waking hours reach the score",
        // 25h50m total, minus one 7h night = 18h50m.
        t.idleWithinDaysMs === (26 * 60 - 10 - 420) * MIN,
        `${t.idleWithinDaysMs / MIN}m, expected ${26 * 60 - 10 - 420}m`,
      )
      check(
        "the day totals still sum to the headline",
        t.activeDays.reduce((n, d) => n + d.idleMs, 0) === t.idleWithinDaysMs,
      )
      check(
        "and the three-way split sums to the working span",
        t.split.activeMs + t.split.reviewMs + t.split.deadMs === t.activeDaySpanMs,
      )
    }
    {
      // The three-way split is the page's main reading, and the line between
      // its two idle halves is the sitting break: a gap that kept a sitting
      // together is you reading a diff, one that ended a sitting is dead time.
      // Folding them together is what the old single 'idle' figure did.
      const t = reduceTime(
        // Two turns 5 minutes apart (review), then a 3-hour gap (dead), then one more.
        [turn("a", 0, 10), turn("b", 15, 5), turn("c", 200, 10)],
        base - 864e5,
        base + 864e5,
      )
      check("review is the gap inside the sitting", t.split.reviewMs === 5 * MIN, `${t.split.reviewMs / MIN}m`)
      check(
        "dead is the gap that ended it",
        t.split.deadMs === (200 - 20) * MIN,
        `${t.split.deadMs / MIN}m`,
      )
      check("running is the turns", t.split.activeMs === 25 * MIN, `${t.split.activeMs / MIN}m`)
      check(
        "and the three partition the working span",
        t.split.activeMs + t.split.reviewMs + t.split.deadMs === t.activeDaySpanMs,
      )
      check(
        "review plus dead is the idle the bar draws",
        t.split.reviewMs + t.split.deadMs === t.idleWithinDaysMs,
      )
      check("no part is negative", t.split.deadMs >= 0 && t.split.reviewMs >= 0)
    }
    {
      // The night arithmetic itself, which every figure above leans on. Checked
      // directly because an off-by-one here moves the score and nothing on the
      // page would look wrong.
      const { nightOverlapMs } = await import("./activity.js")
      const on = (day: number, hour: number, min = 0) =>
        new Date(2026, 8, day, hour, min, 0).getTime()
      check("a daytime stretch overlaps no night", nightOverlapMs(on(1, 9), on(1, 17)) === 0)
      check("an hour inside the night counts", nightOverlapMs(on(1, 2), on(1, 3)) === 60 * MIN)
      check(
        "an overnight stretch counts the whole window",
        nightOverlapMs(on(1, 23), on(2, 9)) === 7 * 60 * MIN,
        `${nightOverlapMs(on(1, 23), on(2, 9)) / MIN}`,
      )
      check(
        "and several days count several nights",
        nightOverlapMs(on(1, 0), on(4, 0)) === 21 * 60 * MIN,
        `${nightOverlapMs(on(1, 0), on(4, 0)) / MIN}`,
      )
      check(
        "a stretch ending mid-night counts only what it covers",
        nightOverlapMs(on(1, 23), on(2, 3)) === 2 * 60 * MIN,
        `${nightOverlapMs(on(1, 23), on(2, 3)) / MIN}`,
      )
    }
    {
      // The longest in-sitting gap names a real wait. A gap wider than the
      // break is a sitting boundary and belongs to `away`, not to this.
      const t = reduceTime(
        [turn("a", 0, 1), turn("b", 12, 1), turn("c", 20, 1)],
        base - 864e5,
        base + 864e5,
      )
      check("the longest wait is the widest in-sitting gap", t.longestGapMs === 11 * MIN, `${t.longestGapMs}`)
      check("and it is dated", t.longestGapAt === base + MIN, `${t.longestGapAt}`)
      const split = reduceTime([turn("a", 0, 1), turn("b", 999, 1)], base - 864e5, base + 864e5)
      check("a gap that ended the sitting is not a wait", split.longestGapMs === 0, `${split.longestGapMs}`)
    }
    {
      // An empty window divides by nothing. The renderer guards this too, but a
      // NaN reaching it would already be on the wire.
      const t = reduceTime([], now - 7 * 864e5, now)
      check("no sittings is not a crash", t.engagedMs === 0 && t.sittings.length === 0)
      check("and away is the whole window", t.awayMs === 7 * 864e5, `${t.awayMs}`)
    }
    {
      // The project column. Its share divides `busyMs` by `engagedMs`, both of
      // which are that project's own — a slice of the machine's sittings would
      // charge a two-project sitting's whole span to each of them, and the
      // column would sum to more than the window holds.
      const mixed = [turn("a", 0, 10, alpha), turn("b", 0, 10, beta), turn("c", 12, 2, alpha)]
      const rows = reduceActivity(mixed, projects, now, 7, NO_BODY, 0).projects
      const a = rows.find((p) => p.projectId === alpha)
      const b = rows.find((p) => p.projectId === beta)
      check("a project's engaged time is its own", a?.engagedMs === 14 * MIN, `${a?.engagedMs}`)
      check("and beta's is only its one turn", b?.engagedMs === 10 * MIN, `${b?.engagedMs}`)
      check(
        "a busy share can never exceed its span",
        rows.every((p) => p.busyMs <= p.engagedMs),
        JSON.stringify(rows.map((p) => [p.busyMs, p.engagedMs])),
      )
      check("and busy time is not the summed activeMs", a?.busyMs === 12 * MIN, `${a?.busyMs}`)
    }
    check(
      "the break is half an hour, and not a setting",
      IDLE_BREAK_MS === 30 * 60_000,
      `${IDLE_BREAK_MS}`,
    )
  }

  check("no runs is not a crash", reduceActivity([], projects, now, 7, NO_BODY, 0).runs === 0)
  check("and shares do not divide by zero", reduceActivity([], projects, now, 7, NO_BODY, 0).projects.length === 0)

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

// ---------------------------------------------------------------------------
console.log("\nlogs written by an older aide still read")
// `run.started` used to carry a `taskId`, and 672 logs in `~/.aide/runs` on this
// machine still have one. Dropping a field from the wire is only safe because
// every reader takes what it wants off a parsed line rather than matching the
// shape whole — which is a property of how they are written, not something the
// compiler enforces, so it is asserted rather than assumed. The failure it
// guards against is silent: a reader that rejected these would not crash, it
// would report a machine with hundreds of runs as having none.
{
  const { sessionOfRun, terminalEvent } = await import("./spend.js")

  const dir = await mkdtemp(join(tmpdir(), "aide-oldlog-"))
  const path = join(dir, "old.ndjson")
  // Exactly the shape aide wrote before the field went, `taskId` included.
  const lines = [
    { type: "user.message", text: "do the thing", runId: "old", seq: 1, ts: 1000 },
    {
      type: "run.started",
      taskId: "0004",
      projectId: "p1",
      model: "m",
      cwd: "/tmp/x",
      sessionId: "sess-old",
      runId: "old",
      seq: 2,
      ts: 1001,
    },
    {
      type: "run.finished",
      subtype: "success",
      status: "success",
      totalCostUsd: 0.5,
      modelUsage: {},
      numTurns: 3,
      durationMs: 4000,
      permissionDenials: [],
      runId: "old",
      seq: 3,
      ts: 5000,
    },
  ]
  await writeFile(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8")

  const head = await sessionOfRun(path)
  check(
    "a log with a taskId still names its conversation",
    head?.sessionId === "sess-old" && head?.projectId === "p1",
    "these are most of the logs on this machine; a reader that refused them would report no history at all",
  )
  check("and the moment it opened", head?.at === 1000)

  const end = await terminalEvent(path)
  check(
    "and still says what it cost",
    end?.type === "run.finished" && end.totalCostUsd === 0.5 && end.durationMs === 4000,
  )

  await rm(dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
console.log("\nrun logs are read once, except the one being written")
// The cache both readers of `~/.aide/runs` share. What it buys is measured —
// 667 logs, 737ms cold and 27ms warm — but that is the half that would be
// noticed if it broke. The half that would NOT is the invalidation: a cache
// keyed by name alone is correct for every finished log and silently wrong for
// the one log that matters, the turn in flight, which it would freeze at
// whatever it said when first asked. So what these pin is the rereading.
{
  const { RunLogCache } = await import("./spend.js")

  const dir = await mkdtemp(join(tmpdir(), "aide-logcache-"))
  const file = "run.ndjson"
  const path = join(dir, file)
  await writeFile(path, "one\n", "utf8")

  const cache = new RunLogCache<string>()
  let reads = 0
  const read = async (p: string) => {
    reads += 1
    return await readFile(p, "utf8")
  }

  check("a first read reaches the file", (await cache.get(path, file, read)) === "one\n")
  await cache.get(path, file, read)
  check(
    "and a second does not",
    reads === 1,
    "a finished log never changes again, so reading it twice is the cost this exists to remove",
  )

  // An append, which is what a turn in flight does to its own log on every
  // event. Both halves of the key move, but SIZE alone would be enough here —
  // the mtime is what catches the rarer case below.
  await writeFile(path, "one\ntwo\n", "utf8")
  check(
    "a log that grew is read again",
    (await cache.get(path, file, read)) === "one\ntwo\n" && reads === 2,
    "this is the live turn, and a stale answer for it is the whole failure this key prevents",
  )

  // Same length, different bytes. A size-only key calls this unchanged, which is
  // why the key carries the mtime too.
  //
  // The mtime is stamped, not just written: two writes inside one filesystem
  // timestamp tick land on the same mtime, and this assertion then fails for a
  // reason that has nothing to do with the cache. That is a flake rather than a
  // finding — it was watched happening once here — so the clock is moved by hand
  // instead of hoped at.
  await writeFile(path, "one\nTWO\n", "utf8")
  const later = new Date(Date.now() + 2000)
  await utimes(path, later, later)
  check(
    "and so is one that changed without growing",
    (await cache.get(path, file, read)) === "one\nTWO\n" && reads === 3,
  )

  // A log deleted between the directory listing and the read. A real race: a run
  // can end at any moment, and the caller has to be able to skip it rather than
  // take a whole dashboard down over one missing file.
  await rm(path)
  check(
    "a log that has gone reads as null, not as an error",
    (await cache.get(path, file, read)) === null,
  )

  // Eviction. Without it a daemon that runs for weeks holds the history of a
  // directory it no longer matches — every log ever deleted, still in memory.
  await writeFile(path, "back\n", "utf8")
  await cache.get(path, file, read)
  const beforeRetain = reads
  // Twice, either side of the eviction, over a file nothing has touched in
  // between: the first is a hit, so the second can only reach the file if
  // `retain` genuinely dropped the entry. Asserting on the delta rather than on
  // a running total, which is a number that has to be recounted by hand every
  // time an assertion is added above.
  cache.retain(new Set())
  await cache.get(path, file, read)
  check(
    "and one dropped from the index is forgotten",
    reads === beforeRetain + 1,
    "retain is what keeps a long-lived daemon from holding logs that no longer exist",
  )

  await rm(dir, { recursive: true, force: true })
}

console.log("\nsquash and push")
{
  // The push button's second spelling: fold the per-turn auto-commits into one
  // before they leave the machine. Its own repo pair rather than the shared
  // repo above, because it needs a REMOTE and the shared repo's sections lean
  // on not having one — and because a squash rewinds HEAD, which would move the
  // ground under every section after it.
  const { squashAndPush } = await import("./changes.js")
  const pen = await mkdtemp(join(tmpdir(), "aide-squash-"))
  const origin = join(pen, "origin.git")
  const work = join(pen, "work")
  await run("git", ["init", "--bare", "-b", "main", origin], { windowsHide: true })
  await run("git", ["init", "-b", "main", work], { windowsHide: true })
  await git(work, ["config", "user.email", "smoke@example.com"])
  await git(work, ["config", "user.name", "smoke"])
  const save = async (name: string, subject: string) => {
    await writeFile(join(work, name), `${subject}\n`, "utf8")
    await git(work, ["add", name])
    // Two `-m`s rather than one string with newlines: a literal newline inside
    // a Windows argv is exactly the kind of quoting bet this test must not make.
    await git(work, ["commit", "-m", subject, "-m", `Aide-Session: sess-${name}`])
  }
  await save("base.txt", "the base")
  await git(work, ["remote", "add", "origin", origin])
  await git(work, ["push", "-u", "origin", "main"])

  await save("one.txt", "first turn's work")
  await save("two.txt", "second turn's work")
  await save("three.txt", "third turn's work")

  // A dirty tree refuses outright. The files would survive — the squash never
  // touches the working tree — but a rewrite under uncommitted work is where
  // "what happened to my changes" starts, and auto-commit makes dirty-at-push
  // the exceptional case rather than the normal one.
  await writeFile(join(work, "wip.txt"), "not yet\n", "utf8")
  const dirty = await squashAndPush(work).then(
    () => null,
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  )
  check("a dirty tree refuses the squash", dirty !== null, String(dirty).slice(0, 60))
  check("and says why", String(dirty).includes("uncommitted"), String(dirty).slice(0, 60))
  check(
    "and nothing was pushed by the refusal",
    (await git(origin, ["log", "--pretty=%s", "main"])).trim() === "the base",
  )
  await rm(join(work, "wip.txt"))

  const out = await squashAndPush(work)
  check("three commits fold into one push", out.squashed === 3, String(out.squashed))
  check("and the push reports one commit sent", out.pushed === 1, String(out.pushed))
  check(
    "the local branch is in step afterwards",
    (await git(work, ["rev-list", "--count", "@{upstream}..HEAD"])).trim() === "0",
  )
  const remoteLog = await git(origin, ["log", "--pretty=%s", "main"])
  check(
    "the remote got the fold, not the steps",
    remoteLog.trim().split("\n").length === 2,
    remoteLog.trim().replace(/\n/g, " | "),
  )
  const message = await git(work, ["log", "-1", "--pretty=%B"])
  check("the first subject leads the squash", message.startsWith("first turn's work"))
  check(
    "and every step survives in its body",
    message.includes("- second turn's work") && message.includes("- third turn's work"),
  )
  check(
    "the sessions ride along as trailers",
    message.includes("Aide-Session: sess-one.txt") &&
      message.includes("Aide-Session: sess-three.txt"),
    "squashing must not cut the link from history to the transcripts",
  )
  check(
    "the files themselves all landed",
    (await git(origin, ["ls-tree", "--name-only", "main"])).includes("three.txt"),
  )

  // One commit ahead is nothing to fold — the flag quietly means plain push.
  await save("four.txt", "fourth turn's work")
  const plain = await squashAndPush(work)
  check("one ahead is a plain push", plain.squashed === 0 && plain.pushed === 1)
  check(
    "and its commit arrives as itself",
    (await git(origin, ["log", "-1", "--pretty=%s", "main"])).trim() === "fourth turn's work",
  )

  // The swap is a compare-and-swap, and this is the case it exists for: a
  // commit landing between the fold being built and the branch being moved.
  // `update-ref <ref> <new> <old>` refuses because the branch no longer points
  // at <old> — so the concurrent commit survives, the stale fold is an
  // unreferenced object, and NOTHING was pushed. The in-place `reset --soft`
  // this replaced would have silently discarded the concurrent commit.
  await save("five.txt", "fifth turn's work")
  await save("six.txt", "sixth turn's work")
  const raced = await squashAndPush(work, {
    beforeSwap: async () => {
      await save("seven.txt", "a commit that lands mid-squash")
    },
  }).then(
    () => null,
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  )
  check("a concurrent commit fails the swap", raced !== null, String(raced).slice(0, 70))
  check(
    "and the concurrent commit survives at HEAD",
    (await git(work, ["log", "-1", "--pretty=%s"])).trim() === "a commit that lands mid-squash",
  )
  check(
    "with the folded turns still behind it",
    (await git(work, ["log", "--pretty=%s"])).includes("fifth turn's work"),
    "a failed swap must strand the fold, never the history",
  )
  check(
    "and nothing reached the remote",
    (await git(origin, ["log", "-1", "--pretty=%s", "main"])).trim() === "fourth turn's work",
  )
  // The retry, over the same branch, now folds all three.
  const retried = await squashAndPush(work)
  check("the retry folds what is there now", retried.squashed === 3, String(retried.squashed))
  check(
    "and lands it",
    (await git(origin, ["log", "-1", "--pretty=%s", "main"])).trim() === "fifth turn's work",
  )

  await rm(pen, { recursive: true, force: true })
}

console.log("\nthe force escape hatch")
{
  // The one way past a red gate, API-only and never drawn: the same commit path
  // with the refusal overridden and the subject marked. Driven directly at
  // `commitWorkingTree` — the route is a thin wrapper — with `message` supplied
  // so no model is called, and a check that genuinely fails, because a stubbed
  // gate would prove the stub.
  const { commitWorkingTree, VerifyFailed } = await import("./review.js")
  const pen = await mkdtemp(join(tmpdir(), "aide-force-"))
  await run("git", ["init", "-b", "main", pen], { windowsHide: true })
  await git(pen, ["config", "user.email", "smoke@example.com"])
  await git(pen, ["config", "user.name", "smoke"])
  await writeFile(join(pen, "base.txt"), "base\n", "utf8")
  await git(pen, ["add", "-A"])
  await git(pen, ["commit", "-m", "base"])
  await writeFile(join(pen, "red.txt"), "work the gate refuses\n", "utf8")

  const drive = (force: boolean, verify: string) =>
    commitWorkingTree({
      project: { id: "p-force", name: "force", root: pen, addedAt: "" },
      sessionId: null,
      request: "land it anyway",
      message: { subject: "land it anyway", body: "" },
      verify: async () => [{ command: verify, unless: [] }],
      force,
      push: false,
      hasUpstream: false,
      repair: null,
      emit: () => {},
      delta: () => {},
      stopped: () => false,
    })

  const refused = await drive(false, "git definitely-not-a-subcommand").then(
    () => null,
    (err: unknown) => err,
  )
  check(
    "a red tree without force still throws VerifyFailed",
    refused instanceof VerifyFailed,
    String(refused),
  )
  check(
    "and nothing landed",
    (await git(pen, ["log", "--pretty=%s"])).trim() === "base",
  )

  await drive(true, "git definitely-not-a-subcommand")
  check(
    "force lands the same tree with the red state in the subject",
    (await git(pen, ["log", "-1", "--pretty=%s"])).trim() === "WIP: land it anyway",
    (await git(pen, ["log", "-1", "--pretty=%s"])).trim(),
  )

  // Force over a GREEN gate is an ordinary commit — WIP: on a tree whose
  // checks passed would cry wolf in every log listing.
  await writeFile(join(pen, "green.txt"), "fine\n", "utf8")
  await drive(true, "git --version")
  check(
    "force over a passing gate is not marked WIP",
    (await git(pen, ["log", "-1", "--pretty=%s"])).trim() === "land it anyway",
    (await git(pen, ["log", "-1", "--pretty=%s"])).trim(),
  )

  await rm(pen, { recursive: true, force: true })
}

report()
