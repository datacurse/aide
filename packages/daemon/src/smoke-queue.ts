/**
 * Chat-lane and board semantics: `pnpm smoke:queue`.
 *
 * Separate from `smoke.ts` because it tests a different thing — process
 * lifetimes and the board's bookkeeping, not git plumbing — and because every
 * case here is a bug that cost real Opus money to find by hand. It forks the
 * real worker path against a stub (see smoke-worker.ts), so no model is ever
 * contacted and nothing outside a temp directory is touched.
 *
 * Run it after any change to chat.ts, board.ts or checkpoint.ts. The failures it
 * guards against are silent ones: a follow-up that quietly cold-starts, a
 * verdict that never reaches the backlog, a row id handed out twice while old
 * commits still carry it — and, now that every run shares one checkout, two
 * agents admitted into it at once.
 */
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { promisify } from "node:util"
import type {
  ChatSettings,
  ChatState,
  ChatStatus,
  Project,
  RunEvent,
  RunEventBody,
} from "@aide/protocol"
import { STATE_DIR } from "@aide/protocol"

// Point the chat lane at the stub and keep turns short, BEFORE importing it —
// both are read at module load.
process.env["AIDE_WORKER"] = fileURLToPath(new URL("./smoke-worker.ts", import.meta.url))
// Run logs and board links go to a temp directory, not to the real ~/.aide.
process.env["AIDE_HOME"] = await mkdtemp(join(tmpdir(), "aide-home-"))
process.env["AIDE_SMOKE_WORK_MS"] ??= "400"

const { EventLog } = await import("./eventlog.js")
const { ChatLane } = await import("./chat.js")

const run = promisify(execFile)
const git = (cwd: string, args: string[]) =>
  run("git", ["-C", cwd, ...args], { windowsHide: true })

let failures = 0
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures += 1
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * How long to give a turn that should have ended by now.
 *
 * The stub's own work, plus the boundary snapshot the daemon takes BEFORE it
 * releases the turn — several git processes, which on Windows is not noise
 * beside a 400ms stub turn. Waiting only for the stub is how this suite starts
 * reporting "the turn is no longer in flight" as a failure for a turn that has
 * finished and is merely still recording where it got to.
 */
const TURN_MS = Number(process.env["AIDE_SMOKE_WORK_MS"] ?? 400) + 800

/**
 * Wait until nothing is in flight on `l`, rather than for a fixed number of ms.
 *
 * The budget above is a sleep racing work whose duration is not fixed, and it
 * was measured on an idle machine. The commit gate does not run on one — it runs
 * beside the daemon, a live turn, and whatever else is going on — and losing
 * that race reports a turn that HAS finished, and is merely still recording
 * where it got to, as one that never ended. Which is precisely the failure the
 * comment above predicts, so this is that comment taken at its word rather than
 * a bigger number.
 *
 * Reproduced before changing anything: five runs in a row pass on an idle
 * machine, and four run at once all fail on "the turn is no longer in flight".
 *
 * The ceiling is only reached when something is genuinely stuck, and it is
 * generous because a suite that occasionally takes a few seconds longer beats
 * one that occasionally refuses a commit.
 */
const settled = async (l: { turns(): readonly unknown[] }, ms = 15_000): Promise<void> => {
  const deadline = Date.now() + ms
  while (l.turns().length > 0 && Date.now() < deadline) await wait(25)
}

/**
 * An idle window long enough that it cannot fire while a section is running.
 *
 * The lanes that check a session stays WARM want the reaper never to run; the
 * one that checks it gets evicted has its own short window and its own lane
 * below. Five seconds read as "never" on an idle machine and stopped being
 * "never" under load, where the git work between two turns can outlast it — so
 * the warm assertions started failing on `liveSessions()` for a session that was
 * doing exactly what it should. This is a fixture saying what it means rather
 * than a number that happened to be big enough.
 */
const NEVER_IDLE = 120_000

const root = await mkdtemp(join(tmpdir(), "aide-queue-"))
await git(root, ["init", "-b", "main"])
await git(root, ["config", "user.email", "smoke@aide.test"])
await git(root, ["config", "user.name", "aide smoke"])
// Git for Windows sets core.autocrlf=true system-wide, so a checkout rewrites
// LF as CRLF. That is git doing its job, but it makes "the file came back
// byte-for-byte" a statement about line-ending policy rather than about restore.
await git(root, ["config", "core.autocrlf", "false"])
await writeFile(join(root, "README.md"), "# queue smoke\n", "utf8")
await git(root, ["add", "-A"])
await git(root, ["commit", "-m", "init"])

const project: Project = {
  id: "p1",
  name: "queue-smoke",
  root,
  addedAt: new Date().toISOString(),
}

const log = new EventLog()

console.log(`repo: ${root}\n`)

// ---------------------------------------------------------------------------
console.log("\nchat sessions stay warm")
// A follow-up must land in the session that is already open. The stub reports
// how many turns THIS PROCESS has taken, so numTurns is the assertion: 2 means
// the message reached a live session, 1 means it silently cold-started and the
// whole warm path is doing nothing.
const lane = new ChatLane(log, { idleMs: NEVER_IDLE })
const say = (sessionId: string | null, text: string) =>
  lane.send({
    project,
    sessionId,
    text,
    attachments: [],
    mode: "auto",
    effort: "medium",
    thinking: true,
  })

const turnsOf = (runId: string): number => {
  const terminal = log.read(runId).at(-1)
  return terminal?.type === "run.finished" ? terminal.numTurns : 0
}

const c1 = await say(null, "first message")
await settled(lane)
const started = log.read(c1).find((e) => e.type === "run.started")
const chatSession = started?.type === "run.started" ? started.sessionId : null
check("a new chat learns its session id", Boolean(chatSession), String(chatSession))
check("the turn is no longer in flight", lane.turns().length === 0)
check("the session is held open", lane.liveSessions() === 1, `${lane.liveSessions()}`)

const c2 = await say(chatSession, "follow-up")
await settled(lane)
check("the follow-up reused the open session", turnsOf(c2) === 2, `numTurns ${turnsOf(c2)}`)
check("it did not fork a second one", lane.liveSessions() === 1, `${lane.liveSessions()}`)

const c3 = await say(chatSession, "third")
let refused = false
try {
  await say(chatSession, "same conversation, same tick")
} catch {
  refused = true
}
check("a second turn on a busy conversation is refused", refused)
await settled(lane)
check("the third turn also reused it", turnsOf(c3) === 3, `numTurns ${turnsOf(c3)}`)

const c4 = await say(chatSession, "stop me")
await wait(100)
check("interrupt resolves for a live turn", lane.interrupt(c4))
await settled(lane)
const stopped = log.read(c4).at(-1)
check(
  "an interrupted turn is filed cancelled",
  stopped?.type === "run.finished" && stopped.status === "cancelled",
  stopped?.type,
)
check(
  "the conversation survives its turn being stopped",
  lane.liveSessions() === 1,
  "a stop button that also throws away the warm session would be a silent tax",
)

// A UUID, because that is the shape of every id the SDK hands out — and since
// session ids name checkpoint refs, a made-up one exercises a rejection path no
// real conversation can reach.
const other = await say("dddddddd-1111-4111-8111-111111111111", "hello")
await settled(lane)
check("a different conversation gets its own session", lane.liveSessions() === 2)
check("and starts its own turn count", turnsOf(other) === 1, `numTurns ${turnsOf(other)}`)

