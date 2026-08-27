/**
 * Daemon lifecycle, owned by the dev server.
 *
 * The web app cannot start the daemon by itself: it talks to the daemon over
 * HTTP, so a dead daemon is exactly the case where there is nobody to receive
 * "please start". Something already running has to do it, and in development
 * that something is Vite — it is up before the browser loads and stays up as
 * long as the tab is useful.
 *
 * So this plugin owns the process and exposes it under `/__daemon`, served by
 * Vite itself rather than proxied. Those routes answer whether or not the daemon
 * is alive, which is the whole point.
 *
 * The scope is honest: this is a DEV-ONLY control plane. A built bundle has no
 * Vite behind it, `/__daemon` 404s, and the UI hides the panel. Running aide for
 * real is still `pnpm daemon` (or a service manager), and this plugin adopts a
 * daemon started that way rather than fighting it for the port.
 */
import { spawn, type ChildProcess } from "node:child_process"
import type { ServerResponse } from "node:http"
import { connect } from "node:net"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Plugin } from "vite"

const here = dirname(fileURLToPath(import.meta.url))
const DAEMON_DIR = join(here, "..", "daemon")
/** The same entrypoint `node_modules/.bin/tsx` would run, minus the shell shim. */
const TSX_CLI = join(DAEMON_DIR, "node_modules", "tsx", "dist", "cli.mjs")

/** Enough output to see why a crash happened, not enough to leak memory. */
const LOG_LINES = 300

export type DaemonState = "stopped" | "starting" | "running" | "adopted"

interface Status {
  state: DaemonState
  port: number
  pid: number | null
  /** False when the daemon was started outside this dev server; stop is refused. */
  managed: boolean
  startedAt: number | null
  /** How the last managed daemon ended, so a crash is visible after the fact. */
  lastExit: { code: number | null; signal: string | null; at: number } | null
}

/** Is anything accepting connections on the port? Cheaper than an HTTP probe. */
function probe(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" })
    const settle = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once("connect", () => settle(true))
    socket.once("timeout", () => settle(false))
    socket.once("error", () => settle(false))
  })
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * tsx re-execs node with its loader, so the daemon is a GRANDCHILD of this
 * process, and on Windows killing the parent leaves that grandchild holding the
 * port — the next start then fails with EADDRINUSE and the UI reports a daemon
 * that will not start for no visible reason. taskkill /T is the only reliable
 * way to take the tree down.
 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true })
  } else {
    child.kill("SIGTERM")
  }
}

