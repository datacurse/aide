import fastifyWebsocket from "@fastify/websocket"
import Fastify, { type FastifyReply } from "fastify"
import type {
  Attachment,
  ChatMode,
  ClientMessage,
  EffortLevel,
  RunEvent,
  ServerMessage,
} from "@aide/protocol"
import { CHAT_MODES, EFFORT_LEVELS } from "@aide/protocol"
import { worktreePath } from "@aide/protocol/node"
import { ChatLane } from "./chat.js"
import { CONFIG } from "./config.js"
import { EventLog } from "./eventlog.js"
import { draftCommitMessage } from "./helper.js"
import { writeJournalEntry } from "./journal.js"
import { reconcileStrandedTasks } from "./reconcile.js"
import { addProject, getProject, listProjects, removeProject } from "./registry.js"
import { getConversation, listConversations } from "./sessions.js"
import { Supervisor } from "./supervisor.js"
import { createTask, deleteTask, getTask, listTasks, patchTask, setStatus } from "./tasks.js"
import {
  commitWorktree,
  currentBranch,
  mergeTaskBranch,
  recentSubjects,
  removeWorktree,
  withTrailers,
  worktreeDiff,
  worktreeDiffStat,
  worktreeStatus,
} from "./worktree.js"

const log = new EventLog()
const supervisor = new Supervisor(log)
const chat = new ChatLane(log)

const app = Fastify({ logger: { level: process.env["AIDE_LOG_LEVEL"] ?? "warn" } })
await app.register(fastifyWebsocket)

// ---------------------------------------------------------------------------
// Local-origin guard
//
// Binding 127.0.0.1 is not a security boundary, and treating it as one is the
// mistake this closes.
//
// Any page you have open can already issue requests to http://127.0.0.1:4317.
// The only thing stopping it from READING the answers is that this server sends
// no CORS headers — and DNS rebinding removes even that: point a hostname you
// control at 127.0.0.1, and the browser considers the response same-origin by
// its own rules. Every route here becomes readable by a background tab.
//
// That was survivable while the API served project names. It is not: the diff
// routes already return source code, and the file routes will return any file
// in any repo you have added.
//
// Rebinding can forge the DNS name but not the Host header, so an allowlist of
// literal loopback authorities closes the whole class. The Vite proxy sets
// changeOrigin, so it arrives here as 127.0.0.1:<port> and passes, but it
// forwards the browser's Origin untouched — which is why the dev server's own
// origin has to be listed separately.
// ---------------------------------------------------------------------------

const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"]

const ALLOWED_HOSTS = new Set(LOOPBACK.map((h) => `${h}:${CONFIG.port}`))

const ALLOWED_ORIGINS = new Set([
  ...LOOPBACK.map((h) => `http://${h}:${CONFIG.port}`),
  ...LOOPBACK.map((h) => `http://${h}:${CONFIG.webPort}`),
  ...CONFIG.extraOrigins,
])

/** Shared by the HTTP hook and the WebSocket upgrade, which must both enforce it. */
function localOriginRefusal(headers: {
  host?: string
  origin?: string
}): string | null {
  const host = headers.host ?? ""
  if (!ALLOWED_HOSTS.has(host.toLowerCase())) {
    return `refused: Host ${host || "(absent)"} is not a loopback address for this daemon`
  }
  // Absent Origin is normal for curl and for same-origin navigations; a present
  // one that we do not recognise is a cross-site caller.
  const origin = headers.origin
  if (origin !== undefined && !ALLOWED_ORIGINS.has(origin.toLowerCase())) {
    return `refused: origin ${origin} may not call this daemon`
  }
  return null
}

app.addHook("onRequest", async (req, reply) => {
  const refusal = localOriginRefusal(req.headers)
  if (refusal) return reply.code(403).send({ message: refusal })
})

const notFound = (msg: string) => ({ statusCode: 404, error: "Not Found", message: msg })

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

app.get("/api/health", async () => ({
  ok: true,
  taskModel: CONFIG.taskModel,
  maxConcurrentRuns: CONFIG.maxConcurrentRuns,
  maxBudgetUsd: CONFIG.maxBudgetUsd,
}))

app.get("/api/projects", async () => {
  const projects = await listProjects()
  const runs = supervisor.runs()
  return projects.map((p) => ({
    ...p,
    activeRuns: runs.filter((r) => r.projectId === p.id && r.phase === "running").length,
    queuedRuns: runs.filter((r) => r.projectId === p.id && r.phase === "queued").length,
  }))
})