// ---------------------------------------------------------------------------
console.log("\na run log ends in exactly one terminal event")
// Stated in `chat.ts`, relied on by `spend.ts` and by the profile, and enforced
// until now only by every caller remembering. It got away twice on the machine
// this was written on: one log took a stray `assistant.start` after its
// `run.finished`, and eight ended up with two terminal events. A log that breaks
// it does not look broken — it reads as a turn that is still running, forever,
// billing $0.
{
  const sealed = "aaaaaaaa-0000-4000-8000-000000000001"
  log.append(sealed, { type: "user.message", text: "hi" })
  log.append(sealed, {
    type: "run.finished",
    subtype: "success",
    status: "success",
    totalCostUsd: 1,
    modelUsage: {},
    numTurns: 1,
    durationMs: 10,
    permissionDenials: [],
  })
  const after = log.append(sealed, { type: "assistant.start" })
  check("an append after the outcome is dropped", after === null)
  check(
    "so the log still ends in its outcome",
    log.read(sealed).at(-1)?.type === "run.finished",
    "this is the exact shape that billed a finished $5 turn as $0 and running",
  )
  check("and a second outcome cannot land either", log.read(sealed).length === 2)

  // What a daemon killed mid-turn leaves behind: events, and nothing that says
  // how it ended. Nobody is coming back to write one — the process that owed it
  // an outcome is gone.
  const abandoned = "aaaaaaaa-0000-4000-8000-000000000002"
  log.append(abandoned, { type: "user.message", text: "left open" })
  log.append(abandoned, { type: "tool.start", toolUseId: "t1", name: "Bash", input: {}, parentToolUseId: null })

  const closed = await log.sealAbandoned()
  check("boot closes a run left open", closed.includes(abandoned), closed.join(","))
  const end = log.read(abandoned).at(-1)
  check("and it now says how it ended", end?.type === "run.error", end?.type)
  check(
    "a run that ended properly is left alone",
    !closed.includes(sealed),
    "re-closing a finished run would overwrite an outcome with an error",
  )
}

// ---------------------------------------------------------------------------
console.log("\nevery turn leaves a place to go back to")
// The conversation's checkpoint is one place to rewind to however long the chat
// runs. These are the finer-grained ones, and the assertions that matter are
// about ORDER: the snapshot is taken while the turn is ending, between the two
// IPC messages that end it, and both of the things it sits between are load
// bearing.
{
  const { listTurnCheckpoints } = await import("./checkpoint.js")

  const boundaries = await listTurnCheckpoints(root, chatSession ?? "")
  check(
    "one boundary per turn that changed the tree",
    boundaries.length === 4,
    `${boundaries.length} for 4 turns — the stub writes a different file each time`,
  )
  check(
    "numbered in the order they landed",
    boundaries.map((b) => b.n).join(",") === "1,2,3,4",
    boundaries.map((b) => b.n).join(","),
  )

  const marks = log.read(c2).filter((e) => e.type === "turn.checkpoint")
  const mark = marks[0]
  check("the turn's own log carries its boundary", marks.length === 1, `${marks.length}`)
  check(
    "and the command that returns to it",
    mark?.type === "turn.checkpoint" && mark.restore.includes(mark.ref),
    "one place knows how to go back",
  )
  // Written BEFORE the outcome on purpose. Put it after and every `.at(-1)`
  // reader in this file — and anything else that assumes a run log ends in its
  // terminal event — starts reading a finished turn as one that never ended.
  check(
    "the outcome is still the last thing in the log",
    log.read(c2).at(-1)?.type === "run.finished",
    "a boundary must not land after the terminal event",
  )
  // The other half of the same ordering, and the sharper of the two. The lock
  // goes when the turn record does, so releasing it first would let the next
  // turn's opening writes land in the tree this snapshot is still being taken
  // from — and boundary 3 would come back holding turn 4's work. The stub writes
  // its own turn number, so that is exactly what this reads back.
  const contents = await Promise.all(
    boundaries.map(async (b) => (await git(root, ["show", `${b.sha}:smoke-work.txt`])).stdout.trim()),
  )
  check(
    "each boundary holds its own turn's work and not the next one's",
    contents.join("|") === "turn 1|turn 2|turn 3|turn 4",
    contents.join("|"),
  )
}

lane.shutdown()
check("shutdown drops every session", lane.liveSessions() === 0)

// ---------------------------------------------------------------------------
console.log("\nidle conversations are evicted")
// The idle timer arms when the turn is let go of, which is AFTER its boundary is
// written. It has to be comfortably longer than that, or the window this asserts
// on — finished and still warm — has closed before the first check looks at it,
// and an eviction that works reads as a session that never opened.
const evicting = new ChatLane(log, { idleMs: 900, closeGraceMs: 500 })
const e1 = await evicting.send({
  project,
  sessionId: null,
  text: "then silence",
  attachments: [],
  mode: "auto",
  effort: "medium",
  thinking: true,
})
await settled(evicting)
check("warm right after the turn", evicting.liveSessions() === 1, `${evicting.liveSessions()}`)
await wait(1400)
check(
  "closed once nobody is talking to it",
  evicting.liveSessions() === 0,
  "an abandoned chat would otherwise hold a CLI subprocess for the life of the daemon",
)
check(
  "the evicted turn still ended properly",
  log.read(e1).at(-1)?.type === "run.finished",
  "eviction must not rewrite a finished turn's outcome",
)
evicting.shutdown()

