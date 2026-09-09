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
import { readFileSync } from "node:fs"
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

/**
 * `aide-agent --sessions <root>` and `--session <root> <id>`: read the
 * conversation store on THIS machine and print it as JSON.
 *
 * One-shot subcommands rather than messages on the `ToWorker` protocol, and the
 * difference is what they are for. That protocol describes a CONVERSATION — a
 * long-lived agent process holding an SDK session — and `SshRunner` is built to
 * match: one connection per chat, `ready` handshake, the project's lock held for
 * as long as it lives. Listing what conversations exist is none of those things.
 * It is a stateless read, it is polled, it must work when no agent is running,
 * and it must never take the lock.
 *
 * So this is shaped like every other remote read in the daemon — `gitBatch`,
 * `readRepoFile` — one ssh call that answers and exits. The cost is a connection
 * (~1.4s, measured), which is why the daemon caches it rather than polling it as
 * hard as the local path.
 *
 * Why it has to run over there at all: the SDK's `listSessions` reads
 * `~/.claude/projects/` on the machine it is called from, keyed by the project
 * root. For a remote project those files are on the far side and there is no
 * local directory for that root at all — so the daemon's own call returned an
 * empty list, and every conversation in the project was invisible in the UI
 * while sitting intact on disk. Nothing was lost; nothing could be found.
 *
 * Errors go to stdout as `{error}` rather than to a non-zero exit, because the
 * caller wants the reason on the transcript and a dead ssh call only carries a
 * status code.
 */
const [mode, root, sessionId] = process.argv.slice(2)
const QUERY_MODE = mode === "--sessions" || mode === "--session"
if (QUERY_MODE) {
  const { listSessions, getSessionMessages } = await import("@anthropic-ai/claude-agent-sdk")
  try {
    if (!root) throw new Error(`${mode} needs a project root`)
    const payload =
      mode === "--sessions"
        ? { sessions: await listSessions({ dir: root }) }
        : { messages: await getSessionMessages(sessionId ?? "", { dir: root }) }
    // Through stdout, which for these subcommands is a single JSON document
    // rather than the newline-framed stream the `--stdio` mode uses. Nothing
    // else may write there — see the console reassignment above, which is what
    // keeps an SDK progress line out of the middle of this.
    process.stdout.write(JSON.stringify(payload))
  } catch (err) {
    process.stdout.write(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
    )
  }
  // Drained before exiting, for the reason the agent loop's exit does it: a
  // large session list is many kilobytes and `process.exit` discards whatever
  // is still buffered.
  const done = () => process.exit(0)
  if (process.stdout.write("")) done()
  else process.stdout.once("drain", done)
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
// Not in a query mode: those answer on stdout and exit, and attaching these
// would leave the process alive holding an open stdin it will never be sent
// anything on — an ssh call that never returns, which is the one failure a
// polled read must not have.
if (!QUERY_MODE) {
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
          console.error(
            `aide-agent: unparseable message: ${err instanceof Error ? err.message : err}`,
          )
        }
      }
      cut = buffer.indexOf("\n")
    }
  })
}

/**
 * stdin closing is the kill switch.
 *
 * `SshRunner.kill()` closes this rather than signalling a pid, because a pid on
 * another machine is not something the daemon may signal. It is also what
 * happens when the ssh connection drops — so an agent whose daemon has gone
 * away exits instead of being orphaned, still holding a checkout and still
 * spending money with nobody reading the output.
 */
if (!QUERY_MODE) {
  process.stdin.on("end", () => {
    process.exit(0)
  })

  // The version rides on `ready`, which is the first thing the daemon sees and
  // therefore the only place a mismatch can be caught BEFORE a turn has started
  // touching the repository. An older daemon ignores the extra field; an older
  // agent omits it, and the daemon reads that as "v0" and says so.
  //
  // `build` is the deploy stamp beside this file's installation —
  // `<agent dir>/build-hash`, written by `deploy-agent` from the daemon's own
  // bytes (see `buildHash` in deploy.ts). The protocol number only moves when
  // the message shapes change, so it cannot say "this agent predates the
  // current policy"; the stamp can, and the daemon WARNS on a mismatch rather
  // than refusing, because same-protocol skew is degraded, not broken. Absent
  // when the deploy predates the stamp, or when this file runs from the
  // daemon's own checkout, where no stamp exists.
  //
  // Skipped in a query mode, and that is not tidiness: stdout there is ONE JSON
  // document, so a `ready` line in front of it makes the whole answer
  // unparseable.
  let build: string | undefined
  try {
    build = readFileSync(new URL("../../build-hash", import.meta.url), "utf8").trim() || undefined
  } catch {
    /* no stamp — an old deploy, or the daemon's own checkout */
  }
  write({ type: "ready", protocol: AGENT_PROTOCOL, ...(build ? { build } : {}) })
}