app.post("/api/projects", async (req, reply) => {
  const { path } = (req.body ?? {}) as { path?: string }
  if (!path) return reply.code(400).send({ message: "body must include { path }" })
  try {
    return await addProject(path)
  } catch (err) {
    return reply.code(400).send({ message: err instanceof Error ? err.message : String(err) })
  }
})

app.delete("/api/projects/:id", async (req, reply) => {
  const { id } = req.params as { id: string }
  await removeProject(id)
  return reply.code(204).send()
})

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

app.get("/api/projects/:id/tasks", async (req, reply) => {
  const { id } = req.params as { id: string }
  const project = await getProject(id)
  if (!project) return reply.code(404).send(notFound(`no project ${id}`))

  const runs = supervisor.runs()
  const tasks = await listTasks(project)
  return tasks.map((t) => {
    // Queued runs count as in-flight now. A task waiting behind the cap is not
    // idle, and pretending otherwise is what let a second run start against the
    // same worktree.
    const run = runs.find((r) => r.taskId === t.id)
    return {
      ...t,
      activeRunId: run?.runId ?? null,
      activeRun: run ? { runId: run.runId, phase: run.phase, position: run.position } : null,
    }
  })
})

app.post("/api/projects/:id/tasks", async (req, reply) => {
  const { id } = req.params as { id: string }
  const { title, body } = (req.body ?? {}) as { title?: string; body?: string }
  if (!title?.trim()) return reply.code(400).send({ message: "body must include { title }" })

  const project = await getProject(id)
  if (!project) return reply.code(404).send(notFound(`no project ${id}`))
  // `(body ?? title)` looked like a fallback and never was one: the compose form
  // sends `draft.body.trim()`, so a blank textarea arrives as "", and `"" ?? x`
  // is "" — nullish coalescing does not catch an empty string. The task was
  // created with an empty prompt and the agent handed an empty user message.
  // Store the empty body honestly; the title is composed into the user turn.
  return createTask(project, title.trim(), (body ?? "").trim())
})

app.delete("/api/projects/:id/tasks/:taskId", async (req, reply) => {
  const { id, taskId } = req.params as { id: string; taskId: string }
  const project = await getProject(id)
  if (!project) return reply.code(404).send(notFound(`no project ${id}`))
  // Cancel before unlinking. A queued run holds its own snapshot of the task, so
  // deleting the file underneath it meant the run woke up later, called
  // setStatus on a file that no longer existed, and threw out of a floating
  // promise as an unhandled rejection nobody would ever see.
  await supervisor.cancelForTask(taskId)
  await deleteTask(project, taskId)
  return reply.code(204).send()
})

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

app.post("/api/projects/:id/tasks/:taskId/run", async (req, reply) => {
  const { id, taskId } = req.params as { id: string; taskId: string }
  const project = await getProject(id)
  if (!project) return reply.code(404).send(notFound(`no project ${id}`))

  const task = await getTask(project, taskId)
  if (!task) return reply.code(404).send(notFound(`no task ${taskId}`))
  if (supervisor.runIdForTask(taskId)) {
    return reply.code(409).send({ message: "task already has a run in flight" })
  }

  const runId = supervisor.enqueue(project, task)
  return { runId }
})

app.post("/api/runs/:runId/interrupt", async (req, reply) => {
  const { runId } = req.params as { runId: string }
  const ok = await supervisor.interrupt(runId)
  if (!ok) return reply.code(404).send(notFound(`run ${runId} is not active`))
  return { interrupted: true }
})

app.get("/api/runs/:runId/events", async (req) => {
  const { runId } = req.params as { runId: string }
  const { fromSeq } = req.query as { fromSeq?: string }
  return log.read(runId, Number(fromSeq ?? 0) || 0)
})

app.get("/api/projects/:id/tasks/:taskId/diff", async (req, reply) => {
  const { id, taskId } = req.params as { id: string; taskId: string }
  const project = await getProject(id)
  if (!project) return reply.code(404).send(notFound(`no project ${id}`))

  const path = worktreePath(project.root, taskId)
  // Sequential, not Promise.all: worktreeDiff runs `add -A -N` first, and a
  // concurrent status read races it and reports new files as untracked.
  const diff = await worktreeDiff(path)
  const status = await worktreeStatus(path)
  return { worktree: path, diff, status }
})