// ---------------------------------------------------------------------------
console.log("\nthe lock — one agent has the repo")
// What replaced isolation. Conversations used to get a worktree each so several
// could edit at once; they now share the project's own checkout, so the thing
// worth asserting is that they cannot both be in it.
{
  const { readCheckpoint } = await import("./checkpoint.js")

  // `addProject` scaffolds this in production; a bare temp repo has no `.aide/`.
  await mkdir(join(root, STATE_DIR), { recursive: true })

  const locked = new ChatLane(log, { idleMs: NEVER_IDLE })

  const firstRun = await locked.send({
    project,
    sessionId: null,
    text: "off you go",
    attachments: [],
    mode: "auto",
    effort: "medium",
    thinking: true,
  })

  // Mid-turn: the lock is held and says by whom.
  const holder = locked.holderFor(project.id)
  check("the lock names its holder", holder?.runId === firstRun, holder?.runId ?? "(free)")

  let refusal = ""
  try {
    await locked.send({
      project,
      sessionId: null,
      text: "me too",
      attachments: [],
      mode: "auto",
      effort: "medium",
      thinking: true,
    })
  } catch (err) {
    refusal = err instanceof Error ? err.message : String(err)
  }
  check("a second conversation is refused", refusal !== "", refusal || "IT WAS ADMITTED")
  check(
    "and the refusal names what is in the way",
    refusal.includes("off you go") && refusal.includes("has the repo"),
    refusal,
  )
  check(
    "refused, not queued",
    locked.turns().length === 1,
    "a queued turn would start against a tree nobody has reviewed",
  )

  await wait(2500)

  // Two requests arriving in the SAME TICK, which is the case the lock is
  // actually for and the one an await-then-check gets wrong. `send` reads the
  // holder and then awaits a project doc read and a checkpoint before it
  // registers anything — so unless the record goes in synchronously, both of
  // these see a free project and both start an agent in the same checkout.
  const both = await Promise.allSettled([
    locked.send({
      project,
      sessionId: null,
      text: "first of two",
      attachments: [],
      mode: "auto",
      effort: "medium",
      thinking: true,
    }),
    locked.send({
      project,
      sessionId: null,
      text: "second of two",
      attachments: [],
      mode: "auto",
      effort: "medium",
      thinking: true,
    }),
  ])
  const admitted = both.filter((r) => r.status === "fulfilled").length
  check(
    "two simultaneous sends admit exactly one",
    admitted === 1,
    `${admitted} admitted — the lock has to be claimed before the first await`,
  )
  await wait(2500)

  await wait(2500)
  check("the lock is released when the turn ends", locked.holderFor(project.id) === null)

  const events = log.read(firstRun)
  const cpEvent = events.find((e) => e.type === "checkpoint.taken")
  check("a checkpoint was taken", Boolean(cpEvent), "the run has no undo without one")
  check(
    "and it is reported BEFORE the run starts",
    events.findIndex((e) => e.type === "checkpoint.taken") <
      events.findIndex((e) => e.type === "run.started"),
    "a snapshot taken after the agent writes is a snapshot of the damage",
  )
  check(
    "the event carries the command that undoes it",
    cpEvent?.type === "checkpoint.taken" && cpEvent.restore.includes(cpEvent.ref),
    "one place knows how to undo a run",
  )

  // Read from the log, not rebuilt from `process.pid`: the stub names the
  // session after the CHILD's pid, and guessing it here quietly tests nothing.
  const started2 = events.find((e) => e.type === "run.started")
  const smokeSession = started2?.type === "run.started" ? (started2.sessionId ?? "") : ""
  check("the conversation reported a session id", Boolean(smokeSession), smokeSession || "(none)")
  // The checkpoint was taken before the session had a name, so it has to have
  // been handed over to one. Without this the only reference to the snapshot is
  // a run id nothing will ever look up again.
  const adopted = await readCheckpoint(root, smokeSession)
  check(
    "the checkpoint followed the session id",
    adopted?.sha === (cpEvent?.type === "checkpoint.taken" ? cpEvent.sha : ""),
    adopted?.ref ?? "(lost)",
  )

  // A follow-up must NOT re-snapshot. The baseline is the tree as it was when
  // the conversation started, and moving it forward every turn would make the
  // final review show only the last message's work.
  const secondRun = await locked.send({
    project,
    sessionId: smokeSession,
    text: "again",
    attachments: [],
    mode: "auto",
    effort: "medium",
    // The one turn here sent with thinking off, so the two assertions below can
    // read the record the profile is going to be judged from.
    thinking: false,
  })
  await settled(locked)
  check(
    "a follow-up does not re-checkpoint",
    !log.read(secondRun).some((e) => e.type === "checkpoint.taken"),
    "the baseline is the conversation, not the turn",
  )
  // The composer's toggle leaves no other trace: the SDK's session file stamps a
  // turn with its permission mode and says nothing about thinking, so if this
  // line is not written the experiment cannot be scored afterwards.
  const asked = log.read(secondRun).find((e) => e.type === "user.message")
  check(
    "a turn sent with thinking off says so in its log",
    asked?.type === "user.message" && asked.thinking === false,
    `${asked?.type === "user.message" ? String(asked.thinking) : "(no message)"}`,
  )
  const thought = log.read(firstRun).find((e) => e.type === "user.message")
  check(
    "and an ordinary turn carries nothing",
    thought?.type === "user.message" && thought.thinking === undefined,
    "every log written before the toggle existed is a turn that thought; absent has to keep meaning that",
  )
  check(
    "and the original baseline still stands",
    (await readCheckpoint(root, smokeSession))?.sha === adopted?.sha,
  )

  // ---- which model answered ------------------------------------------------
  // `run.started.model` is the only record of it, and the field a profile bills
  // against. The stub applies a follow-up's `model` the way the real loop
  // applies `q.setModel`, so what these read is the setting the SESSION is on
  // rather than what the composer happened to send.
  const modelOf = (runId: string): string => {
    const started = log.read(runId).find((e) => e.type === "run.started")
    return started?.type === "run.started" ? started.model : "(none)"
  }
  // The default is read from CONFIG rather than spelled out, because it is
  // overridable by `AIDE_TASK_MODEL` and a literal here would assert the
  // environment instead of the fallback.
  const { CONFIG } = await import("./config.js")

  check(
    "a turn that names no model gets the daemon's default",
    modelOf(firstRun) === CONFIG.taskModel,
    modelOf(firstRun),
  )

  // The switch itself, mid-conversation, into a session that is already warm.
  // This is the whole feature: it must NOT cost a cold start, because a model is
  // a control request like the mode and the effort — see `#reusable`.
  const turnsBefore = log
    .read(firstRun)
    .concat(log.read(secondRun))
    .filter((e) => e.type === "run.started").length
  const switched = await locked.send({
    project,
    sessionId: smokeSession,
    text: "and again, cheaper",
    attachments: [],
    mode: "auto",
    effort: "medium",
    thinking: true,
    model: "claude-haiku-4-5-20251001",
  })
  await settled(locked)
  check(
    "a turn can name a different model",
    modelOf(switched) === "claude-haiku-4-5-20251001",
    modelOf(switched),
  )
  check(
    "and switching model reuses the warm session",
    !log.read(switched).some((e) => e.type === "checkpoint.taken") && turnsBefore === 2,
    "a model is a control request, not a new system prompt — a cold start here is ~1.4s and a transcript replay for nothing",
  )

  // The half that a diff-only follow-up gets wrong in the silent direction:
  // `#followUp` sends the field only when it CHANGED, so a turn sent with no
  // model of its own must fall back to the DAEMON'S DEFAULT, not sit on
  // whichever model the previous message picked. Without the resolve-then-
  // compare in `#followUp` this turn stays on Haiku and nothing says so.
  const reverted = await locked.send({
    project,
    sessionId: smokeSession,
    text: "back to normal",
    attachments: [],
    mode: "auto",
    effort: "medium",
    thinking: true,
  })
  await settled(locked)
  check(
    "and a turn that names none goes back to the default rather than inheriting",
    modelOf(reverted) === CONFIG.taskModel,
    `${modelOf(reverted)} — a turn with no model must not inherit the last one's`,
  )

  locked.shutdown()
}

// ---------------------------------------------------------------------------
console.log("\ndone, and undone")
// The gate the whole design rests on, and the only bit of state aide keeps about
// a conversation. It is a toggle now rather than a verdict that also rewrote a
// backlog, so what these assert is that it survives, that it can be taken back,
// and that a running turn outranks it.
{
  const { closeChat, reopenChat, chatStatuses } = await import("./board.js")
  const { NO_TURNS } = await import("./sessions.js")
  type LiveChats = import("./sessions.js").LiveChats

  const sessions = [{ sessionId: "sess-done" }, { sessionId: "sess-open" }]

  /**
   * A lane with exactly one turn in flight.
   *
   * Built as a `LiveChats` rather than as the `{working, blocked}` pair this used
   * to take, which is the point of the change it is covering: a projection could
   * be handed `working: false` over a live turn and nothing would notice. Here a
   * turn either exists for a session or it does not.
   */
  const running = (sessionId: string, blocked = false): LiveChats => ({
    turnForSession: (s) =>
      s === sessionId
        ? { runId: "run-live", projectId: project.id, sessionId, startedAt: 0, text: "", blocked, held: false }
        : null,
    holderFor: () => null,
  })

  await closeChat(project, "sess-done")
  let statuses = await chatStatuses(project, sessions, NO_TURNS)
  check("a ticked chat reads as closed", statuses["sess-done"]?.state === "closed")
  check("and says so as a flag too", statuses["sess-done"]?.done === true)
  check(
    "an untouched chat has no state at all",
    statuses["sess-open"]?.state === null,
    "a badge on every row buries the one that means something",
  )
  check("and is not done", statuses["sess-open"]?.done === false)

  // Working outranks done. A chat you ticked off and then asked one more thing
  // of is running, whatever the tick says — and showing it as finished while an
  // agent is mid-turn in your checkout is the one reading that could mislead.
  statuses = await chatStatuses(project, sessions, running("sess-done"))
  check(
    "a new turn on a finished chat reads as working",
    statuses["sess-done"]?.state === "working",
    "the tick is not a lock",
  )
  // Deliberately still `done` HERE. The untick is the chat route's, on the send
  // — `chatStatuses` is a reader and must not quietly clear a bit nobody wrote
  // to, or the board and the list would be two answers to one question. This
  // asserts the reader stays a reader; the send's own untick is below.
  check("the reader does not untick it by itself", statuses["sess-done"]?.done === true)

  // The other half of what the lock carries, and the half that used to travel in
  // a projection of its own: a turn stopped on a permission prompt is the one
  // thing in the list that is stopped ON you.
  statuses = await chatStatuses(project, sessions, running("sess-open", true))
  check(
    "a turn waiting on a click says so",
    statuses["sess-open"]?.blocked === true && statuses["sess-open"]?.state === "working",
  )
  check(
    "and a chat with no turn is never blocked",
    statuses["sess-done"]?.blocked === false,
    "blocked is only ever true of the run in flight",
  )

  await reopenChat(project, "sess-done")
  statuses = await chatStatuses(project, sessions, NO_TURNS)
  check(
    "unticking it undoes the whole thing",
    statuses["sess-done"]?.state === null && statuses["sess-done"]?.done === false,
    "nothing was deleted, so there is nothing that cannot come back",
  )

  // The chat route calls this on EVERY send with a session id, not only on the
  // ticked ones — asking first would be a board read in front of every message
  // to save a write that is already a no-op. So it has to be safe on a chat that
  // was never ticked and on one already unticked: a throw here would surface as
  // a warning line under a turn that went out perfectly well.
  await reopenChat(project, "sess-done")
  await reopenChat(project, "sess-open")
  statuses = await chatStatuses(project, sessions, NO_TURNS)
  check(
    "unticking an already-open chat changes nothing",
    statuses["sess-done"]?.done === false && statuses["sess-open"]?.done === false,
    "a send into an untouched chat must not error on the board",
  )

  // And it survives the round trip to disk. `board.json` is the only record of
  // the tick, so an untick that lived in memory would come back on a restart —
  // a chat you had reopened by writing in it, marked finished again by nothing.
  await closeChat(project, "sess-open")
  statuses = await chatStatuses(project, sessions, NO_TURNS)
  check("ticked, and on disk", statuses["sess-open"]?.done === true)
  await reopenChat(project, "sess-open")
  statuses = await chatStatuses(project, sessions, NO_TURNS)
  check(
    "and unticked, on disk",
    statuses["sess-open"]?.done === false,
    "the untick is a write, not a view",
  )
}

