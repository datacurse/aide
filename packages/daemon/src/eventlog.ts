import { EventEmitter } from "node:events"
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import type { RunEvent, RunEventBody } from "@aide/protocol"
import { runLogPath, runsDir } from "@aide/protocol/node"
import { terminalEvent } from "./spend.js"

/**
 * Append-only NDJSON per run, plus an in-process fan-out to live subscribers.
 *
 * No database in slice 1 on purpose. The access pattern is "append, then replay
 * one run in order", which a file does natively. SQLite earns its place when
 * queries span many runs, and adding it early on Windows means either a native
 * build toolchain or a bet on node:sqlite's flag status in Node 22.
 *
 * Writes are synchronous: async appends can interleave and corrupt ordering, and
 * at tens-to-hundreds of events per run the cost is irrelevant.
 */
const isTerminal = (type: string): boolean => type === "run.finished" || type === "run.error"

export class EventLog extends EventEmitter {
  /** Per run: the last seq written, and whether it has already ended. */
  #state = new Map<string, { seq: number; sealed: boolean }>()

  constructor() {
    super()
    this.setMaxListeners(0)
    mkdirSync(runsDir(), { recursive: true })
  }

  /**
   * Stamps runId/seq/ts, persists, and fans out.
   *
   * Returns null for an append to a run that has already ended, which is
   * DROPPED rather than written. The invariant every reader here leans on is
   * that a log ends in exactly one terminal event, and it was enforced only by
   * each caller remembering to be careful. It got away twice on this machine:
   * one log took a stray `assistant.start` after its `run.finished` — the SDK
   * reporting a message for a turn already over — and eight ended up with two
   * terminal events, `#retire` writing over an outcome the turn had already
   * reported. Enforcing it in the one function that writes is the only place it
   * cannot be forgotten.
   */
  append(runId: string, body: RunEventBody): RunEvent | null {
    const state = this.#state.get(runId) ?? this.#fromDisk(runId)
    if (state.sealed) return null

    const seq = state.seq + 1
    this.#state.set(runId, { seq, sealed: isTerminal(body.type) })

    const event = { ...body, runId, seq, ts: Date.now() } as RunEvent
    appendFileSync(runLogPath(runId), `${JSON.stringify(event)}\n`, "utf8")
    this.emit(runId, event)
    return event
  }

  /**
   * Close every run a previous daemon left open.
   *
   * Six of this machine's runs end mid-tool-call and say nothing about how they
   * ended, because the process holding them went away: `#retire` covers a worker
   * that dies and the `closed` message covers a session that ends, but neither
   * runs in a daemon that is no longer there. The log then claims a turn that is
   * still going, forever — `spend.ts` reads one as running and bills it $0, and
   * a profile reports it unfinished a week later.
   *
   * Sound to do unconditionally BECAUSE it runs at boot, and only there. No turn
   * can be in flight in a process that has not begun listening, so a log without
   * a terminal event cannot belong to anything still running. Called at any
   * other moment this would race the turn currently being written.
   *
   * Reads the tail of each log rather than the whole of it, so the cost is one
   * `stat` and one 64KB read per run, not the ten megabytes of transcripts and
   * pasted screenshots they add up to.
   */
  async sealAbandoned(): Promise<string[]> {
    let files: string[]
    try {
      files = await readdir(runsDir())
    } catch {
      return []
    }

    const closed: string[] = []
    for (const file of files) {
      if (!file.endsWith(".ndjson")) continue
      if (await terminalEvent(join(runsDir(), file))) continue
      const runId = file.slice(0, -".ndjson".length)
      // Worded for what is actually known. The usual cause is a daemon that was
      // restarted or killed mid-turn, but a log can reach here any way that
      // leaves nobody to report an outcome, and claiming a specific cause the
      // log cannot evidence would be inventing one.
      this.append(runId, {
        type: "run.error",
        message:
          "this turn was still open when aide next started, so nothing was left to report how it ended",
      })
      closed.push(runId)
    }
    return closed
  }

  /** Everything after `fromSeq`, in order. `fromSeq: 0` replays the whole run. */
  read(runId: string, fromSeq = 0): RunEvent[] {
    const path = runLogPath(runId)
    if (!existsSync(path)) return []
    const out: RunEvent[] = []
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line) as RunEvent
        if (event.seq > fromSeq) out.push(event)
      } catch {
        // A torn final line can only be the one being written right now; the
        // subscriber will get it again through the live channel.
      }
    }
    return out
  }

  /**
   * Replay-then-live with no gap and no duplicates: subscribe first, buffer what
   * arrives during the read, then flush only the events the replay did not cover.
   * Doing it the other way round drops anything written between the two steps,
   * which is exactly the window a browser refresh lands in.
   */
  subscribe(runId: string, fromSeq: number, onEvent: (event: RunEvent) => void): () => void {
    let replaying = true
    const buffered: RunEvent[] = []

    const live = (event: RunEvent) => {
      if (replaying) buffered.push(event)
      else onEvent(event)
    }
    this.on(runId, live)

    const replayed = this.read(runId, fromSeq)
    for (const event of replayed) onEvent(event)

    const highWater = replayed.at(-1)?.seq ?? fromSeq
    replaying = false
    for (const event of buffered) {
      if (event.seq > highWater) onEvent(event)
    }

    return () => {
      this.off(runId, live)
    }
  }

  /**
   * What is already on disk for a run this process has not written to yet.
   *
   * One read for both answers. A brand new run has no file and comes back
   * `{ seq: 0, sealed: false }`, which is the common case and costs an `existsSync`.
   */
  #fromDisk(runId: string): { seq: number; sealed: boolean } {
    const events = this.read(runId, 0)
    return {
      seq: events.at(-1)?.seq ?? 0,
      // Anywhere in the log, not just at the end: a run that reported an outcome
      // and then took a straggler is over, and re-opening it to append more
      // would be the very thing the seal exists to stop.
      sealed: events.some((e) => isTerminal(e.type)),
    }
  }
}
