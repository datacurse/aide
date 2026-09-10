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
// By relative path, not `@aide/protocol`, and that is not a style choice. Vite
// loads this config through Node: relative TypeScript is bundled for it, but a
// bare workspace specifier is left external, and Node then resolves
// `@aide/protocol` to raw `.ts` sources whose own `.js` imports it cannot follow
// — `pnpm build` dies before it starts, on a file the bundle never includes.
import { restartDecision, type Health } from "../protocol/src/health.js"
import type { Plugin, ViteDevServer } from "vite"
import { reclaimPort } from "./vite-port.js"

const here = dirname(fileURLToPath(import.meta.url))
const DAEMON_DIR = join(here, "..", "daemon")
/** The same entrypoint `node_modules/.bin/tsx` would run, minus the shell shim. */
const TSX_CLI = join(DAEMON_DIR, "node_modules", "tsx", "dist", "cli.mjs")

/** Enough output to see why a crash happened, not enough to leak memory. */
const LOG_LINES = 300

/** How often to ask the daemon whether its own source has changed under it. */
const FRESHNESS_POLL_MS = 2000

/**
 * How long the daemon must have been quiet before an automatic restart.
 *
 * `busy.writes === 0` alone is not quiet. A land answers, and the browser
 * immediately follows with a burst of list refreshes; the gap between two of
 * them is a moment where nothing is in flight and the work is obviously not
 * over. This turns that gap into a non-answer.
 */
const QUIET_MS = 1500

/**
 * How often to re-probe while the daemon is down. The gate below runs per
 * request and the browser polls three routes at once, so without this a boot
 * would cost a TCP connect per request rather than per quarter-second.
 */
const GATE_PROBE_MS = 250

/**
 * The message that hands a held reload to the page. Matched in `src/reload.ts`,
 * by string rather than by import: this file is loaded by Node through Vite's
 * config loader, and reaching into `src/` would pull React in with it.
 */
const RELOAD_HELD = "aide:reload-held"

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

/**
 * Where one plugin instance leaves its shutdown hook for the next.
 *
 * On `globalThis` under a registry symbol, not in a module variable, because a
 * config reload re-evaluates this module: Vite bundles the config and imports it
 * afresh, so anything held at module scope is a new copy that has never met the
 * instance it is replacing. The process is the same one throughout — that is the
 * whole reason the listeners piled up on it — so the process is where the handle
 * has to live. See the shutdown hook at the end of `configureServer`.
 */
const SHUTDOWN = Symbol.for("aide:daemon-control:shutdown")
const handover = globalThis as unknown as Record<symbol, (() => void) | undefined>

