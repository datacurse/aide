/**
 * `aide-agent --stdio` — the same agent loop, on the machine that holds the repo.
 *
 * Run over ssh by `SshRunner`. It speaks the identical `ToWorker` / `FromWorker`
 * protocol a forked worker speaks, because it IS the same loop (`loop.ts`) with
 * the IPC channel swapped for a pipe. That sharing is the point: two
 * implementations would drift, and the drift would surface as a remote
 * conversation that renders differently from a local one.
 *
 * ## stdout is the protocol
 *
 * One JSON object per line, and NOTHING else may be written there. A stray
 * `console.log` anywhere in the daemon's imports — or a library's banner —
 * lands mid-stream and the parent's `JSON.parse` fails on a line that looks like
 * prose. So `console.log` is reassigned to stderr below rather than trusted not
 * to be called: the SDK, its dependencies and aide's own modules are a lot of
 * code to audit, and the failure is silent corruption rather than an error.
 *
 * stderr is free-form and is relayed to the daemon's own stderr, which is where
 * a remote run's diagnostics show up.
 */
import { AGENT_PROTOCOL } from "@aide/protocol"
import { createAgentLoop } from "./loop.js"
import type { FromWorker, ToWorker } from "./main.js"

// Before anything else imports anything. Both are reassigned because the SDK
// writes progress lines and Node prints warnings through these.
console.log = (...args: unknown[]) => console.error(...args)
console.info = (...args: unknown[]) => console.error(...args)

const write = (msg: FromWorker): void => {
  // `\n`-terminated JSON, and the newline is the frame. `JSON.stringify` never
  // emits a raw newline inside a string (it escapes them as `\n`), so a line
  // boundary is unambiguous.
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}

const loop = createAgentLoop(write, () => {
  // Wait for stdout to drain rather than exiting on a timer. Over a pipe the
  // last events may still be buffered, and `process.exit` discards them — which
  // would lose exactly the `run.finished` the daemon is waiting for, leaving a
  // conversation that never ends. `write` returning false means the buffer is
  // full; `drain` fires when it has emptied.
  const done = () => process.exit(0)
  if (process.stdout.write("")) done()
  else process.stdout.once("drain", done)
})

/**
 * Inbound lines, reassembled.
 *
 * A pipe is a byte stream, not a message stream: a chunk can hold half a
 * message, several messages, or a message split mid-string. Buffering until a
 * newline is what makes this a protocol rather than a race that works on small
 * messages and fails on a pasted screenshot.
 */
let buffer = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk: string) => {
  buffer += chunk
  let cut = buffer.indexOf("\n")
  while (cut !== -1) {
    const line = buffer.slice(0, cut).trim()
    buffer = buffer.slice(cut + 1)
    if (line) {
      try {
        loop.handle(JSON.parse(line) as ToWorker)
      } catch (err) {
        // A malformed line is the daemon's bug or a corrupted pipe. Say so on
        // stderr and keep going: dropping one message beats killing a run that
        // is holding the project's lock.
        console.error(`aide-agent: unparseable message: ${err instanceof Error ? err.message : err}`)
      }
    }
    cut = buffer.indexOf("\n")
  }
})

/**
 * stdin closing is the kill switch.
 *
 * `SshRunner.kill()` closes this rather than signalling a pid, because a pid on
 * another machine is not something the daemon may signal. It is also what
 * happens when the ssh connection drops — so an agent whose daemon has gone
 * away exits instead of being orphaned, still holding a checkout and still
 * spending money with nobody reading the output.
 */
process.stdin.on("end", () => {
  process.exit(0)
})

// The version rides on `ready`, which is the first thing the daemon sees and
// therefore the only place a mismatch can be caught BEFORE a turn has started
// touching the repository. An older daemon ignores the extra field; an older
// agent omits it, and the daemon reads that as "v0" and says so.
write({ type: "ready", protocol: AGENT_PROTOCOL })
