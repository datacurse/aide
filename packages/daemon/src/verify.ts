import { spawn } from "node:child_process"
import { sshConfigPath } from "@aide/protocol/node"
import { CONFIG } from "./config.js"
import { refHost, refRoot, type RepoRef } from "./git.js"
import { killTree } from "./proc.js"

/** See `gitCommand` in `git.ts`: ssh re-parses the joined argv with a shell. */
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

/**
 * Running a project's own checks, so a commit is measured against something
 * other than the model's opinion of its work.
 *
 * The gate on the code was half a gate. An agent runs `pnpm typecheck` most of
 * the time and then writes "all four commands green" in its summary, and that
 * sentence — written by the thing being checked, in a run where a third of the
 * time nothing was checked at all — was the whole of the evidence a human had
 * when they pressed commit. This spawns the commands itself and puts what they
 * printed in the log.
 *
 * ## The command string goes to a shell, on purpose
 *
 * This looks like an injection sink and is not one. `verify:` is hand-written by
 * the human who owns the repository, in a file in that repository, and names
 * commands they already run in their own terminal. No agent writes it: a run
 * that edited `.aide/project.md` would be proposing a change to the gate, and
 * that change is uncommitted until the same human reads it in the diff. Refusing
 * a pipe here would buy nothing and cost the `2>&1` and `| tail` that make a
 * check's output readable.
 *
 * That is the opposite of `policy.ts`, and the difference is the author. That
 * file decides what a MODEL may run and is deliberately blunter than a shell
 * parser; this runs what a person wrote down.
 *
 * ## Env, not prefixes
 *
 * `CONFIG.runEnv` is applied here for the same reason it is applied to an
 * agent's shell — `CI=true` so pnpm does not stop to ask about a modules
 * directory with nobody there to answer, `NO_COLOR` so escape codes do not reach
 * a browser as garbage. It also means a check is written `pnpm typecheck`
 * rather than `CI=true pnpm typecheck`, which is what keeps one string working
 * on both a POSIX shell and cmd.exe.
 */

/** How much of a command's output to keep. Enough for a stack, not a build log. */
const MAX_OUTPUT = 4000

/**
 * Long enough for a cold `pnpm build` on Windows, short enough that a check
 * which hangs does not hold the project until someone notices. A timeout is
 * reported as a failure with no exit code rather than as an error, because
 * "this never finished" is a real answer about the tree.
 */
export const CHECK_TIMEOUT_MS = 10 * 60 * 1000

export interface CheckOutcome {
  command: string
  ok: boolean
  /** Null when the command was killed rather than exiting on its own. */
  exitCode: number | null
  durationMs: number
  /** The tail of stdout and stderr, interleaved as they arrived. */
  output: string
}

/** Keep the END. A failing command says why in its last lines, not its first. */
function tail(text: string): string {
  const trimmed = text.trimEnd()
  if (trimmed.length <= MAX_OUTPUT) return trimmed
  return `…\n${trimmed.slice(-MAX_OUTPUT)}`
}

/**
 * Run one check to completion.
 *
 * Never rejects. A command that cannot be spawned at all is an outcome like any
 * other — `ok: false` with the spawn error as its output — because the caller is
 * a gate, and a gate that throws on a typo in a command name is a gate that
 * lets the commit through on the error path.
 */
