import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { appendFile, readFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { STATE_DIR, branchName, worktreePath } from "@aide/protocol"

const run = promisify(execFile)

// Diffs can be large; the default 1MB buffer truncates real ones.
const GIT_OPTS = { maxBuffer: 32 * 1024 * 1024, windowsHide: true } as const

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", cwd, ...args], GIT_OPTS)
  return stdout
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
 */
export async function ensureGitignore(root: string): Promise<void> {
  const path = join(root, ".gitignore")
  const line = `${STATE_DIR}/worktrees/`
  let current = ""
  try {
    current = await readFile(path, "utf8")
  } catch {
    /* no .gitignore yet */
  }
  if (current.split(/\r?\n/).some((l) => l.trim() === line)) return
  const prefix = current.length === 0 || current.endsWith("\n") ? "" : "\n"
  await appendFile(path, `${prefix}${line}\n`, "utf8")
}

/**
 * One worktree per task. Parallel agents sharing a working directory is instant
 * merge chaos, and it is the failure mode that looks like the model being bad.
 * Returns the absolute worktree path.
 */
export async function ensureWorktree(root: string, taskId: string): Promise<string> {
  const path = worktreePath(root, taskId)
  const branch = branchName(taskId)

  if (existsSync(path)) return path
  await ensureGitignore(root)

  if (await branchExists(root, branch)) {
    // Re-running a task whose branch survived a previous worktree.
    await git(root, ["worktree", "add", path, branch])
  } else {
    await git(root, ["worktree", "add", path, "-b", branch])
  }
  return path
}

export async function removeWorktree(root: string, taskId: string): Promise<void> {
  const path = worktreePath(root, taskId)
  if (!existsSync(path)) return
  await git(root, ["worktree", "remove", path, "--force"])
}

/**
 * The diff of everything the agent did, including files it created.
 *
 * The `add -A -N` pass is load-bearing: intent-to-add makes untracked files show
 * up in `git diff`. Without it, brand new files are invisible and the first run
 * looks like it did nothing.
 */
export async function worktreeDiff(worktreeAbsPath: string): Promise<string> {
  if (!existsSync(worktreeAbsPath)) return ""
  await git(worktreeAbsPath, ["add", "-A", "-N"])
  return git(worktreeAbsPath, ["diff"])
}

export async function worktreeStatus(worktreeAbsPath: string): Promise<string> {
  if (!existsSync(worktreeAbsPath)) return ""
  return git(worktreeAbsPath, ["status", "--porcelain"])
}
