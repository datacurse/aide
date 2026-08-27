import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { promisify } from "node:util"
import { STATE_DIR, branchName, worktreePath } from "@aide/protocol"

const run = promisify(execFile)

// Diffs can be large; the default 1MB buffer truncates real ones.
const GIT_OPTS = { maxBuffer: 32 * 1024 * 1024, windowsHide: true } as const

/**
 * git says *why* it refused on stderr, and sometimes on stdout instead (merge
 * conflicts list the files there). execFile's own message is just the exit code,
 * so without this a failed commit surfaces in the UI as "Command failed" and the
 * actual reason — no user.email, a pre-commit hook, a conflict — is thrown away.
 */
async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run("git", ["-C", cwd, ...args], GIT_OPTS)
    return stdout
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string }
    const detail = `${e.stderr ?? ""}${e.stdout ?? ""}`.trim()
    throw new Error(detail || e.message || `git ${args[0]} failed`)
  }
}

export async function isGitRepo(root: string): Promise<boolean> {
  try {
    const out = await git(root, ["rev-parse", "--is-inside-work-tree"])
    return out.trim() === "true"
  } catch {
    return false
  }
}

export async function repoRoot(dir: string): Promise<string | null> {
  try {
    return (await git(dir, ["rev-parse", "--show-toplevel"])).trim()
  } catch {
    return null
  }
}