export function daemonControl(port: number): Plugin {
  let child: ChildProcess | null = null
  let starting = false
  /** Set while a stop we asked for is in flight, so its exit is not a crash. */
  let stopping = false
  let startedAt: number | null = null
  let lastExit: Status["lastExit"] = null
  const log: string[] = []

  const record = (text: string) => {
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) log.push(line)
    }
    if (log.length > LOG_LINES) log.splice(0, log.length - LOG_LINES)
  }

  const status = async (): Promise<Status> => {
    const alive = child !== null && child.exitCode === null
    if (alive) {
      return {
        state: starting ? "starting" : "running",
        port,
        pid: child?.pid ?? null,
        managed: true,
        startedAt,
        lastExit,
      }
    }
    // Not ours — but something may still be serving, and reporting "stopped"
    // over a working daemon would be a lie the UI acts on.
    const adopted = await probe(port)
    return {
      state: adopted ? "adopted" : "stopped",
      port,
      pid: null,
      managed: false,
      startedAt: null,
      lastExit,
    }
  }

  const start = async (): Promise<{ ok: boolean; message: string }> => {
    if (child !== null && child.exitCode === null) {
      return { ok: true, message: "already running" }
    }
    if (await probe(port)) {
      return { ok: true, message: `adopted the daemon already listening on ${port}` }
    }

    starting = true
    lastExit = null
    log.length = 0
    record(`--- starting daemon on port ${port} ---`)

    // Plain `tsx`, NOT `tsx watch`, and that is load-bearing rather than a
    // simplification.
    //
    // tsx watch follows the import graph, and `packages/protocol/src/*` is in
    // the daemon's graph as raw TypeScript through a pnpm junction. So landing
    // a task — `git merge` rewriting `packages/daemon/src/*` in the main
    // checkout — made chokidar fire and SIGTERM the daemon about 100ms later,
    // MID-REQUEST. The merge committed, and then `removeWorktree`,
    // `setStatus("done")` and the HTTP response never ran: the task stranded at
    // `committed`, the worktree orphaned, and the browser saw a reset socket,
    // which reads as "the land failed".
    //
    // The daemon that develops aide cannot also be restarted by aide's edits.
    // Restart is now deliberate — that is what the restart button is for.
    const proc = spawn(process.execPath, [TSX_CLI, "src/server.ts"], {
      cwd: DAEMON_DIR,
      env: { ...process.env, AIDE_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    child = proc

    proc.stdout?.on("data", (b: Buffer) => {
      const text = b.toString()
      record(text)
      process.stdout.write(text)
    })
    proc.stderr?.on("data", (b: Buffer) => {
      const text = b.toString()
      record(text)
      process.stderr.write(text)
    })
    proc.once("exit", (code, signal) => {
      // A stop we asked for is not a crash, and recording it as one would put a
      // red "exited (code 1)" in the header every time someone used the button —
      // taskkill /F always reports a nonzero code.
      lastExit = stopping ? null : { code, signal, at: Date.now() }
      record(
        stopping
          ? "--- daemon stopped ---"
          : `--- daemon exited (code ${code}, signal ${signal ?? "none"}) ---`,
      )
      if (child === proc) {
        child = null
        startedAt = null
      }
    })
    proc.once("error", (err) => {
      record(`--- could not spawn the daemon: ${err.message} ---`)
    })

    // Report readiness rather than spawn success. A daemon that dies on
    // EADDRINUSE spawns perfectly well and is useless, and the caller needs to
    // know which of those happened.
    for (let i = 0; i < 60; i += 1) {
      if (proc.exitCode !== null) {
        starting = false
        return { ok: false, message: `the daemon exited during startup (code ${proc.exitCode})` }
      }
      if (await probe(port, 300)) {
        starting = false
        startedAt = Date.now()
        return { ok: true, message: `listening on ${port}` }
      }
      await wait(250)
    }
    starting = false
    return { ok: false, message: "the daemon did not start listening within 15s" }
  }

  const stop = async (): Promise<{ ok: boolean; message: string }> => {
    if (child === null || child.exitCode !== null) {
      if (await probe(port)) {
        return {
          ok: false,
          message:
            "that daemon was started outside the dev server — stop it where you started it",
        }
      }
      return { ok: true, message: "already stopped" }
    }

    const proc = child
    stopping = true
    try {
      // Ask before killing. The daemon's own shutdown interrupts each run through
      // the SDK's control channel, so an in-flight run ends with a result and a
      // cost figure instead of a hole in its log — and its worker subprocesses
      // get taken down with it. taskkill would end the daemon just as surely and
      // leave the agents running.
      await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
        method: "POST",
        signal: AbortSignal.timeout(2000),
      }).catch(() => {})

      for (let i = 0; i < 100; i += 1) {
        if (proc.exitCode !== null && !(await probe(port, 200))) {
          return { ok: true, message: "stopped" }
        }
        await wait(100)
      }

      // It did not go quietly.
      killTree(proc)
      for (let i = 0; i < 40; i += 1) {
        if (proc.exitCode !== null && !(await probe(port, 200))) {
          return { ok: true, message: "stopped (had to be killed)" }
        }
        await wait(100)
      }
      return { ok: false, message: "the daemon did not exit within 14s" }
    } finally {
      stopping = false
    }
  }

  return {
    name: "aide:daemon-control",
    apply: "serve",

    configureServer(server) {
      const json = (res: ServerResponse, code: number, body: unknown) => {
        res.statusCode = code
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify(body))
      }

      server.middlewares.use("/__daemon", (req, rawRes, next) => {
        const res = rawRes as ServerResponse
        const route = (req.url ?? "/").split("?")[0]

        if (route === "/status" || route === "/") {
          void status().then((s) => json(res, 200, s))
          return
        }
        if (route === "/log") {
          json(res, 200, { lines: log })
          return
        }
        if (req.method !== "POST") return next()

        if (route === "/start") {
          void start().then((r) => json(res, r.ok ? 200 : 500, r))
          return
        }
        if (route === "/stop") {
          void stop().then((r) => json(res, r.ok ? 200 : 409, r))
          return
        }
        if (route === "/restart") {
          void stop()
            .then(() => start())
            .then((r) => json(res, r.ok ? 200 : 500, r))
          return
        }
        next()
      })

      // `pnpm dev` should still bring the whole thing up without being asked.
      void start().then((r) => {
        server.config.logger.info(`  \x1b[32m➜\x1b[0m  daemon:   ${r.message}`)
      })

      // Only process death takes the daemon with it.
      //
      // There used to be a `server.httpServer.once("close", ...)` here too, and
      // it was a trap: Vite restarts its own dev server when the config or any
      // of its imports change, which closes the http server without the process
      // going anywhere. So landing a change to `vite.config.ts` or to this file
      // force-killed the daemon, and the replacement plugin instance then raced
      // the dying process for the port and adopted a corpse. A config reload is
      // not a shutdown, and it has no business stopping a daemon that may be
      // mid-run.
      const shutdown = () => {
        if (child) killTree(child)
      }
      process.once("exit", shutdown)
      process.once("SIGINT", shutdown)
      process.once("SIGTERM", shutdown)
    },
  }
}
