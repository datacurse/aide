import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { copyFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)

// Diffs can be large; the default 1MB buffer truncates real ones.
export const GIT_OPTS = { maxBuffer: 32 * 1024 * 1024, windowsHide: true } as const

/**
 * git says *why* it refused on stderr, and sometimes on stdout instead (merge
 * conflicts list the files there). execFile's own message is just the exit code,
 * so without this a failed commit surfaces in the UI as "Command failed" and the
 * actual reason — no user.email, a pre-commit hook, a conflict — is thrown away.
 */
export async function git(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  try {
    const opts = env ? { ...GIT_OPTS, env: { ...process.env, ...env } } : GIT_OPTS
    const { stdout } = await run("git", ["-C", cwd, ...args], opts)
    return stdout
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string }
    const detail = `${e.stderr ?? ""}${e.stdout ?? ""}`.trim()
    throw new Error(detail || e.message || `git ${args[0]} failed`)
  }
}

/**
 * Run git against a THROWAWAY index, so staging touches nothing the human owns.
 *
 * This is the one trick that makes working in the project's own checkout safe.
 * The obvious way to ask "what is on disk right now" is `git add -A` followed by
 * `write-tree` or `diff --cached` — but the project's index belongs to the
 * human. Staging their half-finished work because aide wanted to compute a diff
 * would mean a `git commit` they typed themselves picks up files they never
 * added, and there is no way to put an index back the way it was.
 *
 * `GIT_INDEX_FILE` points git at a scratch file instead. Everything inside the
 * callback stages into that, and the real `.git/index` is never opened for
 * writing — verified in `pnpm smoke`, which asserts `git status --porcelain` is
 * byte-identical either side of a checkpoint.
 *
 * The scratch file is named with a UUID rather than the pid: two of these can
 * overlap (a review draft reading a diff while a turn finishes), and a shared
 * name would have them stage into each other's index.
 */
export async function withTempIndex<T>(
  root: string,
  fn: (gitTemp: (args: string[]) => Promise<string>, indexPath: string) => Promise<T>,
): Promise<T> {
  // In the system temp directory, OUTSIDE the working tree, and that is not
  // arbitrary: put the scratch index next to `.git` where it looks like it
  // belongs, and the `git add -A` that runs against it sweeps the index file and
  // its own lock into the tree as though they were project files.
  const index = join(tmpdir(), `aide-index-${randomUUID()}`)
  const env = { GIT_INDEX_FILE: index }
  try {
    return await fn((args) => git(root, args, env), index)
  } finally {
    // `force` because git may never have created it — a callback that threw on
    // its first command leaves no file, and that must not mask the real error.
    await rm(index, { force: true }).catch(() => {})
  }
}

/**
 * `withTempIndex`, with the scratch index already reflecting everything on disk.
 *
 * Every question aide asks about the working tree — what is in it now, what has
 * the run changed — is really a question about a tree object, and you cannot
 * have a tree object without staging. This is that staging, done somewhere the
 * human will never see it.
 *
 * The real index is COPIED rather than rebuilt with `read-tree`, and that is a
 * performance decision with teeth: a freshly read tree carries no stat
 * information, so `git add -A` cannot tell which files are unchanged and
 * re-hashes the entire repository. Copying brings the stat cache along, so the
 * add only hashes what actually differs — the difference between this costing
 * milliseconds and costing seconds on every turn of every conversation.
 *
 * The copy is best effort. With no index to copy the scratch one starts empty,
 * which makes the add slower and the resulting tree identical, so a failure here
 * costs time and never correctness.
 */
export async function withWorkingTreeIndex<T>(
  root: string,
  fn: (gitTemp: (args: string[]) => Promise<string>) => Promise<T>,
): Promise<T> {
  return withTempIndex(root, async (gitTemp, indexPath) => {
    const real = await realIndexPath(root)
    if (real) await copyFile(real, indexPath).catch(() => {})
    await gitTemp(["add", "-A"])
    return fn(gitTemp)
  })
}

/**
 * The real index, so its stat cache can be reused. Null when there is none —
 * a repository with no commits and nothing staged has no index file yet.
 *
 * `--git-dir` rather than `<root>/.git`, because the latter is a FILE when the
 * project is itself a worktree, and the index lives in the directory it points
 * at rather than beside it.
 */
async function realIndexPath(root: string): Promise<string | null> {
  const dir = await gitOr("", async () => (await git(root, ["rev-parse", "--git-dir"])).trim())
  if (!dir) return null
  return isAbsolute(dir) ? join(dir, "index") : join(root, dir, "index")
}

/**
 * The same, for the diff commands that exit 1 to mean "there were differences".
 *
 * `git diff --no-index` uses its exit status as an answer rather than as an
 * error, so the wrapper above would turn every non-empty diff into a thrown
 * "Command failed" carrying the patch as its message — every new file in the
 * working tree would have vanished from the view with no way to tell that from
 * "there are no new files". Exit 1 with output is success here; anything else
 * still throws.
 */
export async function gitDiffing(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run("git", ["-C", cwd, ...args], GIT_OPTS)
    return stdout
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string }
    if (e.code === 1 && typeof e.stdout === "string") return e.stdout
    const detail = `${e.stderr ?? ""}${e.stdout ?? ""}`.trim()
    throw new Error(detail || e.message || `git ${args[0]} failed`)
  }
}

/** Runs `fn`, answering `fallback` rather than throwing. */
export async function gitOr<T>(fallback: T, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch {
    return fallback
  }
}
