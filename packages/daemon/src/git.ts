import { execFile } from "node:child_process"
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
export async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run("git", ["-C", cwd, ...args], GIT_OPTS)
    return stdout
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string }
    const detail = `${e.stderr ?? ""}${e.stdout ?? ""}`.trim()
    throw new Error(detail || e.message || `git ${args[0]} failed`)
  }
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