// ---------------------------------------------------------------------------
// Accepting the work
//
// Two gates, deliberately. `commit` puts the diff on the task branch, which
// changes nothing anyone else can see; `land` merges it, which does. Anything
// that mutates the repo refuses while a run for that task is still in flight —
// committing underneath a working agent races its next write.
// ---------------------------------------------------------------------------

const idle = async (taskId: string, reply: FastifyReply): Promise<boolean> => {
  if (!supervisor.runIdForTask(taskId)) return true
  await reply.code(409).send({ message: "a run is still in flight for this task" })
  return false
}

/**
 * Draft a commit message. Separate from committing because it costs money and
 * takes a few seconds, and because the whole point is that a human reads it
 * before it becomes a commit.
 */
app.post("/api/projects/:id/tasks/:taskId/commit/draft", async (req, reply) => {
  const { id, taskId } = req.params as { id: string; taskId: string }
  const project = await getProject(id)
  if (!project) return reply.code(404).send(notFound(`no project ${id}`))
  const task = await getTask(project, taskId)
  if (!task) return reply.code(404).send(notFound(`no task ${taskId}`))
  if (!(await idle(taskId, reply))) return

  const path = worktreePath(project.root, taskId)
  // Sequential for the same reason as the diff route: worktreeDiffStat runs
  // `add -A -N`, and a concurrent read races it.
  const diffStat = await worktreeDiffStat(path)
  const diff = await worktreeDiff(path)
  if (!diff.trim()) {
    return reply.code(409).send({ message: "nothing to commit — the worktree is unchanged" })
  }

  try {
    const message = await draftCommitMessage({
      model: CONFIG.helperModel,
      title: task.title,
      prompt: task.prompt,
      diffStat,
      diff,
      recentSubjects: await recentSubjects(project.root),
    })
    return { message, model: CONFIG.helperModel }
  } catch (err) {
    return reply.code(502).send({
      message: `could not draft a commit message: ${err instanceof Error ? err.message : String(err)}`,
    })
  }
})

/** Commit the worktree with the message the human approved, and journal it. */
app.post("/api/projects/:id/tasks/:taskId/commit", async (req, reply) => {
  const { id, taskId } = req.params as { id: string; taskId: string }
  const { message } = (req.body ?? {}) as { message?: string }
  if (!message?.trim()) return reply.code(400).send({ message: "body must include { message }" })

  const project = await getProject(id)
  if (!project) return reply.code(404).send(notFound(`no project ${id}`))
  const task = await getTask(project, taskId)
  if (!task) return reply.code(404).send(notFound(`no task ${taskId}`))
  if (!(await idle(taskId, reply))) return

  const path = worktreePath(project.root, taskId)
  // Captured before committing: `git diff` against a clean worktree is empty,
  // so after the commit there is no file list left to journal.
  const diffStat = await worktreeDiffStat(path)
  const runId = task.runs.at(-1) ?? null
  const final = withTrailers(message, task.id, runId)

  let sha: string
  try {
    sha = await commitWorktree(path, final)
  } catch (err) {
    return reply.code(409).send({ message: err instanceof Error ? err.message : String(err) })
  }

  // The commit is the durable part and it already succeeded. A journal write
  // that fails must not read as a failed commit, so it is reported alongside
  // rather than thrown.
  let journal: string | null = null
  let warning: string | null = null
  try {
    journal = await writeJournalEntry({
      project,
      task,
      events: runId ? log.read(runId) : [],
      runId: runId ?? "",
      sha,
      message: final,
      diffStat,
    })
  } catch (err) {
    warning = `committed, but the journal entry failed: ${err instanceof Error ? err.message : String(err)}`
  }

  await patchTask(project, taskId, { status: "committed", addCommit: sha })
  return { sha, journal, warning }
})

/** Merge the task branch into whatever the project has checked out. */
app.post("/api/projects/:id/tasks/:taskId/land", async (req, reply) => {
  const { id, taskId } = req.params as { id: string; taskId: string }
  const project = await getProject(id)
  if (!project) return reply.code(404).send(notFound(`no project ${id}`))
  const task = await getTask(project, taskId)
  if (!task) return reply.code(404).send(notFound(`no task ${taskId}`))
  if (!(await idle(taskId, reply))) return
  if (task.commits.length === 0) {
    return reply.code(409).send({ message: "nothing to land — this task has no commits yet" })
  }

  let merged: { sha: string; into: string }
  try {
    merged = await mergeTaskBranch(project.root, taskId, `Merge task ${task.id}: ${task.title}`)
  } catch (err) {
    return reply.code(409).send({ message: err instanceof Error ? err.message : String(err) })
  }

  // The merge is done and recorded. A worktree that will not go away is untidy,
  // not a failed land, so it is reported and the task still closes.
  let warning: string | null = null
  try {
    await removeWorktree(project.root, taskId)
  } catch (err) {
    warning = `merged, but the worktree is still there: ${err instanceof Error ? err.message : String(err)}`
  }

  await setStatus(project, taskId, "done")
  return { ...merged, warning }
})

