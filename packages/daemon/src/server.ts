import fastifyWebsocket from "@fastify/websocket"
import Fastify from "fastify"
import type { ClientMessage, RunEvent, ServerMessage } from "@aide/protocol"
import { worktreePath } from "@aide/protocol"
import { CONFIG } from "./config.js"
import { EventLog } from "./eventlog.js"
import { addProject, getProject, listProjects, removeProject } from "./registry.js"
import { Supervisor } from "./supervisor.js"
import { createTask, deleteTask, getTask, listTasks } from "./tasks.js"
import { worktreeDiff, worktreeStatus } from "./worktree.js"

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