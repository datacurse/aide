import { spawn, type ChildProcess } from "node:child_process"
import { killTree } from "./proc.js"

/**
 * Run a project's setup command in a fresh worktree.
 *
 * This exists because `git worktree add` checks out tracked files only, and
 * `node_modules` is gitignored in every project worth managing. So a brand new
 * worktree is a complete, valid source tree with nothing installed — the agent
 * can read and edit, but `pnpm typecheck` fails with "cannot find module" and it
 * has no way to know why. It would then spend turns, and budget, rediscovering
 * that on every single task.
 */

/**
 * Enough to see what failed, capped because this goes into the event log and the
 * event log is replayed in full to every browser that subscribes.
 */
const MAX_OUTPUT_CHARS = 4_000

export interface BootstrapResult {
  ok: boolean
  exitCode: number | null
  durationMs: number
  output: string
}

export interface BootstrapOptions {
  command: string
  cwd: string
  timeoutMs: number
  env: NodeJS.ProcessEnv
  /** Registered so a shutdown or an interrupt can take the install down too. */
  onSpawn?: (child: ChildProcess) => void
}

export async function runBootstrap(opts: BootstrapOptions): Promise<BootstrapResult> {
  const started = Date.now()

  // `shell: true` because a bootstrap command is written by a human in a
  // markdown file and will contain shell syntax. Note this is NOT the agent's
  // Bash tool — that goes through policy.ts. This command is configuration the
  // project owner wrote, at the same trust level as a package.json script.
  const child = spawn(opts.command, {
    cwd: opts.cwd,
    env: opts.env,
    shell: true,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  opts.onSpawn?.(child)

  let output = ""
  const record = (b: Buffer) => {
    output += b.toString()
    // Keep the TAIL: a failing install says why on its last few lines, and the
    // first 4000 characters of a pnpm run are just progress.
    if (output.length > MAX_OUTPUT_CHARS) output = output.slice(-MAX_OUTPUT_CHARS)
  }
  child.stdout?.on("data", record)
  child.stderr?.on("data", record)

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    killTree(child)
  }, opts.timeoutMs)

  const exitCode = await new Promise<number | null>((resolve) => {
    // `close`, not `exit`: exit fires before the stdio pipes have drained, so
    // the last — and most useful — lines of a failure would be missing.
    child.once("close", (code) => resolve(code))
    child.once("error", (err) => {
      output += `\n${err.message}`
      resolve(null)
    })
  })
  clearTimeout(timer)

  if (timedOut) {
    output += `\n--- killed after ${opts.timeoutMs}ms ---`
  }

  return {
    ok: !timedOut && exitCode === 0,
    exitCode,
    durationMs: Date.now() - started,
    output: output.trim(),
  }
}