// ---------------------------------------------------------------------------
console.log("\na composed chat keeps the mode it was composed at")
// The `survey` button writes the prompt AND the mode it has to go out at, and
// the composer saves the draft on every keystroke — so the mode has to survive
// being edited, and has to be droppable when a human picks one by hand. Absence
// and presence-as-undefined therefore mean different things, which is the kind
// of distinction that reads as a typo and gets "simplified" to `??`.
{
  const { mergedMode } = await import("@aide/protocol")

  check(
    "an ordinary keystroke keeps it",
    mergedMode("plan", { text: "edited" } as { mode?: undefined }) === "plan",
    "a survey you fixed a typo in must not silently go out on Auto",
  )
  check("and it stays absent on a chat that never had one", mergedMode(undefined, {}) === undefined)
  check(
    "picking a mode by hand clears it",
    mergedMode("plan", { mode: undefined }) === undefined,
    "the picker would otherwise read Auto while the turn went out on Plan",
  )
  check("and picking another sets it", mergedMode("plan", { mode: "auto" }) === "auto")
}

// ---------------------------------------------------------------------------
console.log("\na chat's own settings beat the defaults, and only its own")
// Mode, model, effort and thinking used to be one remembered value each, shared
// by every chat — switching model for one deliberate turn silently switched
// every conversation. The precedence that replaced it lives in protocol so both
// composers read one rule; every reading of it fails quietly, so each rung is
// pinned here.
{
  const { resolveChatSettings } = await import("@aide/protocol")
  const defaults: ChatSettings = {
    mode: "auto",
    effort: "high",
    thinking: true,
    model: "claude-opus-5",
  }

  const untouched = resolveChatSettings({ composed: null, chosen: {}, inherited: null, defaults })
  check(
    "a chat that picked nothing runs on the defaults",
    untouched.mode === "auto" &&
      untouched.effort === "high" &&
      untouched.thinking === true &&
      untouched.model === "claude-opus-5",
  )
  check(
    "its own pick beats the default",
    resolveChatSettings({
      composed: null,
      chosen: { model: "claude-haiku-4-5-20251001", effort: "low" },
      inherited: null,
      defaults,
    }).model === "claude-haiku-4-5-20251001",
  )
  check(
    "thinking OFF for one chat survives a default of on",
    resolveChatSettings({ composed: null, chosen: { thinking: false }, inherited: null, defaults })
      .thinking === false,
    "`??` and never `||` — false is a choice here, and `||` reads it as absence",
  )
  check(
    "the mode a chat was last driven at beats the default",
    resolveChatSettings({ composed: null, chosen: {}, inherited: "plan", defaults }).mode === "plan",
    "a chat run on Plan elsewhere must not silently revert on open",
  )
  check(
    "but loses to a mode picked in this chat's own bar",
    resolveChatSettings({ composed: null, chosen: { mode: "auto" }, inherited: "plan", defaults })
      .mode === "auto",
    "the pick is explicit and may not have been sent yet",
  )
  check(
    "and a composed chat's mode outranks everything",
    resolveChatSettings({ composed: "plan", chosen: { mode: "auto" }, inherited: null, defaults })
      .mode === "plan",
    "a survey sent at a mode that acts is an instruction and its own contradiction",
  )
  check(
    "a pick of one control leaves the others on the defaults",
    resolveChatSettings({ composed: null, chosen: { effort: "low" }, inherited: null, defaults })
      .model === "claude-opus-5",
  )
}

// ---------------------------------------------------------------------------
console.log("\nchat list order")
{
  const { sortChats } = await import("@aide/protocol")
  /** Born at `n`, last spoken to at `spoke` — the two dates the order can pick from. */
  const at = (n: number, spoke = n) => ({ createdAt: n, lastModified: spoke })
  const st = (state: ChatState | null, extra: Partial<ChatStatus> = {}): ChatStatus => ({
    state,
    blocked: false,
    done: state === "closed",
    ...extra,
  })
  // Strictly by date, with nothing allowed in front of it. What a row is doing
  // is drawn on the row; if it could also move the row, then parking a note
  // while an older chat has the repo would file the note underneath it — and
  // "newest" would stop meaning "top" exactly when you were adding to the list.
  //
  // Which is why `closed` comes out mid-list here and nothing is wrong: finished
  // chats are last on screen because the list draws them as their own group
  // under their own heading, not because the sort sinks them.
  const sorted = sortChats([
    { id: "blocked", ...at(100), status: st("working", { blocked: true }) },
    { id: "working", ...at(300), status: st("working") },
    { id: "ordinary", ...at(400), status: st(null) },
    { id: "closed", ...at(500), status: st("closed") },
    { id: "parked", ...at(600), status: st(null) },
  ])
  check(
    "newest first, whatever each row is doing",
    sorted.map((r) => r.id).join(" ") === "parked closed ordinary working blocked",
    "a note parked while an older chat has the repo is still the top row",
  )

  // The list is read by position, so speaking to a chat must not move it: a row
  // that jumps to the top when you ask it one more thing drags every row below
  // it along, and the place you had learned for all of them is gone.
  const spoken = sortChats([
    { id: "old", ...at(100, 900), status: st(null) },
    { id: "new", ...at(200), status: st(null) },
  ])
  check("a new prompt on an old chat leaves it below a newer one", spoken[0]?.id === "new")

  // The one other order there is, and it is opt-in: last spoken to first. The
  // default has to stay "created" — a caller that says nothing keeps the
  // guarantee that a parked note lands where you are looking — so both the
  // explicit spelling and the silence are pinned, not just the new word.
  const active = sortChats(
    [
      { id: "old", ...at(100, 900), status: st(null) },
      { id: "new", ...at(200), status: st(null) },
    ],
    "activity",
  )
  check(
    "the activity order puts the chat you just spoke to first",
    active[0]?.id === "old",
    "an old chat that just answered outranks a newer silent one",
  )
  check(
    "and asking for created by name is the default order",
    sortChats(
      [
        { id: "old", ...at(100, 900), status: st(null) },
        { id: "new", ...at(200), status: st(null) },
      ],
      "created",
    )[0]?.id === "new",
    "the two spellings of the default must not drift apart",
  )

  // A session whose first entry carried no timestamp still has to land
  // somewhere, and its mtime is the only date it has.
  const undated = sortChats([
    { id: "dated", ...at(100), status: st(null) },
    { id: "undated", createdAt: null, lastModified: 300, status: st(null) },
  ])
  check("an undated session falls back to its mtime", undated[0]?.id === "undated")
}

