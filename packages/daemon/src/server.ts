import fastifyWebsocket from "@fastify/websocket"
import Fastify, { type FastifyReply } from "fastify"
import type { ClientMessage, RunEvent, ServerMessage } from "@aide/protocol"
import { worktreePath } from "@aide/protocol"
import { CONFIG } from "./config.js"
import { EventLog } from "./eventlog.js"
import { draftCommitMessage } from "./helper.js"
import { writeJournalEntry } from "./journal.js"
import { addProject, getProject, listProjects, removeProject } from "./registry.js"
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

const app = Fastify({ logger: { level: process.env["AIDE_LOG_LEVEL"] ?? "warn" } })
await app.register(fastifyWebsocket)

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
  const active = supervisor.activeRuns()
  return projects.map((p) => ({
    ...p,
    activeRuns: active.filter((r) => r.projectId === p.id).length,
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

  const active = supervisor.activeRuns()
  const tasks = await listTasks(project)
  return tasks.map((t) => ({
    ...t,
    activeRunId: active.find((r) => r.taskId === t.id)?.runId ?? null,
  }))
})

app.post("/api/projects/:id/tasks", async (req, reply) => {
  const { id } = req.params as { id: string }
  const { title, body } = (req.body ?? {}) as { title?: string; body?: string }
  if (!title?.trim()) return reply.code(400).send({ message: "body must include { title }" })

  const project = await getProject(id)
  if (!project) return reply.code(404).send(notFound(`no project ${id}`))
  return createTask(project, title.trim(), (body ?? title).trim())
})

app.delete("/api/projects/:id/tasks/:taskId", async (req, reply) => {
  const { id, taskId } = req.params as { id: string; taskId: string }
  const project = await getProject(id)
  if (!project) return reply.code(404).send(notFound(`no project ${id}`))
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

  const runId = await supervisor.enqueue(project, task)
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
// Live stream
// ---------------------------------------------------------------------------

app.get("/ws", { websocket: true }, (socket) => {
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

      subs.set(msg.runId, unsub)
    }
  })

  socket.on("close", () => {
    for (const unsub of subs.values()) unsub()
    subs.clear()
  })
})

const address = await app.listen({ port: CONFIG.port, host: "127.0.0.1" })
console.log(`aide daemon on ${address}`)
console.log(`  task model   ${CONFIG.taskModel}`)
console.log(`  concurrency  ${CONFIG.maxConcurrentRuns}`)
console.log(`  budget/run   $${CONFIG.maxBudgetUsd}`)