export function daemonControl(port: number, webPort: number): Plugin {
  let child: ChildProcess | null = null
  let starting = false
  /** Set while a stop we asked for is in flight, so its exit is not a crash. */
  let stopping = false
  let startedAt: number | null = null
  let lastExit: Status["lastExit"] = null
  /** Known to be accepting connections. Gates the proxy — see the middleware. */
  let reachable = false
  let lastProbeAt = 0
  /** Set while an automatic restart is in flight, so the poll cannot stack. */
  let refreshing = false
  /** The on-disk fingerprint seen last tick — see the settling check below. */
  let lastSeenSourceId: string | null = null
  /** Chat turns mid-answer as of the last poll, and whether that cost the page
   *  an update. See the hotUpdate hook. */
  let turnsInFlight = 0
  let reloadHeld = false
  /** The running dev server, for sending the held reload on. */
  let dev: ViteDevServer | null = null
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

  /**
   * Shut down a daemon this instance did not spawn but a previous one did.
   *
   * `stop()` refuses these on purpose — it cannot tell them from a `pnpm daemon`
   * someone is running in their own terminal, and killing that would be rude.
   * The caller here has already checked `supervised`, so it knows. There is no
   * `taskkill` fallback because there is no pid to kill: asking over HTTP is the
   * only lever, which is enough because the daemon answers before it dies.
   */
  const shutdownUnowned = async (): Promise<boolean> => {
    await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(2000),
    }).catch(() => {})
    for (let i = 0; i < 100; i += 1) {
      if (!(await probe(port, 200))) {
        reachable = false
        return true
      }
      await wait(100)
    }
    return false
  }

  const start = async (): Promise<{ ok: boolean; message: string }> => {
    if (child !== null && child.exitCode === null) {
      return { ok: true, message: "already running" }
    }
    if (await probe(port)) {
      // Adopted rather than reclaimed, because `pnpm daemon` standalone is a
      // supported way to run one. The warning matters though: an adopted daemon
      // may be running code from before your last land, and this dev server did
      // not start it so it cannot restart it either.
      reachable = true
      return {
        ok: true,
        message: `adopted a daemon already on ${port} — not started here, so restart it yourself if it is stale`,
      }
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
    // The lesson was not "never restart on a change", it was "never restart
    // during one". chokidar knew a file had changed and nothing else; it could
    // not know the daemon was three lines into a land. So the trigger moved off
    // the filesystem and onto the daemon itself, which can answer both
    // questions — see keepFresh below.
    const proc = spawn(process.execPath, [TSX_CLI, "src/server.ts"], {
      cwd: DAEMON_DIR,
      // AIDE_MANAGED is what lets a LATER instance of this plugin recognise this
      // daemon as one a dev server started, after a config reload has thrown
      // away the child handle. See keepFresh.
      env: { ...process.env, AIDE_PORT: String(port), AIDE_MANAGED: "1" },
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
      reachable = false
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
        reachable = true
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

  /**
   * Hand the page the reload we took off it, once nothing is answering.
   *
   * A custom message rather than Vite's own `full-reload`, because "nothing is
   * running" is not yet "now is a good moment". The page takes it while nobody
   * is looking — a hidden tab, with the ringing alarm carried across the
   * reload — or, if it stays visible, once somebody has answered and stopped
   * typing; see `src/reload.ts`.
   */
  const releaseHeldReload = (): void => {
    if (!reloadHeld || turnsInFlight > 0 || dev === null) return
    reloadHeld = false
    dev.config.logger.info("  aide: page updates released — reloading when you are back")
    dev.hot.send({ type: "custom", event: RELOAD_HELD })
  }

  /**
   * Restart the daemon when its source has changed, and only when that is free.
   *
   * This is the root fix for a skew that is otherwise guaranteed here: the
   * daemon loads its modules once, and the milestone is developing aide's daemon
   * inside aide, so every daemon-side change lands in a checkout whose daemon
   * predates it. The symptom was a 404 for a route added minutes earlier.
   *
   * The trigger is the daemon rather than the filesystem, which is the whole
   * difference from the `tsx watch` arrangement this replaces. chokidar knew a
   * file had changed and nothing else; the daemon knows both that its source
   * moved AND whether it is currently three lines into a land. `restartDecision`
   * holds that rule and is tested in `pnpm smoke` — this function only fetches,
   * obeys and logs.
   *
   * An adopted daemon is left alone: it belongs to whoever started it, and
   * killing someone's `pnpm daemon` because a file changed is not this plugin's
   * call. The header says "older code" for that case instead.
   */
  const keepFresh = async (say: (msg: string) => void): Promise<void> => {
    if (refreshing || starting || stopping) return

    let health: Health
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(1500),
      })
      if (!res.ok) return
      health = (await res.json()) as Health
    } catch {
      // Booting, or wedged. Either way the next tick asks again — but a daemon
      // that is not answering has no turn worth protecting a page from, and
      // leaving the last count standing would hold the page's updates for as
      // long as the daemon stayed down.
      turnsInFlight = 0
      releaseHeldReload()
      return
    }
    // A daemon too old to report the field cannot be reasoned about, and
    // `undefined` must not read as "not stale" — this is the one skew that
    // would disable the fix for skew.
    if (typeof health.stale !== "boolean" || health.busy === undefined) return

    // Read here rather than fetched from the hook that needs it: a `git merge`
    // rewriting forty files would otherwise be forty health requests inside a
    // second, to answer a question that changes about once a minute.
    turnsInFlight = health.busy.chats
    releaseHeldReload()

    // Ours, or a predecessor's. Anything else belongs to whoever started it.
    const owned = child !== null && child.exitCode === null
    if (!owned && health.supervised !== true) return

    const seen = lastSeenSourceId
    lastSeenSourceId = health.sourceId
    const decision = restartDecision(health, seen, QUIET_MS)
    if (!decision.restart) return

    refreshing = true
    try {
      record(`--- ${decision.reason}; restarting ---`)
      say(`daemon: ${decision.reason}, restarting`)
      if (owned) {
        await stop()
      } else if (!(await shutdownUnowned())) {
        record("--- the previous daemon would not exit; leaving it alone ---")
        return
      }
      const r = await start()
      record(`--- ${r.message} ---`)
      if (!r.ok) say(`daemon: automatic restart failed - ${r.message}`)
    } finally {
      refreshing = false
    }
  }

  return {
    name: "aide:daemon-control",
    apply: "serve",

    /**
     * Do not touch the page while a turn is in flight.
     *
     * The milestone is developing aide inside aide, so an agent rewriting
     * `packages/web/src` is the normal case, not an edge one — and when Fast
     * Refresh cannot swap a module in, Vite reloads the browser. That reload
     * lands under the very turn you are watching: the transcript you were
     * reading goes, and the document that comes back has never been touched, so
     * the browser will not let the finish make a sound. The alarm then rings
     * silently, and the mouse you move on your way back to the window is what
     * stops it.
     *
     * So: nothing is applied while `busy.chats` is above zero, and the page is
     * told afterwards. Returning an empty module list is how a plugin says
     * "there is nothing to update here", which is a no-op rather than a reload.
     *
     * It does not cover everything, and cannot: changing `vite.config.ts` or
     * anything it imports — this file included — restarts the dev server, and
     * the browser reloads on its own when the socket comes back. The trade is
     * that the page shows the code it loaded with until the turn is over.
     */
    hotUpdate() {
      if (turnsInFlight === 0) return
      if (!reloadHeld) {
        reloadHeld = true
        dev?.config.logger.info(
          `  aide: holding page updates — ${turnsInFlight} chat turn${turnsInFlight > 1 ? "s" : ""} in flight`,
        )
      }
      return []
    },

    async configureServer(server) {
      dev = server

      // Before Vite binds. A stale dev server from a previous session would
      // otherwise push this one to the next port, where the daemon's origin
      // guard rejects its POSTs — see vite-port.ts.
      const reclaimed = await reclaimPort(webPort)
      for (const { pid, name } of reclaimed.killed) {
        server.config.logger.info(`  [33m✖[0m  port ${webPort}: killed stale ${name} (pid ${pid})`)
      }
      if (reclaimed.refused) {
        const who = reclaimed.refused.map((p) => `${p.name} (pid ${p.pid})`).join(", ")
        server.config.logger.warn(
          `  port ${webPort} is held by ${who}, which is not a dev server — leaving it alone. ` +
            `Stop it, or set AIDE_WEB_PORT to something else.`,
        )
      }

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

      // Do not let the proxy attempt a connection that is known to fail.
      //
      // The daemon reconciles stranded tasks BEFORE it listens — deliberately,
      // since a health endpoint that answers has to mean the task list is
      // honest. Vite is ready in ~250ms and the daemon takes about a second, so
      // every `pnpm dev` has a window where the page is up and the daemon is
      // not, and the browser polls straight into it.
      //
      // vite.config.ts already answers those with a clean 503, but that is not
      // enough on its own: Vite registers its own proxy error handler AFTER the
      // one `configure` installs, so it logs an ECONNREFUSED stack trace no
      // matter what ours does. Three of them on every start, which reads like a
      // failure and is not one. There is nothing to log if the request never
      // reaches the proxy.
      //
      // Registered here rather than in the config because this is the only
      // place that knows whether the daemon is up. Middlewares added from
      // `configureServer` run ahead of the internal ones, the proxy included.
      const daemonUp = async (): Promise<boolean> => {
        if (reachable) return true
        const now = Date.now()
        if (now - lastProbeAt < GATE_PROBE_MS) return false
        lastProbeAt = now
        // Re-probed rather than trusted: a daemon someone started outside this
        // dev server has to be able to open the gate too.
        reachable = await probe(port, 200)
        return reachable
      }

      server.middlewares.use((req, rawRes, next) => {
        if (!(req.url ?? "").startsWith("/api")) return next()
        void daemonUp().then((up) => {
          if (up) return next()
          json(rawRes as ServerResponse, 503, {
            message: starting
              ? `daemon is starting on ${port}`
              : `daemon is not running on ${port}`,
          })
        })
      })

      // `pnpm dev` should still bring the whole thing up without being asked.
      void start().then((r) => {
        server.config.logger.info(`  \x1b[32m➜\x1b[0m  daemon:   ${r.message}`)
      })

      // Watching the daemon rather than the filesystem — see keepFresh.
      const freshness = setInterval(() => {
        void keepFresh((msg) => server.config.logger.info(`  ${msg}`))
      }, FRESHNESS_POLL_MS)

      // Vite closes and rebuilds its dev server whenever the config or any of
      // its imports change, which constructs a NEW plugin instance. Without this
      // the old instance's timer keeps polling, and two controllers racing to
      // restart the same daemon is worse than none. Clearing a timer here is
      // safe in a way that killing the daemon here was not.
      server.httpServer?.once("close", () => clearInterval(freshness))

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
      //
      // A config reload DOES build a new plugin instance, though, and this file
      // is one of the imports that triggers one — so a session spent editing it
      // registered three more listeners on the same process every few seconds,
      // and Node called it a leak at eleven. It is one: the count has no ceiling.
      //
      // The predecessor's hook cannot simply be removed, which is why this is a
      // handover rather than a cleanup. It holds the only handle to the daemon IT
      // spawned — the instance replacing it adopted that daemon over the port and
      // so has no pid to kill — and the new hook therefore calls the old one and
      // takes its place. Three listeners for the life of the process, and every
      // daemon still dies with it.
      const previous = handover[SHUTDOWN]
      const shutdown = () => {
        if (child) killTree(child)
        previous?.()
      }
      if (previous) {
        process.off("exit", previous)
        process.off("SIGINT", previous)
        process.off("SIGTERM", previous)
      }
      handover[SHUTDOWN] = shutdown
      process.once("exit", shutdown)
      process.once("SIGINT", shutdown)
      process.once("SIGTERM", shutdown)
    },
  }
}
