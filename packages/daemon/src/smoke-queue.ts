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
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { promisify } from "node:util"
import type { ChatState, ChatStatus, Project, RunEvent, RunEventBody } from "@aide/protocol"
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
const lane = new ChatLane(log, { idleMs: 5_000 })
const say = (sessionId: string | null, text: string) =>
  lane.send({
    project,
    sessionId,
    text,
    attachments: [],
    mode: "manual",
    effort: "medium",
    rowId: null,
  })

const turnsOf = (runId: string): number => {
  const terminal = log.read(runId).at(-1)
  return terminal?.type === "run.finished" ? terminal.numTurns : 0
}

const c1 = await say(null, "first message")
await wait(TURN_MS)
const started = log.read(c1).find((e) => e.type === "run.started")
const chatSession = started?.type === "run.started" ? started.sessionId : null
check("a new chat learns its session id", Boolean(chatSession), String(chatSession))
check("the turn is no longer in flight", lane.turns().length === 0)
check("the session is held open", lane.liveSessions() === 1, `${lane.liveSessions()}`)

const c2 = await say(chatSession, "follow-up")
await wait(TURN_MS)
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
await wait(TURN_MS)
check("the third turn also reused it", turnsOf(c3) === 3, `numTurns ${turnsOf(c3)}`)

const c4 = await say(chatSession, "stop me")
await wait(100)
check("interrupt resolves for a live turn", lane.interrupt(c4))
await wait(TURN_MS)
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
await wait(TURN_MS)
check("a different conversation gets its own session", lane.liveSessions() === 2)
check("and starts its own turn count", turnsOf(other) === 1, `numTurns ${turnsOf(other)}`)

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
  mode: "manual",
  effort: "medium",
  rowId: null,
})
await wait(TURN_MS)
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
  const { addTodo } = await import("./todos.js")
  const { rowForSession } = await import("./board.js")
  const { readCheckpoint } = await import("./checkpoint.js")

  // `addProject` scaffolds this in production; a bare temp repo has no `.aide/`.
  await mkdir(join(root, STATE_DIR), { recursive: true })

  const locked = new ChatLane(log, { idleMs: 5_000 })
  const row = await addTodo(project, "make the widget wobble")
  check("the row is numbered", /^\d{4}$/.test(row.id), row.id)

  const firstRun = await locked.send({
    project,
    sessionId: null,
    text: "off you go",
    attachments: [],
    mode: "manual",
    effort: "medium",
    rowId: row.id,
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
      mode: "manual",
      effort: "medium",
      rowId: null,
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
      mode: "manual",
      effort: "medium",
      rowId: null,
    }),
    locked.send({
      project,
      sessionId: null,
      text: "second of two",
      attachments: [],
      mode: "manual",
      effort: "medium",
      rowId: null,
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
  const linked = await rowForSession(project.id, smokeSession)
  check(
    "the daemon linked the row to the session itself",
    linked === row.id,
    `${linked} — the browser is not in this path`,
  )

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
    mode: "manual",
    effort: "medium",
    rowId: row.id,
  })
  await wait(TURN_MS)
  check(
    "a follow-up does not re-checkpoint",
    !log.read(secondRun).some((e) => e.type === "checkpoint.taken"),
    "the baseline is the conversation, not the turn",
  )
  check(
    "and the original baseline still stands",
    (await readCheckpoint(root, smokeSession))?.sha === adopted?.sha,
  )

  locked.shutdown()
}

