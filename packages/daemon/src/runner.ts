/**
 * Where a run's agent actually executes.
 *
 * This is a NAME for a seam that already existed rather than a new abstraction,
 * and that is the whole reason it is cheap. `chat.ts` has never called the Agent
 * SDK: it forks `worker/main.ts` and exchanges `ToWorker` / `FromWorker`
 * messages with it. Those messages are plain objects sent through one
 * `process.send` — no handles, no streams, nothing that only survives between a
 * parent and its own child — so the protocol was already serializable and
 * already transport-shaped. What was missing was permission to put something
 * other than a `fork` behind it.
 *
 * `LocalRunner` is that fork, unchanged. A remote runner speaks the same
 * messages over `ssh <host> aide-agent --stdio`, which is what lets a project on
 * another machine run its own git and hold its own checkout while the daemon
 * keeps doing what it does today: owning the lock, writing the event log, and
 * deciding what the browser sees. See `.aide/specs/0003`.
 *
 * The interface is deliberately the SMALL surface `chat.ts` actually uses —
 * `send`, three events, and a kill — rather than a `ChildProcess` shape with the
 * unused parts left in. Every member here is one a remote implementation can
 * honestly provide, which is the property that makes this a seam rather than a
 * local process wearing a different type.
 */
import type { ChildProcess } from "node:child_process"
import { fork, spawn } from "node:child_process"
import { AGENT_PROTOCOL } from "@aide/protocol"
import { buildHash } from "./deploy.js"
import { killTree, relayWorkerOutput } from "./proc.js"
import type { FromWorker, ToWorker } from "./worker/main.js"

/**
 * What a deploy from THIS checkout would stamp, memoized: the answer only
 * changes when the daemon's own files do, and the daemon restarts on that.
 */
let localBuild: Promise<string> | null = null
const daemonBuildHash = (): Promise<string> => (localBuild ??= buildHash())

export interface Runner {
  /**
   * A message for the agent. Fire-and-forget, exactly like `child.send`.
   *
   * Deliberately not a promise. `chat.ts` sends `interrupt` from a stop button
   * and `permission` from an HTTP handler, neither of which waits for delivery,
   * and making this async would invite a caller to await something that only
   * means "handed to the pipe" anyway.
   */
  send(msg: ToWorker): void

  /** A message from the agent. */
  onMessage(fn: (msg: FromWorker) => void): void

  /**
   * The transport failed — as distinct from the agent finishing.
   *
   * Locally this is `child.on("error")`, which is a spawn failure. Remotely it
   * is also a dropped connection, which has no local equivalent: the daemon
   * loses contact while the agent may well still be running. Both retire the
   * session, and the string says which so the transcript does not have to guess.
   */
  onError(fn: (err: Error) => void): void

  /**
   * The agent is gone. `code` and `signal` are best-effort — an ssh transport
   * can report its own exit and not the far process's — so the message a caller
   * builds from these has to read sensibly when both are null.
   */
  onExit(fn: (code: number | null, signal: string | null) => void): void

  /**
   * Stop the agent and everything under it, without waiting.
   *
   * Abstract rather than exposing a pid, and that is the one place a
   * `ChildProcess` genuinely could not be passed through: `killTree` is
   * `taskkill /T /F` against a LOCAL pid, and a pid on another machine is not a
   * number this process may signal. A remote runner ends the ssh session
   * instead, and the far side kills its own tree when its stdin closes.
   */
  kill(): void
}

/**
 * The agent as a child of this process. What every project gets today.
 *
 * `stdio` and `execArgv` are lifted verbatim from the `fork` this replaces,
 * including the pipes — `relayWorkerOutput` has to drain them or a chatty worker
 * blocks on a full 64KB buffer with no symptom but a run that stops.
 */
export class LocalRunner implements Runner {
  readonly child: ChildProcess

  constructor(workerPath: string, runId: string) {
    this.child = fork(workerPath, [], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    })
    relayWorkerOutput(this.child, runId)
  }

  send(msg: ToWorker): void {
    // A worker that has already exited is not an error worth throwing: the exit
    // handler has retired it, and an `interrupt` racing that is normal.
    if (this.child.connected) this.child.send(msg)
  }

  onMessage(fn: (msg: FromWorker) => void): void {
    this.child.on("message", (raw: unknown) => fn(raw as FromWorker))
  }

  onError(fn: (err: Error) => void): void {
    this.child.on("error", fn)
  }

  onExit(fn: (code: number | null, signal: string | null) => void): void {
    this.child.on("exit", fn)
  }

  kill(): void {
    killTree(this.child)
  }
}

/**
 * The agent on another machine, reached over ssh.
 *
 * One connection per conversation, not per message. The 1.4s an ssh connection
 * costs from this machine (measured against `tg`) is paid when a session starts,
 * and every turn after it rides the same pipe — which is the same reasoning that
 * made chats hold the SDK session open rather than forking per turn.
 *
 * `-T` because there is no terminal here and a pty would inject echo and line
 * discipline into a byte protocol. `BatchMode` for the same reason it is on
 * every other ssh call aide makes: a prompt nobody can answer is a hang.
 */
