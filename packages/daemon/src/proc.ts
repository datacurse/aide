import type { ChildProcess } from "node:child_process"
import { spawn } from "node:child_process"

/**
 * Kill a process and everything under it.
 *
 * `child.kill()` signals one process. The things aide spawns are deeper than
 * that: the daemon forks a worker, the worker's Agent SDK spawns the Claude CLI,
 * and on Windows a signal to the top of that chain reaches exactly one of them —
 * `TerminateProcess` has no notion of a process group. The survivors keep
 * running with their parent gone, which for an agent run means it keeps editing
 * a worktree and keeps spending money while nothing is listening.
 *
 * `taskkill /T` walks the tree, which is the only reliable way to end it.
 *
 * There is a near-duplicate of this in `packages/web/vite-daemon.ts`, and it has
 * to stay duplicated: `@aide/web` does not depend on `@aide/daemon` — it reaches
 * the daemon by relative path — so importing this would create a package
 * dependency purely to share nine lines. Change one, check the other.
 */
/**
 * Forward a worker's stdout and stderr onto the daemon's.
 *
 * Both fork sites open those as pipes, and until this existed nothing ever read
 * them. Two consequences, one merely annoying and one not: everything a worker
 * or the SDK printed was swallowed — which is how a `console.error` explaining
 * why a feature was silently missing went nowhere — and a worker that wrote
 * enough would BLOCK on a full pipe buffer, 64KB on Windows, with no symptom
 * beyond a run that stopped making progress.
 *
 * Prefixed with the run id because several workers share one stream, and the
 * daemon's own stdout is what the dev server's log panel shows.
 */
export function relayWorkerOutput(child: ChildProcess, runId: string): void {
  const tag = `[worker ${runId.slice(0, 8)}]`
  const relay = (chunk: Buffer, to: NodeJS.WriteStream) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (line.trim()) to.write(`${tag} ${line}\n`)
    }
  }
  child.stdout?.on("data", (b: Buffer) => relay(b, process.stdout))
  child.stderr?.on("data", (b: Buffer) => relay(b, process.stderr))
}

export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true })
  } else {
    child.kill("SIGTERM")
  }
}
