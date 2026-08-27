import { execFile } from "node:child_process"
import { promisify } from "node:util"

const run = promisify(execFile)

/**
 * Take back a port held by a stale dev server.
 *
 * Vite's default is to shrug and move to the next free port, and for aide that
 * is not a harmless inconvenience — it half-breaks the app in a way that looks
 * like a bug somewhere else. The daemon's origin guard allowlists the dev
 * server's origin by exact authority, so a page served from :5175 sends
 * `Origin: http://localhost:5175` on every POST and gets a 403. Reads still
 * work, because same-origin GETs carry no Origin header. So the symptom is
 * "everything loads, nothing I do saves", with no clue pointing at the port.
 *
 * Hence: reclaim the port, and pair this with `strictPort` so that if reclaiming
 * fails the dev server refuses to start rather than drifting somewhere the
 * daemon will not talk to.
 */

/**
 * PIDs listening on a port. Empty on any failure — this is best-effort.
 *
 * Note the absence of `-p tcp`. On Windows that filter restricts the output to
 * IPv4, and Vite binds `::1` — so with it, a stale Vite is invisible and nothing
 * ever gets reclaimed. The first version of this had that flag, and the test
 * that "proved" it worked used a squatter pinned to 127.0.0.1: an IPv4 fixture
 * for an IPv6 problem. Plain `netstat -ano` lists both families.
 */
async function pidsOnPort(port: number): Promise<number[]> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await run("netstat", ["-ano"], { windowsHide: true })
      const pids = new Set<number>()
      for (const line of stdout.split(/\r?\n/)) {
        //   TCP    127.0.0.1:5173   0.0.0.0:0   LISTENING   1234
        //   TCP    [::1]:5173       [::]:0      LISTENING   1234
        // Greedy `(\S+)` so the split lands on the LAST colon, which is what
        // separates the port from a bracketed IPv6 address.
        const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line)
        // LISTENING only: the TIME_WAIT rows for the same port report pid 0 and
        // are not holding anything.
        if (m && Number(m[2]) === port) pids.add(Number(m[3]))
      }
      return [...pids]
    }
    const { stdout } = await run("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"])
    return [...new Set(stdout.split(/\s+/).filter(Boolean).map(Number))]
  } catch {
    // netstat/lsof missing, or nothing listening. Either way, nothing to reclaim.
    return []
  }
}

/** Executable name for a pid, so the log says what was killed rather than a number. */
async function processName(pid: number): Promise<string> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
        windowsHide: true,
      })
      return stdout.split(",")[0]?.replace(/"/g, "").trim() || "unknown"
    }
    const { stdout } = await run("ps", ["-p", String(pid), "-o", "comm="])
    return stdout.trim() || "unknown"
  } catch {
    return "unknown"
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface ReclaimResult {
  killed: Array<{ pid: number; name: string }>
  /** Set when something holds the port that we declined to kill. */
  refused: Array<{ pid: number; name: string }> | null
}

/**
 * Kill whatever is listening on `port`, if it is safe to.
 *
 * "Safe" means a Node process. A stale Vite or daemon always is, and that is the
 * case this exists for. Anything else — a database, someone's other server that
 * happens to sit on this port — is reported and left alone: the request was to
 * clean up our own leftovers, not to let a dev server terminate arbitrary
 * software because it wanted an address.
 */
export async function reclaimPort(port: number): Promise<ReclaimResult> {
  let all = await pidsOnPort(port)

  // We are holding it ourselves. That is a Vite restart — a config or plugin
  // file changed — and the previous http server has not finished closing yet.
  // Waiting is the fix; killing our own process obviously is not, and returning
  // immediately hands Vite a port that is still busy, which under strictPort
  // means the restart dies with EADDRINUSE.
  for (let i = 0; i < 30 && all.includes(process.pid); i += 1) {
    await wait(100)
    all = await pidsOnPort(port)
  }

  const pids = all.filter((pid) => pid > 0 && pid !== process.pid)
  if (pids.length === 0) return { killed: [], refused: null }

  const named = await Promise.all(pids.map(async (pid) => ({ pid, name: await processName(pid) })))
  const ours = named.filter((p) => /^node(\.exe)?$/i.test(p.name))
  const theirs = named.filter((p) => !/^node(\.exe)?$/i.test(p.name))

  for (const { pid } of ours) {
    // /T because a dev server has children — a Vite that spawned the daemon, a
    // tsx wrapper around a real process — and killing only the parent leaves
    // them holding the port we came for.
    if (process.platform === "win32") {
      await run("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }).catch(() => {})
    } else {
      try {
        process.kill(pid, "SIGTERM")
      } catch {
        /* already gone */
      }
    }
  }

  // Windows frees a port a moment after the process dies; binding immediately
  // races that and fails with EADDRINUSE for no visible reason.
  for (let i = 0; i < 20 && ours.length > 0; i += 1) {
    if ((await pidsOnPort(port)).length === 0) break
    await wait(100)
  }

  return { killed: ours, refused: theirs.length ? theirs : null }
}
