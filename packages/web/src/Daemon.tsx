import { useCallback, useEffect, useState } from "react"
import { api, type DaemonStatus, type Health } from "./api.js"
import { Button } from "./ui.js"

/** Fast enough that pressing start feels answered, slow enough to be invisible. */
const POLL_MS = 2000

const DOT: Record<DaemonStatus["state"], string> = {
  running: "bg-ok",
  adopted: "bg-ok",
  starting: "bg-info animate-pulse",
  stopped: "bg-err",
}

const LABEL: Record<DaemonStatus["state"], string> = {
  running: "daemon",
  adopted: "daemon (external)",
  starting: "daemon starting…",
  stopped: "daemon stopped",
}

/**
 * Daemon status and controls.
 *
 * Deliberately driven by `/__daemon` — the dev server's own routes — and not by
 * `/api/health`, which is proxied to the daemon and therefore says nothing when
 * the daemon is the thing that is down. Health still decides what the *label*
 * says about models and limits; this decides whether there is a process at all.
 *
 * When `/__daemon` is absent (a production build, no Vite) `status` stays null
 * and the whole control surface disappears rather than offering buttons that
 * cannot work.
 */
export function DaemonBar({ health, onChanged }: { health: Health | null; onChanged: () => void }) {
  const [status, setStatus] = useState<DaemonStatus | null>(null)
  const [supported, setSupported] = useState(true)
  const [busy, setBusy] = useState<"start" | "stop" | "restart" | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [logOpen, setLogOpen] = useState(false)
  const [lines, setLines] = useState<string[]>([])

  const poll = useCallback(async () => {
    try {
      const next = await api.daemonStatus()
      if (next === null) setSupported(false)
      else setStatus(next)
    } catch {
      /* transient; the next tick decides */
    }
  }, [])

  useEffect(() => {
    void poll()
    const timer = setInterval(() => void poll(), POLL_MS)
    return () => clearInterval(timer)
  }, [poll])

  useEffect(() => {
    if (!logOpen) return
    const load = () => void api.daemonLog().then((r) => setLines(r?.lines ?? []))
    load()
    const timer = setInterval(load, POLL_MS)
    return () => clearInterval(timer)
  }, [logOpen, status?.state])

  if (!supported) {
    return (
      <span className="text-[11px] text-fg-dim">
        {health ? `${health.taskModel} · ${health.maxConcurrentRuns} concurrent` : "daemon offline"}
      </span>
    )
  }

  const state = status?.state ?? "starting"

  const act = async (kind: "start" | "stop" | "restart", fn: () => Promise<{ message: string } | null>) => {
    setBusy(kind)
    setMessage(null)
    try {
      const r = await fn()
      setMessage(r?.message ?? null)
      // A daemon that just came up has projects to list; a stopped one does not.
      onChanged()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
      // A failed start is the case where the log actually matters.
      setLogOpen(true)
    } finally {
      setBusy(null)
      void poll()
    }
  }

  const crashed = state === "stopped" && status?.lastExit != null

  return (
    <div className="relative flex items-center gap-2">
      {health && state !== "stopped" && (
        <span className="text-[11px] text-fg-dim">
          {health.taskModel} · {health.maxConcurrentRuns} concurrent · {health.maxBudgetUsd}$/run cap
        </span>
      )}

      <span
        className="flex items-center gap-1.5 text-[11px] text-fg-muted"
        title={
          status?.pid
            ? `pid ${status.pid} on port ${status.port}`
            : status?.state === "adopted"
              ? "started outside the dev server"
              : `port ${status?.port ?? "?"}`
        }
      >
        <span className={`inline-block size-1.5 shrink-0 rounded-full ${DOT[state]}`} />
        {LABEL[state]}
      </span>

      {state === "stopped" && (
        <Button
          tone="primary"
          disabled={busy !== null}
          onClick={() => void act("start", api.daemonStart)}
        >
          {busy === "start" ? "starting…" : "start"}
        </Button>
      )}

      {(state === "running" || state === "adopted") && (
        <>
          <Button
            disabled={busy !== null}
            title={
              status?.managed
                ? "Stop and start the daemon"
                : "Starts a daemon managed by the dev server once the external one is gone"
            }
            onClick={() => void act("restart", api.daemonRestart)}
          >
            {busy === "restart" ? "restarting…" : "restart"}
          </Button>
          <Button
            tone="danger"
            disabled={busy !== null || !status?.managed}
            title={
              status?.managed
                ? "Stop the daemon. Runs in flight are interrupted cleanly first."
                : "This daemon was started outside the dev server — stop it where you started it"
            }
            onClick={() => void act("stop", api.daemonStop)}
          >
            {busy === "stop" ? "stopping…" : "stop"}
          </Button>
        </>
      )}

      {(crashed || logOpen || message) && (
        <button
          type="button"
          onClick={() => setLogOpen((v) => !v)}
          className={`text-[11px] underline-offset-2 hover:underline ${crashed ? "text-err" : "text-fg-dim"}`}
        >
          {crashed
            ? `exited (code ${status?.lastExit?.code ?? "?"})`
            : logOpen
              ? "hide log"
              : "log"}
        </button>
      )}

      {logOpen && (
        <div className="absolute top-8 right-0 z-10 w-[46rem] max-w-[80vw] rounded border border-line bg-chrome shadow-lg">
          <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
            <span className="text-[11px] text-fg-muted">daemon output</span>
            <button
              type="button"
              onClick={() => setLogOpen(false)}
              className="text-[11px] text-fg-dim hover:text-fg"
            >
              close
            </button>
          </div>
          <pre className="max-h-72 overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg-muted">
            {lines.length ? lines.join("\n") : "(no output captured)"}
          </pre>
          {message && <p className="border-t border-line px-3 py-1.5 text-[11px] text-fg">{message}</p>}
        </div>
      )}
    </div>
  )
}