// ---------------------------------------------------------------------------
console.log("\nticking a conversation off keeps its undo")
// There is no checkout to reclaim and no row to remove. What the tick has to do
// instead is leave the way back intact and SAY so — it is the point at which
// someone decides the work was good, and deciding it was not wants a command
// rather than a shrug.
{
  const { closeChat } = await import("./board.js")
  const { takeCheckpoint, readCheckpoint } = await import("./checkpoint.js")

  const session = "99999999-8888-7777-6666-555555555555"
  const cp = await takeCheckpoint(root, session)

  const closed = await closeChat(project, session)
  check(
    "it says where the undo is",
    (closed.warning ?? "").includes(cp.ref),
    closed.warning ?? "(silent)",
  )
  check(
    "the checkpoint is NOT deleted with the verdict",
    (await readCheckpoint(root, session))?.sha === cp.sha,
    "ticking a chat off must not make itself the irreversible step",
  )
}

// ---------------------------------------------------------------------------
console.log("\nthe profile")
// Arithmetic over an event log, which is the kind of thing that goes wrong
// silently: nobody notices that a profile bills four minutes of waiting for a
// human to the model's thinking, or reports six minutes of tool work inside a
// four-minute turn. The synthetic run below is built to have exactly those two
// traps in it.
{
  const { summarizeRun, conversationProfile } = await import("./profile.js")

  let seq = 0
  const at = (ts: number, body: RunEventBody): RunEvent =>
    ({ ...body, runId: "synthetic", seq: (seq += 1), ts }) as RunEvent

  const events: RunEvent[] = [
    at(0, { type: "user.message", text: "do the thing" }),
    at(100, {
      type: "run.started",
      projectId: project.id,
      model: "m",
      cwd: root,
      sessionId: "synthetic",
    }),
    at(200, { type: "assistant.start" }),
    // Two calls in ONE assistant message, so they share both stamps.
    at(1200, { type: "tool.start", toolUseId: "a", name: "Bash", input: { command: "one" }, parentToolUseId: null }),
    at(1200, { type: "tool.start", toolUseId: "b", name: "Bash", input: { command: "two" }, parentToolUseId: null }),
    // A third call in the same message, refused. Same stamps as the pair above,
    // so the merged tool interval is unchanged and the assertions below still
    // measure what they were written to measure.
    at(1200, { type: "tool.start", toolUseId: "d", name: "Bash", input: { command: "rm -rf /" }, parentToolUseId: null }),
    at(4200, { type: "tool.end", toolUseId: "a", ok: true, summary: "" }),
    at(4200, { type: "tool.end", toolUseId: "b", ok: false, summary: "boom" }),
    at(4200, {
      type: "tool.end",
      toolUseId: "d",
      ok: false,
      summary: "Permission to use Bash with command rm -rf / has been denied.",
    }),
    at(4300, { type: "assistant.start" }),
    at(5300, { type: "permission.request", requestId: "p", name: "Bash", input: {} }),
    at(9300, { type: "permission.resolved", requestId: "p", allowed: true, reason: "" }),
    at(9400, { type: "tool.start", toolUseId: "c", name: "Edit", input: { file_path: "x.ts" }, parentToolUseId: null }),
    at(9900, { type: "tool.end", toolUseId: "c", ok: true, summary: "" }),
    at(10_000, {
      type: "run.finished",
      subtype: "success",
      status: "success",
      totalCostUsd: 1,
      modelUsage: {},
      numTurns: 3,
      durationMs: 10_000,
      // The shape aide actually observed: the SDK resolved this one itself, so
      // it is in the audit list with no message — and it is ALSO the failed
      // `Bash` above, because a refusal reaches the model as an error result.
      // The second has no failed call to explain it and must survive.
      permissionDenials: [
        { tool: "Bash", reason: "" },
        { tool: "Read", reason: "reading /etc/shadow was refused" },
      ],
    }),
  ]

  const s = summarizeRun("synthetic", events)
  check(
    "parallel tool calls are counted once, not twice",
    s.toolMs === 3500,
    `${s.toolMs}ms — the sum would be 6500 and would not fit in the turn`,
  )
  check(
    "a human being asked is not the model thinking",
    s.blockedMs === 4000,
    `${s.blockedMs}ms blocked; ${10_000 - s.toolMs - s.blockedMs}ms left for the model`,
  )
  check(
    "thinking is measured from the anchor, not from the last event",
    s.generatingMs === 2000,
    `${s.generatingMs}ms`,
  )
  check(
    "the failed calls are the ones that failed",
    s.calls.filter((c) => c.ok === false).length === 2,
    "one blew up, one was refused",
  )
  check("and it kept what the tool said", s.calls[1]?.summary === "boom", s.calls[1]?.summary ?? "")
  check(
    "both denials are still recorded",
    s.denials.length === 2,
    "the de-duplication below is about what is PRINTED; the log must keep everything",
  )

  // One refused call reaches the document twice — as a failed call, because the
  // SDK answers a denial with an error result, and again in the run's own
  // denial list. Printing both put the same denied `Bash` in "What went wrong"
  // as two bullets, the second reading "no reason recorded", so the section
  // that exists to say what went wrong doubled its own count.
  {
    const { unexplainedDenials } = await import("./profile.js")
    const left = unexplainedDenials(
      s.calls.filter((c) => c.ok === false),
      s.denials,
    )
    check(
      "a denial the failed list already shows is not printed twice",
      !left.some((d) => d.tool === "Bash"),
      left.map((d) => d.tool).join(",") || "(none left)",
    )
    check(
      "but one with a reason nothing explains survives",
      left.length === 1 && left[0]?.reason === "reading /etc/shadow was refused",
      "dropping a stated reason on the strength of an unrelated failure loses the only readable part",
    )
  }

  // The same events with the anchors removed. A task run has no partial stream,
  // so it has no anchors, and the honest answer is one bucket rather than a
  // number derived from stamps that do not mean what the split needs them to.
  const unanchored = summarizeRun("synthetic", events.filter((e) => e.type !== "assistant.start"))
  check(
    "a run with no anchors declines to split model time",
    unanchored.generatingMs === null,
    `${unanchored.generatingMs}`,
  )

  // And the whole thing, over the logs the stub actually wrote. Four turns:
  // three that ran to completion and the one that was interrupted.
  const profile = await conversationProfile(log, project, chatSession ?? "")
  check(
    "every turn of the conversation is found",
    profile.runs === 4,
    `${profile.runs} — matched by run.started, since nothing indexes session to run`,
  )
  check(
    "the prompts are in it verbatim",
    profile.markdown.includes("> stop me"),
    "the prompts are the thing the profile exists to be asked about",
  )
  check(
    "the interrupted turn is reported as cancelled",
    profile.markdown.includes("**cancelled**"),
    "a turn that was stopped must not read as one that succeeded",
  )
  check(
    "the cost is labelled an estimate",
    profile.markdown.includes("estimate"),
    "the brief: anything that displays a cost figure has to say what it is",
  )
  check(
    "the round trips are in it",
    profile.markdown.includes("## Round trips") && profile.markdown.includes("tool calls per step"),
    "the number that predicts the wall clock is the reason this is not called a receipt",
  )

  const empty = await conversationProfile(log, project, "11111111-2222-4333-8444-555555555555")
  check(
    "a conversation aide never ran gets an answer, not an error",
    empty.runs === 0 && empty.markdown.includes("no run log"),
    "a chat held in the CLI is readable here and has no event log",
  )
}

