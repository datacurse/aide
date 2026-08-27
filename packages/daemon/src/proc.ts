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
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true })
  } else {
    child.kill("SIGTERM")
  }
}