// ---------------------------------------------------------------------------
console.log("\nverdicts")
// The gate the whole design rests on. What a verdict does is rewrite the
// BACKLOG — there is no status field on a row — so these assertions are about
// the shape of todos.md, not about a stored state.
{
  const { addTodo, listTodos } = await import("./todos.js")
  const { closeChat, reopenChat, chatStatuses, linkSession, rowForSession } = await import(
    "./board.js"
  )

  const mk = async (text: string, session: string) => {
    const row = await addTodo(project, text)
    await linkSession(project.id, row.id, session)
    return row
  }
  const ids = async () => (await listTodos(project)).map((t) => t.id)
  const none = () => null

  const doneRow = await mk("ship the thing", "sess-done")
  const droppedRow = await mk("never mind this one", "sess-dropped")

  await closeChat(project, "sess-done", "done")
  check(
    "done removes the row",
    !(await ids()).includes(doneRow.id),
    "the verdict IS the shape of the file",
  )
  check("and unlinks the session", (await rowForSession(project.id, "sess-done")) === null)

  await closeChat(project, "sess-dropped", "dropped")
  check("dropped removes the row too", !(await ids()).includes(droppedRow.id))

  // Work that did not land has no button of its own. The row stays because
  // nobody closed it, which is the same state it was in before — and that is the
  // whole argument for deleting the `failed` verdict.
  const openRow = await mk("did not work first time", "sess-open")
  check("an unresolved conversation leaves its row alone", (await ids()).includes(openRow.id))
  check(
    "and keeps the row linked to it",
    (await rowForSession(project.id, "sess-open")) === openRow.id,
    "so the board still shows who is on it",
  )

  const closed = await chatStatuses(
    project,
    [
      { sessionId: "sess-done", lastModified: Date.now() },
      { sessionId: "sess-open", lastModified: Date.now() },
      { sessionId: "sess-untracked", lastModified: Date.now() },
    ],
    none,
  )
  check("a closed conversation reports its verdict", closed["sess-done"]?.verdict === "done")
  check("and reads as closed", closed["sess-done"]?.state === "closed")
  check(
    "unresolved work is not closed",
    closed["sess-open"]?.state === "needs-you" && closed["sess-open"]?.verdict === null,
    "no button was pressed, so there is nothing to report but the row",
  )
  check(
    "an ordinary chat has no lifecycle at all",
    closed["sess-untracked"]?.state === null,
    "a question you asked last week is not `needs you` forever",
  )

  // A board.json written by an older aide still holds `failed` verdicts. Under
  // the two-verdict vocabulary that work is simply not closed, so the stored
  // value has to read as "no verdict" rather than as a closed state whose label
  // no longer exists — and the only way out of which would be `reopen`.
  {
    const { readFile, writeFile } = await import("node:fs/promises")
    const { boardPath } = await import("@aide/protocol/node")
    const raw = JSON.parse(await readFile(boardPath(), "utf8")) as Record<
      string,
      { rows: Record<string, string>; verdicts: Record<string, unknown> }
    >
    const board = raw[project.id]
    if (board) {
      board.verdicts["sess-legacy"] = { verdict: "failed", at: Date.now() }
      await writeFile(boardPath(), JSON.stringify(raw), "utf8")
    }
    const legacy = await chatStatuses(
      project,
      [{ sessionId: "sess-legacy", lastModified: Date.now() }],
      none,
    )
    check(
      "a stored `failed` verdict reads as unfinished, not as a closed state",
      legacy["sess-legacy"]?.state === null && legacy["sess-legacy"]?.verdict === null,
    )
  }

  await reopenChat(project, "sess-done")
  const reopened = await chatStatuses(
    project,
    [{ sessionId: "sess-done", lastModified: Date.now() }],
    none,
  )
  check("reopening clears the verdict", reopened["sess-done"]?.state === null)

  // Staleness is a flag on open work, never on finished work.
  const old = await mk("been sitting a while", "sess-old")
  const stale = await chatStatuses(
    project,
    [{ sessionId: "sess-old", lastModified: Date.now() - 40 * 24 * 60 * 60_000 }],
    none,
  )
  check("untouched open work is flagged stale", stale["sess-old"]?.stale === true)
  check("and is still `needs you`, not a state of its own", stale["sess-old"]?.state === "needs-you")
  await closeChat(project, "sess-old", "dropped")
  const notStale = await chatStatuses(
    project,
    [{ sessionId: "sess-old", lastModified: Date.now() - 40 * 24 * 60 * 60_000 }],
    none,
  )
  check(
    "a finished conversation is not going stale",
    notStale["sess-old"]?.stale === false,
    `row ${old.id} is closed, so there is nothing to chase`,
  )
}

// ---------------------------------------------------------------------------
console.log("\nchat list order")
{
  const { sortChats } = await import("@aide/protocol")
  const at = (n: number) => ({ lastModified: n })
  const st = (state: ChatState | null, extra: Partial<ChatStatus> = {}): ChatStatus => ({
    rowId: state ? "0001" : null,
    state,
    blocked: false,
    stale: false,
    verdict: null,
    ...extra,
  })
  const sorted = sortChats([
    { id: "closed", ...at(500), status: st("closed", { verdict: "done" }) },
    { id: "ordinary", ...at(400), status: st(null) },
    { id: "working", ...at(300), status: st("working") },
    { id: "needs", ...at(200), status: st("needs-you") },
    { id: "blocked", ...at(100), status: st("working", { blocked: true }) },
  ])
  check("blocked first, even though it is the oldest", sorted[0]?.id === "blocked")
  check("then needs-you", sorted[1]?.id === "needs")
  check("then working", sorted[2]?.id === "working")
  check("then ordinary conversations", sorted[3]?.id === "ordinary")
  check(
    "finished is pushed to the bottom, newest though it is",
    sorted[4]?.id === "closed",
    "all finished pushed down",
  )
}