// ---------------------------------------------------------------------------
console.log("\ncommitting is a run of its own")
// `hold` is the lane's non-agent entry point, and the commit is its only caller.
// Nothing here touches git or a model: what is being checked is the envelope the
// commit gets to run inside — a log a conversation can be found by, exactly one
// terminal event, and a project held for precisely as long as the work takes.
{
  const session = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"

  let unblock = () => {}
  const gate = new Promise<void>((resolve) => {
    unblock = resolve
  })
  let stoppedDuringWork: boolean | null = null

  const held = lane.hold({
    project,
    sessionId: session,
    text: "committing what is uncommitted",
    model: "helper-model",
    work: async (run) => {
      run.emit({ type: "commit.step", label: "reading what this conversation changed" })
      await gate
      stoppedDuringWork = run.stopped()
      run.emit({ type: "commit.landed", sha: "a".repeat(40), paths: ["app.ts"] })
      return { costUsd: 0.02, modelUsage: {} }
    },
  })

  check(
    "the project is held for the duration",
    lane.holderFor(project.id)?.runId === held,
    "otherwise a chat could start on top of a commit in flight",
  )

  let refusal = ""
  try {
    lane.hold({
      project,
      sessionId: session,
      text: "again",
      model: "helper-model",
      work: async () => ({ costUsd: 0, modelUsage: {} }),
    })
  } catch (err) {
    refusal = err instanceof Error ? err.message : String(err)
  }
  check(
    "a second press is refused",
    refusal.includes("already has a turn in flight"),
    refusal || "it was admitted",
  )

  const opening = log.read(held)[0]
  check(
    "run.started names the conversation",
    opening?.type === "run.started" && opening.sessionId === session,
    "nothing else on the wire carries it, so without this the log belongs to nobody",
  )

  unblock()
  await wait(200)

  const events = log.read(held)
  const terminal = events.at(-1)
  check("it was not stopped", stoppedDuringWork === false)
  check(
    "the log ends in exactly one terminal event",
    terminal?.type === "run.finished" &&
      events.filter((e) => e.type === "run.finished" || e.type === "run.error").length === 1,
    terminal?.type,
  )
  check(
    "and it reports what the drafting spent",
    terminal?.type === "run.finished" && terminal.totalCostUsd === 0.02,
    "a commit billing $0 would quietly shrink every profile that adds these up",
  )
  check(
    "the steps are in it, in order",
    events.findIndex((e) => e.type === "commit.step") <
      events.findIndex((e) => e.type === "commit.landed"),
  )
  check(
    "and the project is free again",
    lane.holderFor(project.id) === null,
    "a record nothing clears would hold the repo for the life of the daemon",
  )
}

// ---------------------------------------------------------------------------
console.log("\ncommitting with no conversation to attribute it to")
// A commit takes the working tree, so it can be pressed over work no chat made —
// an editor's, a formatter's — and then there is no session to hang the run off.
// It still needs everything else a run needs: the project's lock, a run id the
// browser can subscribe to, and a log that ends once.
{
  const held = lane.hold({
    project,
    sessionId: null,
    text: "committing what is uncommitted",
    model: "helper-model",
    work: async (run) => {
      run.emit({ type: "commit.landed", sha: "b".repeat(40), paths: ["by-hand.txt"] })
      return { costUsd: 0.01, modelUsage: {} }
    },
  })

  const opening = log.read(held)[0]
  check(
    "run.started carries no session",
    opening?.type === "run.started" && opening.sessionId === null,
    "naming whichever chat was on screen would bill this to a conversation that did not do it",
  )

  await wait(200)
  const events = log.read(held)
  check(
    "and it still ends in exactly one terminal event",
    events.at(-1)?.type === "run.finished" &&
      events.filter((e) => e.type === "run.finished" || e.type === "run.error").length === 1,
    events.at(-1)?.type,
  )
  check(
    "and the project is free again",
    lane.holderFor(project.id) === null,
    "a sessionless record has no conversation to be found and cleared through",
  )
}

// ---------------------------------------------------------------------------
console.log("\na send during a commit queues instead of refusing")
// The lock refuses rather than queueing — except behind a HELD run. A commit
// only writes history, so a turn queued behind one starts against the tree the
// human already had; refusing it made every send wait out a step that was
// automated precisely so nobody has to care it is happening. The queued record
// is admitted immediately and IS the lock, which is what keeps "one agent has
// the repo" true without a second mechanism.
{
  let unblock = () => {}
  const gate = new Promise<void>((resolve) => {
    unblock = resolve
  })
  const held = lane.hold({
    project,
    sessionId: null,
    text: "committing what is uncommitted",
    model: "helper-model",
    work: async () => {
      await gate
      return { costUsd: 0, modelUsage: {} }
    },
  })

  const queued = await say(null, "typed while the commit landed")
  check(
    "the send is admitted while the commit holds the project",
    lane.turns().some((t) => t.runId === queued),
    "refusing here is the wait the queue exists to remove",
  )
  check(
    "its message is in the log before the turn starts",
    log.read(queued)[0]?.type === "user.message",
    "the transcript should show what was asked even while it waits",
  )
  check(
    "the commit stays the visible holder while it lands",
    lane.holderFor(project.id)?.runId === held,
    "a column that re-pointed at the queued turn would move for no visible reason",
  )
  check(
    "and the queued turn has not started",
    log.read(queued).every((e) => e.type === "user.message"),
    "starting under the commit is the race the lock exists to stop",
  )

  let refusal = ""
  try {
    await say(null, "a third thing, same moment")
  } catch (err) {
    refusal = err instanceof Error ? err.message : String(err)
  }
  check(
    "a second send is refused BY the queued turn",
    refusal.includes("has the repo"),
    refusal || "it was admitted — two turns queued on one project",
  )

  unblock()
  await settled(lane)
  const terminal = log.read(queued).at(-1)
  check(
    "the queued turn ran once the commit released",
    terminal?.type === "run.finished" && terminal.status === "success",
    terminal?.type ?? "(no events)",
  )
  check(
    "and the commit's own log still ended once",
    log.read(held).filter((e) => e.type === "run.finished" || e.type === "run.error").length === 1,
  )
}

// ---------------------------------------------------------------------------
console.log("\na turn queued behind its OWN conversation's commit is what that chat reports")
// The section above commits with no session, so a conversation never has two
// records against it. The real auto-commit is ATTRIBUTED to the chat whose turn
// it follows, and typing into that chat while it lands is the ordinary thing to
// do — which leaves the lane holding two records for one session: the commit,
// registered first, and the turn queued behind it.
//
// `turnForSession` decides which one every reader describes, and a plain `find`
// over an insertion-ordered Map answers with the COMMIT. Nothing refuses and
// nothing errors; `activeRunId` simply names the commit, the browser adopts it,
// and `isCommitRun` correctly draws nothing for a commit — so the turn the human
// just sent runs its whole length with no working bar, no streaming reply and no
// chime, and the answer appears only once it is over. Invisible to every other
// assertion here, because the queue itself works perfectly.
{
  const session = "eeeeeeee-ffff-4aaa-8bbb-000000000000"
  let unblock = () => {}
  const gate = new Promise<void>((resolve) => {
    unblock = resolve
  })
  const held = lane.hold({
    project,
    // The commit hangs off this conversation's finished turn, which is what
    // `startCommit` does with every auto-commit that follows a chat turn.
    sessionId: session,
    text: "committing what is uncommitted",
    model: "helper-model",
    work: async () => {
      await gate
      return { costUsd: 0, modelUsage: {} }
    },
  })

  const queued = await say(session, "asked while its own commit was landing")
  check(
    "the send into the committing chat is admitted",
    lane.turns().some((t) => t.runId === queued),
    "a commit attributed to this chat is still only a commit — it queues, like any other",
  )
  check(
    "one conversation, two records",
    lane.turns().filter((t) => t.sessionId === session).length === 2,
    "the setup this is about — without both there is nothing to pick wrongly",
  )
  check(
    "the chat reports the TURN, not the commit it queued behind",
    lane.turnForSession(session)?.runId === queued,
    lane.turnForSession(session)?.runId === held
      ? "it named the commit — the turn runs with nothing on screen until it ends"
      : String(lane.turnForSession(session)?.runId),
  )
  check(
    "and that turn is not marked held",
    lane.turnForSession(session)?.held === false,
    "the browser reads `held` to decide whether to draw the run at all",
  )
  check(
    "while the project's visible holder is still the commit",
    lane.holderFor(project.id)?.runId === held,
    "the two questions have different answers here, which is the whole point of them being two",
  )

  unblock()
  await settled(lane)
  check(
    "the queued turn ran",
    log.read(queued).at(-1)?.type === "run.finished",
    log.read(queued).at(-1)?.type ?? "(no events)",
  )
  check(
    "and the conversation reports nothing once both are done",
    lane.turnForSession(session) === null,
    "a record left behind would show a finished chat as permanently working",
  )
}

