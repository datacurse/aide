import { EventEmitter } from "node:events"
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import type { RunEvent, RunEventBody } from "@aide/protocol"
import { runLogPath, runsDir } from "@aide/protocol"

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
export class EventLog extends EventEmitter {
  #seq = new Map<string, number>()

  constructor() {
    super()
    this.setMaxListeners(0)
    mkdirSync(runsDir(), { recursive: true })
  }

  /** Stamps runId/seq/ts, persists, and fans out. Returns the stored event. */
  append(runId: string, body: RunEventBody): RunEvent {
    const seq = (this.#seq.get(runId) ?? this.#lastSeqOnDisk(runId)) + 1
    this.#seq.set(runId, seq)

    const event = { ...body, runId, seq, ts: Date.now() } as RunEvent
    appendFileSync(runLogPath(runId), `${JSON.stringify(event)}\n`, "utf8")
    this.emit(runId, event)
    return event
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

  #lastSeqOnDisk(runId: string): number {
    return this.read(runId, 0).at(-1)?.seq ?? 0
  }
}