// ---------------------------------------------------------------------------
console.log("\nclosing a conversation keeps its undo")
// There is no checkout to reclaim any more. What a verdict has to do instead is
// leave the way back intact and SAY so — "done" is the point at which someone
// decides the work was good, and deciding it was not wants a command rather than
// a shrug.
{
  const { addTodo } = await import("./todos.js")
  const { closeChat, linkSession } = await import("./board.js")
  const { takeCheckpoint, readCheckpoint } = await import("./checkpoint.js")

  const session = "99999999-8888-7777-6666-555555555555"
  const row = await addTodo(project, "tidy up after itself")
  await linkSession(project.id, row.id, session)
  const cp = await takeCheckpoint(root, session)

  const closed = await closeChat(project, session, "dropped")
  check("the verdict lands", closed.rowRemoved, "the row is gone from the backlog")
  check(
    "and it says where the undo is",
    (closed.warning ?? "").includes(cp.ref),
    closed.warning ?? "(silent)",
  )
  check(
    "the checkpoint is NOT deleted with the row",
    (await readCheckpoint(root, session))?.sha === cp.sha,
    "closing must not make itself the irreversible step",
  )

  // An id that reached a COMMIT must never be handed out again: the history view
  // reads `Aide-Row` back to label commits, so reusing this number would
  // attribute one row's work to another. An id that left no trace behind is free
  // to be reused, because there is nothing for it to collide with — which is why
  // the floor comes from git rather than from a high-water mark in a file.
  await writeFile(join(root, "landed.txt"), "work\n", "utf8")
  await git(root, ["add", "landed.txt"])
  await git(root, ["commit", "-m", `Do the thing\n\nAide-Row: ${row.id}\nAide-Session: ${session}`])

  const next = await addTodo(project, "canary")
  check(
    "an id that reached a commit is never handed out again",
    Number(next.id) > Number(row.id),
    `${next.id} follows ${row.id}, read back from the Aide-Row trailer`,
  )
}

// ---------------------------------------------------------------------------
console.log("\nthe receipt")
// Arithmetic over an event log, which is the kind of thing that goes wrong
// silently: nobody notices that a receipt bills four minutes of waiting for a
// human to the model's thinking, or reports six minutes of tool work inside a
// four-minute turn. The synthetic run below is built to have exactly those two
// traps in it.
{
  const { summarizeRun, conversationReceipt } = await import("./receipt.js")

  let seq = 0
  const at = (ts: number, body: RunEventBody): RunEvent =>
    ({ ...body, runId: "synthetic", seq: (seq += 1), ts }) as RunEvent

  const events: RunEvent[] = [
    at(0, { type: "user.message", text: "do the thing" }),
    at(100, {
      type: "run.started",
      taskId: "",
      projectId: project.id,
      model: "m",
      cwd: root,
      sessionId: "synthetic",
    }),
    at(200, { type: "assistant.start" }),
    // Two calls in ONE assistant message, so they share both stamps.
    at(1200, { type: "tool.start", toolUseId: "a", name: "Bash", input: { command: "one" }, parentToolUseId: null }),
    at(1200, { type: "tool.start", toolUseId: "b", name: "Bash", input: { command: "two" }, parentToolUseId: null }),
    at(4200, { type: "tool.end", toolUseId: "a", ok: true, summary: "" }),
    at(4200, { type: "tool.end", toolUseId: "b", ok: false, summary: "boom" }),
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
      permissionDenials: [],
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
  check("the failed call is the one that failed", s.calls.filter((c) => c.ok === false).length === 1)
  check("and it kept what the tool said", s.calls[1]?.summary === "boom", s.calls[1]?.summary ?? "")

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
  const receipt = await conversationReceipt(log, project, chatSession ?? "")
  check(
    "every turn of the conversation is found",
    receipt.runs === 4,
    `${receipt.runs} — matched by run.started, since nothing indexes session to run`,
  )
  check(
    "the prompts are in it verbatim",
    receipt.markdown.includes("> stop me"),
    "the prompts are the thing the receipt exists to be asked about",
  )
  check(
    "the interrupted turn is reported as cancelled",
    receipt.markdown.includes("**cancelled**"),
    "a turn that was stopped must not read as one that succeeded",
  )
  check(
    "the cost is labelled an estimate",
    receipt.markdown.includes("estimate"),
    "the brief: anything that displays a cost figure has to say what it is",
  )

  const empty = await conversationReceipt(log, project, "11111111-2222-4333-8444-555555555555")
  check(
    "a conversation aide never ran gets an answer, not an error",
    empty.runs === 0 && empty.markdown.includes("no run log"),
    "a chat held in the CLI is readable here and has no event log",
  )
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