/** Where a land would put the work. Shown on the button so it is never a guess. */
app.get("/api/projects/:id/branch", async (req, reply) => {
  const { id } = req.params as { id: string }
  const project = await getProject(id)
  if (!project) return reply.code(404).send(notFound(`no project ${id}`))
  try {
    return { branch: await currentBranch(project.root) }
  } catch {
    return { branch: null }
  }
})

// ---------------------------------------------------------------------------
// Conversations
//
// Read straight out of the SDK's own session store, not out of anything aide
// keeps. That is what makes a chat you had in the VS Code extension show up here
// with no import step — and it is why a project's task runs appear alongside its
// chats: both are sessions, told apart by the directory they ran in.
// ---------------------------------------------------------------------------

app.get("/api/projects/:id/conversations", async (req, reply) => {
  const { id } = req.params as { id: string }
  const project = await getProject(id)
  if (!project) return reply.code(404).send(notFound(`no project ${id}`))
  try {
    return await listConversations(project)
  } catch (err) {
    return reply.code(502).send({
      message: `could not read the session store: ${err instanceof Error ? err.message : String(err)}`,
    })
  }
})

app.get("/api/projects/:id/conversations/:sessionId", async (req, reply) => {
  const { id, sessionId } = req.params as { id: string; sessionId: string }
  const project = await getProject(id)
  if (!project) return reply.code(404).send(notFound(`no project ${id}`))
  try {
    const found = await getConversation(project, sessionId)
    if (!found) return reply.code(404).send(notFound(`no conversation ${sessionId} in this project`))
    return found
  } catch (err) {
    return reply.code(502).send({
      message: `could not read that conversation: ${err instanceof Error ? err.message : String(err)}`,
    })
  }
})

/**
 * Send a message. `sessionId` may be null, which starts a new conversation.
 *
 * Returns as soon as the turn is admitted, with a runId to subscribe to — the
 * answer arrives on the event stream, not in this response.
 */
app.post("/api/projects/:id/chat", async (req, reply) => {
  const { id } = req.params as { id: string }
  const body = (req.body ?? {}) as {
    sessionId?: string | null
    text?: string
    attachments?: Attachment[]
    mode?: string
    effort?: string
  }
  if (!body.text?.trim() && !body.attachments?.length) {
    return reply.code(400).send({ message: "nothing to send" })
  }

  const project = await getProject(id)
  if (!project) return reply.code(404).send(notFound(`no project ${id}`))

  // Validated rather than cast: these come from a form, and an unknown mode
  // would otherwise reach the SDK as an undefined permission mode.
  const mode = (CHAT_MODES as readonly string[]).includes(body.mode ?? "")
    ? (body.mode as ChatMode)
    : "manual"
  const effort = (EFFORT_LEVELS as readonly string[]).includes(body.effort ?? "")
    ? (body.effort as EffortLevel)
    : "high"

  try {
    const runId = await chat.send({
      project,
      sessionId: body.sessionId ?? null,
      text: body.text?.trim() ?? "",
      attachments: body.attachments ?? [],
      mode,
      effort,
    })
    return { runId }
  } catch (err) {
    return reply.code(409).send({ message: err instanceof Error ? err.message : String(err) })
  }
})

/** Answer a tool call the turn is blocked on. */
app.post("/api/runs/:runId/permissions/:requestId", async (req, reply) => {
  const { runId, requestId } = req.params as { runId: string; requestId: string }
  const { allowed } = (req.body ?? {}) as { allowed?: boolean }
  if (typeof allowed !== "boolean") {
    return reply.code(400).send({ message: "body must include { allowed: boolean }" })
  }
  if (!chat.resolvePermission(runId, requestId, allowed)) {
    return reply.code(404).send(notFound("that request is no longer waiting"))
  }
  return { ok: true }
})