export function runCheck(
  command: string,
  root: RepoRef,
  timeoutMs = CHECK_TIMEOUT_MS,
): { done: Promise<CheckOutcome>; stop: () => void } {
  const startedAt = Date.now()
  const host = refHost(root)
  // A remote project's checks run on the remote machine, for the same reason its
  // git does: `pnpm typecheck` is a statement about the tree it runs in, and
  // running it here would either fail outright or — worse — pass against this
  // repository and report a green gate for code nobody checked.
  //
  // `cd` and then the command, so a relative path in a check means what it means
  // locally. The env goes as a prefix rather than through ssh's `SendEnv`, which
  // needs the far sshd to have opted in; see `gitCommand`.
  const child = host
    ? spawn(
        "ssh",
        [
          "-o",
          "BatchMode=yes",
          "-F",
          sshConfigPath(),
          host,
          [
            `cd ${shellQuote(refRoot(root))} &&`,
            ...Object.entries(CONFIG.runEnv).map(([k, v]) => `${k}=${shellQuote(v)}`),
            command,
          ].join(" "),
        ],
        { windowsHide: true },
      )
    : spawn(command, {
        cwd: refRoot(root),
        shell: true,
        windowsHide: true,
        env: { ...process.env, ...CONFIG.runEnv },
      })

  let out = ""
  // One buffer for both streams rather than two: a compiler writes errors to
  // stderr and progress to stdout, and reading them apart afterwards loses which
  // line came before which — the only thing that makes a build log legible.
  const collect = (chunk: Buffer) => {
    out += chunk.toString()
    // Trimmed as it arrives, not at the end. A watch-mode command left in
    // `verify:` by mistake would otherwise grow this string without limit for
    // the whole timeout.
    if (out.length > MAX_OUTPUT * 4) out = out.slice(-MAX_OUTPUT * 2)
  }
  child.stdout?.on("data", collect)
  child.stderr?.on("data", collect)

  let killed = false
  const kill = () => {
    if (killed) return
    killed = true
    // `killTree`, not `child.kill()`. `pnpm typecheck` is pnpm spawning tsc, and
    // on Windows a signal to the top of that reaches exactly one process — the
    // survivor keeps compiling with its parent gone. Same reason the worker uses
    // it; see `proc.ts`.
    killTree(child)
  }
  const timer = setTimeout(kill, timeoutMs)
  timer.unref?.()

  const done = new Promise<CheckOutcome>((resolve) => {
    const settle = (exitCode: number | null, extra = "") => {
      clearTimeout(timer)
      resolve({
        command,
        ok: exitCode === 0 && !killed,
        exitCode,
        durationMs: Date.now() - startedAt,
        output: tail(extra ? `${out}\n${extra}` : out),
      })
    }
    child.on("error", (err) => settle(null, `could not run it: ${err.message}`))
    child.on("close", (code) =>
      settle(
        code,
        killed ? `stopped after ${Math.round((Date.now() - startedAt) / 1000)}s` : "",
      ),
    )
  })

  return { done, stop: kill }
}

export interface VerifyOutcome {
  /** Every check that ran, in order. Short of the full list when one failed. */
  results: CheckOutcome[]
  /** The first one that failed, or null when they all passed. */
  failed: CheckOutcome | null
}

/**
 * Run a project's checks in order, stopping at the first failure.
 *
 * Stopping early rather than running them all: the commands are ordered by the
 * human who wrote them, cheapest first by convention, and a typecheck failure
 * makes the test suite's opinion irrelevant. It also means the wait a human sits
 * through on a broken tree is the first check, not all of them.
 *
 * `stopped` is read between checks and honoured mid-check by killing the child.
 * A human who pressed stop is not waiting out a ten-minute build.
 */
export async function runChecks(
  commands: readonly string[],
  root: RepoRef,
  opts: {
    /**
     * About to spawn this one. Called after the stop check, so a run that is
     * already ending never announces a check it will not run.
     *
     * The pair to `onResult`, and the reason it exists is the wait between them:
     * a check reported only on completion is invisible for exactly as long as it
     * takes, which is the part anybody watching needs to see.
     */
    onStart?: (command: string) => void
    onResult?: (result: CheckOutcome) => void
    stopped?: () => boolean
    timeoutMs?: number
  } = {},
): Promise<VerifyOutcome> {
  const results: CheckOutcome[] = []
  for (const command of commands) {
    if (opts.stopped?.()) break
    opts.onStart?.(command)
    const { done, stop } = runCheck(command, root, opts.timeoutMs)
    // Polled rather than pushed: nothing here owns the stop button, and a
    // conversation's interrupt sets a flag the lane reads. A second is well
    // inside the noise on a check measured in tens of them.
    const watch = setInterval(() => {
      if (opts.stopped?.()) stop()
    }, 1000)
    watch.unref?.()
    const result = await done.finally(() => clearInterval(watch))

    results.push(result)
    opts.onResult?.(result)
    if (!result.ok) return { results, failed: result }
  }
  return { results, failed: null }
}