// ---------------------------------------------------------------------------
console.log("\na refused commit asks the conversation for a fix")
// The one automatic attempt. It is an agent turn running INSIDE a commit, which
// is the shape everything here is about: the commit keeps the project's lock
// across it, and none of the turn's own bookkeeping — its `run.started`, its
// outcome, the record deletion at the end of it — may leak into the run that
// asked for it. Each of those is a way the commit destroys itself with its own
// repair: a sealed log swallows the sha, a deleted record lets a chat into the
// checkout half way through.
{
  const session = "cccccccc-dddd-4eee-8fff-000000000000"
  let fixStatus = ""
  let fixCost = -1
  let sessions = -1

  const held = lane.hold({
    project,
    sessionId: session,
    text: "committing what is uncommitted",
    model: "helper-model",
    work: async (run) => {
      run.emit({
        type: "verify.result",
        command: "pnpm typecheck",
        ok: false,
        exitCode: 1,
        durationMs: 12,
        output: "app.ts(1,1): error TS0000",
      })
      const fix = await lane.turnUnderHold({
        runId: run.runId,
        project,
        sessionId: session,
        text: "the checks did not pass. fix it",
        effort: "medium",
      })
      fixStatus = fix.status
      fixCost = fix.costUsd
      sessions = lane.liveSessions()
      run.emit({ type: "commit.landed", sha: "c".repeat(40), paths: ["app.ts"] })
      return { costUsd: 0.03 + fix.costUsd, modelUsage: {} }
    },
  })

  // Mid-fix: an agent is working and the commit is still what holds the repo.
  await wait(150)
  check(
    "the commit keeps the lock while the fix runs",
    lane.holderFor(project.id)?.runId === held,
    lane.holderFor(project.id)?.runId ?? "(free)",
  )
  check(
    "and it is one record, not two",
    lane.turns().length === 1,
    "a second record would show the project held by something nobody pressed",
  )

  await wait(TURN_MS + 400)

  const events = log.read(held)
  check("the fix reported back", fixStatus === "success", fixStatus || "(nothing)")
  check(
    "and its spend came with it",
    fixCost > 0,
    "a commit that billed itself for the message alone would under-report every profile",
  )
  check(
    "the request aide sent is in the transcript",
    events.some((e) => e.type === "user.message" && e.text.includes("did not pass")),
    "a fix appearing with no request in front of it reads as an agent acting unbidden",
  )
  check(
    "the turn's own run.started did not land in the commit's log",
    events.filter((e) => e.type === "run.started").length === 1,
    `${events.filter((e) => e.type === "run.started").length} of them`,
  )
  check(
    "and the log still ends in exactly one terminal event",
    events.at(-1)?.type === "run.finished" &&
      events.filter((e) => e.type === "run.finished" || e.type === "run.error").length === 1,
    events.at(-1)?.type,
  )
  check(
    "the commit landed AFTER the fix",
    events.findIndex((e) => e.type === "user.message") <
      events.findIndex((e) => e.type === "commit.landed"),
    "the retry has to measure the tree the fix left, not the one it was handed",
  )
  check(
    "the session the fix opened is left warm",
    sessions >= 1,
    "the next message in this chat should not pay for a cold start",
  )
  check(
    "and the project is free once the commit ends",
    lane.holderFor(project.id) === null,
    "a nested turn that took the record with it would hold the repo for good",
  )
}

// ---------------------------------------------------------------------------
console.log("\nstopping a commit before it writes")
// The stop button over a commit is real, and it is real only up to a point:
// there is a moment after which there is a commit, and stopping would mean
// undoing history rather than declining to make it.
{
  let unblock = () => {}
  const gate = new Promise<void>((resolve) => {
    unblock = resolve
  })
  let stoppedDuringWork: boolean | null = null

  const held = lane.hold({
    project,
    sessionId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
    text: "committing what is uncommitted",
    model: "helper-model",
    work: async (run) => {
      await gate
      stoppedDuringWork = run.stopped()
      return { costUsd: 0.01, modelUsage: {} }
    },
  })

  check("interrupt finds it", lane.interrupt(held), "a held run has no worker to tell")
  unblock()
  await wait(200)

  check("the work sees the stop", stoppedDuringWork === true)
  const terminal = log.read(held).at(-1)
  check(
    "and the run reads as cancelled, not as a success",
    terminal?.type === "run.finished" && terminal.status === "cancelled",
    terminal?.type === "run.finished" ? terminal.status : terminal?.type,
  )
}

console.log("\ncommitting without being asked each time")
// The seam auto-commit hangs off, and the two properties that make it safe. It
// is a hook rather than a poll, so what matters is WHEN it is called: after the
// lock is free, and never for the commit's own run.
{
  const fired: Array<string | null> = []
  const lent: Array<{ text: string; headline: string | null }> = []
  lane.onProjectIdle = (_projectId, sessionId, turn) => {
    fired.push(sessionId)
    lent.push(turn)
  }

  await say(null, "a turn that changes something")
  await settled(lane)

  check(
    "a finished chat turn announces the project is free",
    fired.length === 1,
    `${fired.length} — without this nothing downstream of a turn can act on it`,
  )
  // What the hook lends the auto-commit: the turn's own prompt, and the
  // headline of its closing summary. These become the commit's body and subject
  // with no model call — see `turnCommitMessage` — so a hook that dropped
  // either would silently put every auto-commit back on the helper model.
  check(
    "and lends the turn's prompt for the commit body",
    lent[0]?.text === "a turn that changes something",
    String(lent[0]?.text),
  )
  check(
    "and the turn's own headline for the subject",
    lent[0]?.headline?.startsWith("stub headline") === true,
    String(lent[0]?.headline),
  )
  check(
    "and the lock really is free by then",
    lane.holderFor(project.id) === null,
    "a commit started from inside the run that still holds the lock deadlocks the lane",
  )

  // The failure that would otherwise be a loop: a commit is a held run, and if
  // finishing one announced the project as idle it would start another, which
  // would start another, for as long as anything remained uncommitted.
  fired.length = 0
  lane.hold({
    project,
    sessionId: "cccccccc-dddd-4eee-8fff-000000000000",
    text: "committing what is uncommitted",
    model: "helper-model",
    work: async () => ({ costUsd: 0.01, modelUsage: {} }),
  })
  await settled(lane)
  check(
    "a commit does NOT announce it",
    fired.length === 0,
    `${fired.length} — a commit that triggered a commit is a loop with a model call in it`,
  )

  lane.onProjectIdle = null
}