app.post("/api/runs/:runId/chat-interrupt", async (req, reply) => {
  const { runId } = req.params as { runId: string }
  if (!chat.interrupt(runId)) return reply.code(404).send(notFound(`run ${runId} is not active`))
  return { interrupted: true }
})

// ---------------------------------------------------------------------------
// Live stream
// ---------------------------------------------------------------------------

app.get("/ws", { websocket: true }, (socket, req) => {
  // Second gate, kept deliberately. The onRequest hook was measured to fire on
  // the upgrade request and reject it with a 403 before the socket opens, so
  // this is redundant today — but WebSockets are not subject to the same-origin
  // policy at all, meaning any page can open ws://127.0.0.1:4317/ws and it will
  // connect. That makes this the one route where a future change to hook
  // ordering, or to @fastify/websocket's lifecycle, would silently reopen the
  // hole rather than break something visible. Two gates, one cheap.
  const refusal = localOriginRefusal(req.headers)
  if (refusal) {
    socket.close(1008, "forbidden")
    return
  }

  const subs = new Map<string, () => void>()

  const send = (msg: ServerMessage) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg))
  }

  socket.on("message", (raw: Buffer) => {
    let msg: ClientMessage
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage
    } catch {
      return send({ type: "error", message: "malformed message" })
    }

    if (msg.type === "unsubscribe") {
      subs.get(msg.runId)?.()
      subs.delete(msg.runId)
      return
    }

    if (msg.type === "subscribe") {
      subs.get(msg.runId)?.()

      // The replay callbacks fire synchronously inside log.subscribe, so anything
      // collected before it returns is backlog and everything after is live. That
      // lets a reconnect arrive as one frame instead of several hundred.
      const backlog: RunEvent[] = []
      let live = false

      const unsub = log.subscribe(msg.runId, msg.fromSeq, (event) => {
        if (live) send({ type: "events", runId: msg.runId, events: [event] })
        else backlog.push(event)
      })
      live = true

      if (backlog.length) send({ type: "events", runId: msg.runId, events: backlog })
      send({ type: "caught-up", runId: msg.runId, seq: backlog.at(-1)?.seq ?? msg.fromSeq })

      // Deltas ride the same socket but come from the chat lane rather than the
      // log, because they are never stored. A run that is not a live chat turn
      // simply has no watchers and this costs nothing.
      const unwatch = chat.watchDeltas(msg.runId, (delta) => {
        send({ type: "delta", runId: msg.runId, delta })
      })

      subs.set(msg.runId, () => {
        unsub()
        unwatch()
      })
    }
  })

  socket.on("close", () => {
    for (const unsub of subs.values()) unsub()
    subs.clear()
  })
})

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Stop cleanly and say so before dying.
 *
 * Answering first matters: a socket that simply closes is indistinguishable
 * from a crash, and the dev server's stop button would have no way to tell
 * "shut down as asked" from "fell over while I was asking".
 */
app.post("/api/shutdown", async (_req, reply) => {
  await reply.code(202).send({ message: "shutting down" })
  await stopEverything("requested over HTTP")
})

let stopping = false
async function stopEverything(why: string): Promise<void> {
  if (stopping) return
  stopping = true
  console.log(`aide daemon stopping (${why})`)
  chat.shutdown()
  await supervisor.shutdown()
  await app.close().catch(() => {})
  process.exit(0)
}

// Ctrl-C on `pnpm daemon`, and any orderly kill. Note what these CANNOT catch:
// Windows `taskkill /F` is TerminateProcess and delivers no signal at all, which
// is why boot reconciliation below is not optional.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void stopEverything(signal))
}

// Before listen, deliberately. The health endpoint answering has to mean the
// task list is honest — otherwise a browser that connects in the gap sees a task
// filed `running` with nothing behind it, and is offered the commit button on a
// worktree whose agent died mid-write.
const recovered = await reconcileStrandedTasks(log)

const address = await app.listen({ port: CONFIG.port, host: "127.0.0.1" })
console.log(`aide daemon on ${address}`)
console.log(`  task model   ${CONFIG.taskModel}`)
console.log(`  concurrency  ${CONFIG.maxConcurrentRuns}`)
console.log(`  budget/run   $${CONFIG.maxBudgetUsd}`)
for (const r of recovered) {
  console.log(`  recovered    ${r.projectName} ${r.taskId} ${r.from} → ${r.to} (${r.title})`)
}