async function branchExists(root: string, branch: string): Promise<boolean> {
  try {
    await git(root, ["rev-parse", "--verify", `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

/**
 * Make sure `.aide/worktrees/` is ignored in the managed repo. Without this the
 * first run makes the project's own git status a disaster area, which reads as
 * aide being broken.
 *
 * This goes in `.git/info/exclude`, NOT `.gitignore`, and that is not a style
 * preference. `.gitignore` is a tracked file: appending to it leaves the project
 * with an uncommitted change aide made and the user never asked for. That change
 * then blocks the first land, because merging refuses to run over a dirty
 * working tree — aide would have broken its own workflow on the first task.
 * `info/exclude` is git's mechanism for exactly this case: a local ignore that
 * dirties nothing and belongs to the checkout rather than to the project.
 *
 * `--git-common-dir` rather than `<root>/.git`, because the latter is a *file*
 * when the project is itself a worktree, and `info/exclude` is shared across
 * every worktree of a repo.
 */
export async function ensureIgnored(root: string): Promise<void> {
  const line = `${STATE_DIR}/worktrees/`

  const common = (await git(root, ["rev-parse", "--git-common-dir"])).trim()
  const gitDir = isAbsolute(common) ? common : join(root, common)
  const path = join(gitDir, "info", "exclude")

  let current = ""
  try {
    current = await readFile(path, "utf8")
  } catch {
    /* no exclude file yet */
  }
  if (current.split(/\r?\n/).some((l) => l.trim() === line)) return

  await mkdir(join(gitDir, "info"), { recursive: true })
  const prefix = current.length === 0 || current.endsWith("\n") ? "" : "\n"
  await appendFile(path, `${prefix}${line}\n`, "utf8")
}

/**
 * One worktree per task. Parallel agents sharing a working directory is instant
 * merge chaos, and it is the failure mode that looks like the model being bad.
 *
 * `created` distinguishes "I just checked this out" from "it was already here",
 * which is what gates the bootstrap command. Reinstalling dependencies on every
 * re-run and every follow-up would make iteration unusable.
 *
 * Note what this deliberately does NOT do on an existing worktree: no reset, no
 * stash, no clean. Everything the previous run left uncommitted is still there,
 * and that is the point — it is what lets a follow-up continue a conversation
 * about files that still exist.
 */
export async function ensureWorktree(
  root: string,
  taskId: string,
): Promise<{ path: string; created: boolean }> {
  const path = worktreePath(root, taskId)
  const branch = branchName(taskId)

  if (existsSync(path)) return { path, created: false }
  await ensureIgnored(root)

  if (await branchExists(root, branch)) {
    // Re-running a task whose branch survived a previous worktree.
    await git(root, ["worktree", "add", path, branch])
  } else {
    await git(root, ["worktree", "add", path, "-b", branch])
  }
  return { path, created: true }
}

export async function removeWorktree(root: string, taskId: string): Promise<void> {
  const path = worktreePath(root, taskId)
  if (!existsSync(path)) return
  await git(root, ["worktree", "remove", path, "--force"])
}

// ---------------------------------------------------------------------------
// Whose files are whose
// ---------------------------------------------------------------------------

/**
 * The parts of `.aide/` the DAEMON writes, excluded from everything the agent
 * is allowed to stage.
 *
 * `tasks/` and `journal/` are written by the daemon in the main checkout while
 * a run is in flight. A commit that carried the worktree's own copies of them
 * would, on land, write them back over the live ones — resurrecting a stale
 * `status: running`, or replacing the journal entry that same commit produced.
 *
 * Everything else under `.aide/` is deliberately NOT excluded. `specs/`,
 * `decisions/` and `project.md` are written by humans and agents, so a task
 * whose whole job is "write the spec for X" has to be able to land its output.
 *
 * `:(top,...)` anchors each pattern to the repo root rather than to cwd.
 */
const AGENT_SCOPE = [
  ".",
  `:(top,exclude)${STATE_DIR}/tasks`,
  `:(top,exclude)${STATE_DIR}/journal`,
] as const

/** Same pathspec, appended after a `--`. */
const scoped = (args: string[]): string[] => [...args, "--", ...AGENT_SCOPE]

/**
 * The diff of everything the agent did, including files it created.
 *
 * The `add -A -N` pass is load-bearing: intent-to-add makes untracked files show
 * up in `git diff`. Without it, brand new files are invisible and the first run
 * looks like it did nothing.
 *
 * Every git call that stages or shows the agent's work uses AGENT_SCOPE, and
 * they must all use the SAME one: if the diff the human reviews and the `add`
 * the commit runs disagree, the human approves one change and lands another.
 */
export async function worktreeDiff(worktreeAbsPath: string): Promise<string> {
  if (!existsSync(worktreeAbsPath)) return ""
  await git(worktreeAbsPath, scoped(["add", "-A", "-N"]))
  return git(worktreeAbsPath, scoped(["diff"]))
}

export async function worktreeStatus(worktreeAbsPath: string): Promise<string> {
  if (!existsSync(worktreeAbsPath)) return ""
  return git(worktreeAbsPath, scoped(["status", "--porcelain"]))
}

// ---------------------------------------------------------------------------
// Committing
// ---------------------------------------------------------------------------

/** `git diff --stat` for the worktree, after intent-to-add. Cheap context. */
export async function worktreeDiffStat(worktreeAbsPath: string): Promise<string> {
  if (!existsSync(worktreeAbsPath)) return ""
  await git(worktreeAbsPath, scoped(["add", "-A", "-N"]))
  return git(worktreeAbsPath, scoped(["diff", "--stat"]))
}

/**
 * The last `n` commit subjects on the project's own history.
 *
 * Fed to the commit-message drafter as house style. A repo that writes
 * `fix(parser): ...` and a repo that writes `Fix the parser` are both right, and
 * neither is guessable from the diff — but both are obvious from the log.
 */
export async function recentSubjects(root: string, n = 10): Promise<string[]> {
  try {
    const out = await git(root, ["log", `-n${n}`, "--format=%s"])
    return out.split("\n").map((l) => l.trim()).filter(Boolean)
  } catch {
    // A repo with no commits yet has no house style to copy.
    return []
  }
}

/**
 * Commit everything in the worktree.
 *
 * The message goes via a temp file rather than `-m`: commit messages are
 * multi-line by design, and a file is the one way to pass one that behaves the
 * same on every platform. `--cleanup=whitespace` trims blank edges but keeps
 * `#` lines, so a message referencing `#123` at the start of a line survives.
 *
 * Hooks are NOT skipped. A repo whose pre-commit hook rejects the agent's work
 * should reject it here too — that is the hook doing its job.
 */
export async function commitWorktree(
  worktreeAbsPath: string,
  message: string,
): Promise<string> {
  if (!existsSync(worktreeAbsPath)) throw new Error(`no worktree at ${worktreeAbsPath}`)
  if (!message.trim()) throw new Error("commit message is empty")

  // The emptiness probe carries the pathspec too, and that is not symmetry for
  // its own sake: without it, a run that touched only excluded paths passes the
  // "is there anything to commit" check and then `git commit` fails with
  // "nothing added to commit" — an error about staging, reported at the point
  // where the human just approved a message.
  await git(worktreeAbsPath, scoped(["add", "-A"]))
  if (!(await git(worktreeAbsPath, scoped(["status", "--porcelain"]))).trim()) {
    throw new Error("nothing to commit — the run left the worktree unchanged")
  }

  const file = join(tmpdir(), `aide-commitmsg-${process.pid}-${Date.now()}`)
  await writeFile(file, message.endsWith("\n") ? message : `${message}\n`, "utf8")
  try {
    await git(worktreeAbsPath, ["commit", "-F", file, "--cleanup=whitespace"])
  } finally {
    await rm(file, { force: true })
  }
  return (await git(worktreeAbsPath, ["rev-parse", "HEAD"])).trim()
}

// ---------------------------------------------------------------------------
// Landing
// ---------------------------------------------------------------------------

/** The branch checked out in the project's own working directory. */
export async function currentBranch(root: string): Promise<string> {
  return (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()
}

/**
 * Everything uncommitted in the project's working tree that is not aide's own
 * bookkeeping. Empty string means clean enough to land into.
 *
 * `.aide/` is excluded because otherwise NOTHING could ever land. Adding a
 * project scaffolds `.aide/` into the working tree; creating a task writes a
 * file there; committing writes a journal entry there; and every status
 * transition rewrites the task file — including the `setStatus("done")` that
 * runs immediately after a successful land. So the tree is dirty before the
 * first task exists and dirty again the instant a land finishes. "Commit
 * `.aide/` first" is not inconvenient, it is unreachable.
 *
 * Excluding it costs no safety, because this check was never what protects
 * uncommitted work. Its job is narrower: `git merge --abort` is only reliable
 * on a tree that was clean going in, so this is the guard that makes the abort
 * in `mergeTaskBranch` trustworthy. Work is protected by git itself, which
 * still refuses to merge over local modifications to the paths a merge touches
 * — `.aide/` included, if a task branch ever really does change one.
 */
export async function workingTreeDirt(root: string): Promise<string> {
  const out = await git(root, ["status", "--porcelain", "--", ".", `:(top,exclude)${STATE_DIR}`])
  return out.trim()
}

/**
 * Merge a task branch into whatever the project has checked out.
 *
 * Three refusals before anything is written, because this is the one operation
 * that changes what the rest of the repo sees:
 *
 * 1. Refuse if the target IS the task branch — nothing to merge into.
 * 2. Refuse if the project's working directory is dirty. Merging over someone's
 *    uncommitted edits is how you lose them.
 * 3. Abort on conflict. Without this, a failed land leaves the project sitting
 *    in a half-merged state that aide has no UI for and the user did not ask
 *    for. Aborting puts it back and reports the conflict instead.
 *
 * `--no-ff` always, so a task stays legible as one merge in the history rather
 * than dissolving into a fast-forward.
 */
export async function mergeTaskBranch(
  root: string,
  taskId: string,
  message: string,
): Promise<{ sha: string; into: string }> {
  const branch = branchName(taskId)
  const into = await currentBranch(root)

  if (into === branch) {
    throw new Error(
      `the project is itself on ${branch}; check out the branch you want to merge into first`,
    )
  }
  const dirty = await workingTreeDirt(root)
  if (dirty) {
    throw new Error(
      `${root} has uncommitted changes; commit or stash them before landing into ${into}`,
    )
  }

  try {
    await git(root, ["merge", "--no-ff", branch, "-m", message])
  } catch (err) {
    await git(root, ["merge", "--abort"]).catch(() => {})
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`merge into ${into} failed and was aborted:\n${detail}`)
  }

  return { sha: (await git(root, ["rev-parse", "HEAD"])).trim(), into }
}

/**
 * Append `Aide-Task` / `Aide-Run` trailers, unless the message already carries
 * them.
 *
 * This is what makes a commit traceable back to the task that asked for it and
 * the run log that shows how it was made — `git log --grep` and `git show` both
 * surface trailers, so months later the provenance is one command away rather
 * than lost. Added at commit time rather than in the draft so it stays correct
 * no matter how the human edits the message.
 */
export function withTrailers(message: string, taskId: string, runId: string | null): string {
  const body = message.trimEnd()
  if (/^Aide-Task:/m.test(body)) return `${body}\n`

  const trailers = [`Aide-Task: ${taskId}`]
  if (runId) trailers.push(`Aide-Run: ${runId}`)
  return `${body}\n\n${trailers.join("\n")}\n`
}