console.log("\nthe pre-turn sweep")
{
  // Edits made in an editor between turns get a commit of their own before the
  // turn starts, so the turn's auto-commit contains only the turn's work — the
  // attribution the whole one-commit-per-turn design is for. The exception is a
  // RED GATE's leftover: that dirt is a failing tree the conversation was
  // handed, and committing it as "manual edits" would launder it into history
  // under the wrong name.
  // This file's `git` answers `{stdout}`, unlike smoke.ts's string-returning
  // one — hence the local wrapper.
  const gitOut = async (args: string[]) => (await git(root, args)).stdout
  const manualEdits = async () =>
    (await gitOut(["log", "--pretty=%s"]))
      .split("\n")
      .filter((s) => s.trim() === "manual edits").length
  // Relative, not absolute: every send above this section swept too — the stub
  // worker dirties the tree each turn, which is exactly the between-turns dirt
  // the sweep exists for — so the baseline is whatever the run has accumulated.
  const already = await manualEdits()

  await writeFile(join(root, "hand-edit.txt"), "typed in an editor\n", "utf8")
  const sweptRun = await say(null, "a turn after hand edits")
  await settled(lane)

  check("a hand-dirtied tree gets its own commit", (await manualEdits()) === already + 1)
  check(
    "and the hand edit is in it, not in the turn's tree",
    (await gitOut(["log", "--diff-filter=A", "--pretty=%s", "--", "hand-edit.txt"])).trim() ===
      "manual edits",
    "the file's adding commit must be the sweep's",
  )
  check(
    "with no session trailer — no conversation made these",
    !(await gitOut(["log", "-1", "--grep=manual edits", "--pretty=%B"])).includes("Aide-Session"),
  )
  check(
    "and the file list as its body",
    (await gitOut(["log", "-1", "--grep=manual edits", "--pretty=%B"])).includes("hand-edit.txt"),
  )
  check(
    "the sweep announces itself in the turn's own log",
    log
      .read(sweptRun)
      .some((e) => e.type === "commit.landed" && e.subject === "manual edits"),
    "a commit nothing on screen explains reads as history moving by itself",
  )

  // The red-gate case: the dirt is the failure the conversation was handed, and
  // the next turn INHERITS it — exactly yesterday's behaviour — rather than
  // having it committed out from under the repair.
  await lane.noteRedGate(project.id, "run-red-gate-test")
  await writeFile(join(root, "red-left.txt"), "what the failed gate left\n", "utf8")
  await say(null, "a turn over a red gate's leftovers")
  await settled(lane)
  check("a red gate's leftover is NOT swept", (await manualEdits()) === already + 1)
  check(
    "and stays in the tree for the turn to inherit",
    (await gitOut(["status", "--porcelain", "--", "red-left.txt"])).trim().startsWith("??"),
  )

  // A landed commit clears the marker — server.ts wires that around the commit
  // path — and the sweep resumes for whatever is dirty after it.
  await lane.clearRedGate(project.id)
  await say(null, "a turn after the gate cleared")
  await settled(lane)
  check("clearing the marker lets the sweep resume", (await manualEdits()) === already + 2)
  check(
    "and the leftover is finally recorded",
    (await gitOut(["status", "--porcelain", "--", "red-left.txt"])).trim() === "",
  )
}

console.log("\nthe red-gate marker survives a restart")
{
  const gitOut = async (args: string[]) => (await git(root, args)).stdout
  const manualEdits = async () =>
    (await gitOut(["log", "--pretty=%s"]))
      .split("\n")
      .filter((s) => s.trim() === "manual edits").length
  const { readRedGates } = await import("./board.js")
  const { boardPath } = await import("@aide/protocol/node")

  // The marker used to live only in the lane's memory, so a restart forgot it
  // and the first send after boot could sweep a failing tree into history as
  // "manual edits" — wrong label in the permanent record. It rides in
  // board.json now, and a fresh lane (which is what a restart makes) reads it
  // back before its first sweep decision.
  await lane.noteRedGate(project.id, "run-that-refused")
  const written = JSON.parse(await readFile(boardPath(), "utf8")) as Record<
    string,
    { redGate?: { runId?: string } }
  >
  check(
    "noting the gate writes board.json",
    written[project.id]?.redGate?.runId === "run-that-refused",
    JSON.stringify(written[project.id]?.redGate),
  )

  const before = await manualEdits()
  await writeFile(join(root, "restart-leftover.txt"), "left by the red gate\n", "utf8")
  const restarted = new ChatLane(log, { idleMs: NEVER_IDLE })
  await restarted.send({
    project,
    sessionId: null,
    text: "a turn after a restart, over a red tree",
    attachments: [],
    mode: "auto",
    effort: "medium",
    thinking: true,
  })
  await settled(restarted)
  check("a fresh lane still skips the sweep", (await manualEdits()) === before)
  check(
    "and the leftover is still the conversation's to fix",
    (await gitOut(["status", "--porcelain", "--", "restart-leftover.txt"])).trim().startsWith("??"),
  )
  restarted.shutdown()

  await lane.clearRedGate(project.id)
  const cleared = JSON.parse(await readFile(boardPath(), "utf8")) as Record<
    string,
    { redGate?: unknown }
  >
  check("clearing removes the entry from the file", cleared[project.id]?.redGate === undefined)

  // Hand-editable file, so a malformed marker must read as no marker — failing
  // toward one mislabelled sweep rather than a sweep that never runs again.
  const links = JSON.parse(await readFile(boardPath(), "utf8")) as Record<string, unknown>
  links["p-stale"] = { done: {}, redGate: "yes" }
  await writeFile(boardPath(), JSON.stringify(links), "utf8")
  check(
    "a malformed marker reads as no marker",
    !("p-stale" in (await readRedGates())),
    JSON.stringify(await readRedGates()),
  )
}

console.log("\none walk per send")
{
  const { gitSpy, refRoot } = await import("./git.js")
  const gitOut = async (args: string[]) => (await git(root, args)).stdout

  // A tree walk is the expensive half of admission — on a remote project it is
  // ssh connections — and the property that it happens exactly ONCE per send is
  // invisible to every other assertion: a second walk returns the same answer
  // and only costs time. So the spy counts. A first send used to pay the
  // sweep's `git status` AND the checkpoint's capture; the capture now answers
  // both questions.
  await gitOut(["add", "-A"])
  await gitOut(["commit", "-m", "tidy for the walk count"])

  const walks: string[] = []
  gitSpy.onCall = (cwd, args) => {
    if (refRoot(cwd) !== root) return
    const op = args.find((a) => a === "status" || a === "write-tree")
    if (op) walks.push(op)
  }
  const firstSend = await say(null, "a clean first send")
  gitSpy.onCall = null
  check(
    "a clean first send walks the tree exactly once",
    walks.filter((w) => w === "write-tree").length === 1,
    walks.join(","),
  )
  check("and never asks git status", !walks.includes("status"), walks.join(","))
  await settled(lane)

  // A follow-up has its checkpoint already, so there is no capture to fold
  // into: it keeps the one `git status` it always paid, and walks nothing.
  const started = log.read(firstSend).find((e) => e.type === "run.started")
  const followSession = started?.type === "run.started" ? started.sessionId : null
  check("the first send became a conversation", followSession !== null)
  // Tidy only if the turn actually dirtied anything — a stub worker that
  // rewrote byte-identical content leaves the tree clean, and committing
  // nothing is an error, not a no-op.
  if ((await gitOut(["status", "--porcelain"])).trim()) {
    await gitOut(["add", "-A"])
    await gitOut(["commit", "-m", "tidy again for the follow-up count"])
  }

  walks.length = 0
  gitSpy.onCall = (cwd, args) => {
    if (refRoot(cwd) !== root) return
    const op = args.find((a) => a === "status" || a === "write-tree")
    if (op) walks.push(op)
  }
  await say(followSession, "a clean follow-up")
  gitSpy.onCall = null
  check(
    "a clean follow-up asks one status and captures nothing",
    walks.filter((w) => w === "status").length === 1 && !walks.includes("write-tree"),
    walks.join(","),
  )
  await settled(lane)
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