export class SshRunner implements Runner {
  readonly child: ChildProcess
  #buffer = ""
  #onMessage: ((msg: FromWorker) => void) | null = null
  #onError: ((err: Error) => void) | null = null
  readonly #host: string

  constructor(opts: { host: string; configPath: string; agentPath: string; runId: string }) {
    this.#host = opts.host
    this.child = spawn(
      "ssh",
      [
        "-T",
        "-o",
        "BatchMode=yes",
        "-F",
        opts.configPath,
        opts.host,
        // Absolute paths, NOT a bare command name. `ssh host <cmd>` does not get
        // a login shell, so `~/.local/bin` is not on PATH — a bare `claude` is
        // "not found" over ssh while working when typed interactively. Verified
        // on `tg`, where the binary is at /root/.local/bin/claude.
        opts.agentPath,
        "--stdio",
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    )

    this.child.stdout?.setEncoding("utf8")
    this.child.stdout?.on("data", (chunk: string) => this.#feed(chunk))
    // The far side's stderr is its diagnostics, and it is the only place a
    // remote run can explain itself. Prefixed like a local worker's.
    const tag = `[ssh ${opts.host} ${opts.runId.slice(0, 8)}]`
    this.child.stderr?.setEncoding("utf8")
    this.child.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim()) process.stderr.write(`${tag} ${line}\n`)
      }
    })
  }

  /** Reassemble newline-framed JSON out of arbitrary chunks. See `stdio.ts`. */
  #feed(chunk: string): void {
    this.#buffer += chunk
    let cut = this.#buffer.indexOf("\n")
    while (cut !== -1) {
      const line = this.#buffer.slice(0, cut).trim()
      this.#buffer = this.#buffer.slice(cut + 1)
      if (line) {
        try {
          this.#onMessage?.(JSON.parse(line) as FromWorker)
        } catch {
          // Not fatal: ssh itself can write a banner or a warning onto stdout
          // before the agent starts, and a line that is not our protocol is not
          // a reason to kill a run. It goes to stderr where it can be read.
          process.stderr.write(`[ssh] unparseable line: ${line.slice(0, 200)}\n`)
        }
      }
      cut = this.#buffer.indexOf("\n")
    }
  }

  send(msg: ToWorker): void {
    if (this.child.stdin?.writable) this.child.stdin.write(`${JSON.stringify(msg)}\n`)
  }

  /**
   * Wraps the caller's handler to check the version on `ready`.
   *
   * Here rather than in `chat.ts` because this is the only implementation the
   * check applies to, and because `ready` is the last moment before a turn is
   * sent — a refusal after that point is one the repository has already been
   * touched by. A mismatch is reported through `onError`, which retires the
   * session with the reason on the transcript, and the connection is dropped so
   * no turn can follow it.
   */
  onMessage(fn: (msg: FromWorker) => void): void {
    this.#onMessage = (msg) => {
      if (msg.type === "ready") {
        // Absent means an agent from before the field existed. Reported as 0 so
        // the message names a number rather than saying "undefined".
        const theirs = msg.protocol ?? 0
        if (theirs !== AGENT_PROTOCOL) {
          this.#onError?.(
            new Error(
              `${this.#host} runs aide-agent protocol v${theirs}, this daemon speaks v${AGENT_PROTOCOL}. Run \`pnpm deploy-agent ${this.#host}\` to update it.`,
            ),
          )
          this.kill()
          return
        }
        // Same protocol, possibly older code. A WARNING and never a refusal:
        // the messages parse fine either way, and what skew costs is policy —
        // a deny list extended here is decorative over there until the next
        // deploy, which is exactly what happened on `tg` and exactly what this
        // line exists to say out loud. Async because the daemon's own hash is
        // a file read; a warning landing a beat after `ready` is still before
        // anyone reads the log.
        const host = this.#host
        void daemonBuildHash()
          .then((mine) => {
            const stale = msg.build ? msg.build !== mine : true
            if (!stale) return
            process.stderr.write(
              `[aide] ${host} runs aide-agent build ${msg.build ?? "(unstamped, pre-dates the stamp)"}, ` +
                `this daemon's sources are build ${mine} — its policy may be out of date. ` +
                `Run \`pnpm deploy-agent ${host}\` to update it.\n`,
            )
          })
          .catch(() => {
            /* a hash that cannot be computed must not fail a connection */
          })
      }
      fn(msg)
    }
  }

  onError(fn: (err: Error) => void): void {
    this.#onError = fn
    this.child.on("error", fn)
  }

  onExit(fn: (code: number | null, signal: string | null) => void): void {
    this.child.on("exit", fn)
  }

  /**
   * Close stdin, which is the far side's exit signal — see `stdio.ts`.
   *
   * Not `killTree`: that is `taskkill` against a local pid, and the pid that
   * matters is on another machine. Ending the ssh session closes the remote
   * stdin, and the agent exits itself, taking its own children with it.
   */
  kill(): void {
    this.child.stdin?.end()
    // The local ssh client still has to go, or a far side that ignores its stdin
    // leaves this process holding a pipe forever.
    killTree(this.child)
  }
}
