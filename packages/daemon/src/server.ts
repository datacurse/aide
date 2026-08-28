import fastifyWebsocket from "@fastify/websocket"
import Fastify, { type FastifyReply } from "fastify"
import type {
  Attachment,
  ChatMode,
  ChatStatus,
  ClientMessage,
  EffortLevel,
  Health,
  Project,
  RunEvent,
  ServerMessage,
} from "@aide/protocol"
import { CHAT_MODES, CHAT_VERDICTS, EFFORT_LEVELS, isChatVerdict } from "@aide/protocol"
import { MAX_PROJECT_DOC_CHARS } from "./agent.js"
import {
  boardRows,
  chatStatuses,
  closeChat,
  linkSession,
  reopenChat,
  rowForSession,
  unlinkRow,
} from "./board.js"
import { currentBranch, runChanges } from "./changes.js"
import { ChatLane } from "./chat.js"
import { CONFIG } from "./config.js"
import { EventLog } from "./eventlog.js"
import { addProject, getProject, listProjects, readProjectDoc, removeProject } from "./registry.js"
import { conversationReceipt } from "./receipt.js"
import { commitConversation, conversationBaseline } from "./review.js"
import * as repo from "./repo.js"
import { BOOT_SOURCE_ID, currentSourceId, isStale } from "./source.js"
import { getConversation, listConversations } from "./sessions.js"
import { addTodo, deleteTodo, editTodo, findTodo, readSpec } from "./todos.js"

const log = new EventLog()
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

// ---------------------------------------------------------------------------
// Is this a safe moment to be restarted?
//
// The dev server restarts this process when its source changes, and the one
// thing it must never do is restart it mid-write. That already happened once,
// under `tsx watch`: a run rewrote `packages/daemon/src`, chokidar fired, and
// the daemon was killed part way through the git work that followed — leaving
// the repository half-changed and a reset socket that read as a failure.
//
// Chat turns are visible to the chat lane. A commit is not: it is one HTTP
// request that writes the spec, stages a path list and rewrites the backlog
// before it answers. So mutating requests are counted here, which is the only
// place that sees them.
//
// This matters more now than when it was written, not less. The daemon serves
// the checkout its own agents edit, so aide developing aide means a run rewrites
// the running daemon's source as a matter of course rather than as an accident.
//
// Keyed by request id rather than a counter, because a counter has to be
// decremented exactly once and this hook does not run for requests the origin
// guard above already refused. A set cannot go negative.
// ---------------------------------------------------------------------------

const inFlightWrites = new Set<string>()
let lastWriteFinishedAt = Date.now()

const isWrite = (method: string) => method !== "GET" && method !== "HEAD" && method !== "OPTIONS"

app.addHook("onRequest", async (req) => {
  if (isWrite(req.method)) inFlightWrites.add(req.id)
})

const finishWrite = (id: string) => {
  if (inFlightWrites.delete(id)) lastWriteFinishedAt = Date.now()
}

app.addHook("onResponse", async (req) => finishWrite(req.id))
// A client that hangs up mid-request never gets a response, and without this its
// id would sit in the set forever and the daemon would look permanently busy.
app.addHook("onRequestAbort", async (req) => finishWrite(req.id))

/** Which conversation, if any, currently has a chat turn running. */
const activeChatRun = (sessionId: string): string | null =>
  chat.turnForSession(sessionId)?.runId ?? null

/** The whole turn, for the case where the transcript does not exist yet. */
const liveChatTurn = (sessionId: string) => chat.turnForSession(sessionId) ?? null

const notFound = (msg: string) => ({ statusCode: 404, error: "Not Found", message: msg })

/**
 * A conversation the board has never heard of.
 *
 * Used when `chatStatuses` has no entry — which should not happen, since it is
 * asked about exactly the sessions being returned, but the alternative is
 * shipping `undefined` over the wire into a field the browser destructures.
 */
const UNTRACKED: ChatStatus = {
  rowId: null,
  state: null,
  blocked: false,
  stale: false,
  verdict: null,
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

app.get("/api/health", async (): Promise<Health> => ({
  ok: true,
  taskModel: CONFIG.taskModel,
  bootSourceId: BOOT_SOURCE_ID,
  sourceId: await currentSourceId(),
  stale: await isStale(),
  supervised: process.env["AIDE_MANAGED"] === "1",
  busy: {
    chats: chat.turns().length,
    writes: inFlightWrites.size,
  },
  idleMs: Date.now() - lastWriteFinishedAt,
}))

/**
 * Every project, and who has its checkout.
 *
 * The holder rather than a count, because one run at a time makes a count a
 * boolean wearing a number's clothes — and the useful question when you cannot
 * start a run is which conversation to go and look at.
 */
app.get("/api/projects", async () => {
  const projects = await listProjects()
  return projects.map((p) => {
    const holder = chat.holderFor(p.id)
    return {
      ...p,
      holder: holder
        ? { runId: holder.runId, sessionId: holder.sessionId, title: firstLine(holder.text), startedAt: holder.startedAt }
        : null,
    }
  })
})

/** First non-empty line, capped. The same rule the conversation list titles by. */
const firstLine = (text: string): string => {
  const line = text.split("\n").find((l) => l.trim())?.trim() ?? "(untitled)"
  return line.length > 80 ? `${line.slice(0, 80)}…` : line
}

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
// The board
// ---------------------------------------------------------------------------

/**
 * What the chat lane knows about a conversation, in the shape the board wants.
 *
 * `turnForSession` returns the turn IN FLIGHT, so null here does not mean the
 * conversation is gone — it means nothing is running, which is exactly the
 * `needs-you` resting state. `boardRows` makes that distinction; this only has
 * to answer honestly.
 */
const liveChat = (sessionId: string) => {
  const turn = chat.turnForSession(sessionId)
  return turn ? { working: true, blocked: turn.blocked } : null
}

/**
 * Rows and spec in one response, because they are one view. Fetching them
 * separately would let the backlog and the capability list render a frame apart,
 * which is the one thing the side-by-side is for.
 */
app.get("/api/projects/:id/board", async (req, reply) => {
  const { id } = req.params as { id: string }
  const project = await getProject(id)
  if (!project) return reply.code(404).send(notFound(`no project ${id}`))
  const [rows, spec, doc] = await Promise.all([
    boardRows(project, liveChat),
    readSpec(project),
    readProjectDoc(project.root).catch(() => null),
  ])

  // The things about project state that go wrong SILENTLY. Everything else here
  // surfaces as an error; these two just quietly stop being true — a brief past
  // the cap loses its second half on the way into every prompt, and a retired
  // frontmatter key sits there looking like configuration that still does
  // something.
  const size = doc?.body.trim().length ?? 0
  const warnings: string[] = []
  if (size > MAX_PROJECT_DOC_CHARS) {
    warnings.push(
      `.aide/project.md is ${size} characters and is cut off at ${MAX_PROJECT_DOC_CHARS} in every prompt. Move what belongs in the spec out of it.`,
    )
  }
  if (doc?.retired.length) {
    warnings.push(
      `.aide/project.md still sets ${doc.retired.join(" and ")}, which aide no longer reads — runs work the project's own checkout, so there is no fresh worktree to set up. Delete those lines.`,
    )
  }
  return { rows, spec, warnings }
})

app.post("/api/projects/:id/todos", async (req, reply) => {
  const { id } = req.params as { id: string }
  const { text } = (req.body ?? {}) as { text?: string }
  if (!text?.trim()) return reply.code(400).send({ message: "body must include { text }" })
  const project = await getProject(id)
  if (!project) return reply.code(404).send(notFound(`no project ${id}`))
  return addTodo(project, text)
})

app.patch("/api/projects/:id/todos/:todoId", async (req, reply) => {
  const { id, todoId } = req.params as { id: string; todoId: string }
  const { text } = (req.body ?? {}) as { text?: string }
  if (!text?.trim()) return reply.code(400).send({ message: "body must include { text }" })
  const project = await getProject(id)
  if (!project) return reply.code(404).send(notFound(`no project ${id}`))
  try {
    return await editTodo(project, todoId, text)
  } catch (err) {
    return reply.code(404).send(notFound(err instanceof Error ? err.message : String(err)))
  }
})

app.delete("/api/projects/:id/todos/:todoId", async (req, reply) => {
  const { id, todoId } = req.params as { id: string; todoId: string }
  const project = await getProject(id)
  if (!project) return reply.code(404).send(notFound(`no project ${id}`))
  try {
    await deleteTodo(project, todoId)
  } catch (err) {
    return reply.code(404).send(notFound(err instanceof Error ? err.message : String(err)))
  }
  // The link outlives the row deliberately: `boardRows` filters links whose row
  // is gone rather than deleting them, so a row removed by hand in an editor and
  // typed back does not lose the conversation that was working it.
  return reply.code(204).send()
})

/**
 * Attach a conversation to a row.
 *
 * Sent by the browser once the SDK has named the session, because that is the
 * first moment both halves of the pair exist: the row id came from the click,
 * and the session id does not exist until the first turn starts.
 */
app.post("/api/projects/:id/board/:todoId/session", async (req, reply) => {
  const { id, todoId } = req.params as { id: string; todoId: string }
  const { sessionId } = (req.body ?? {}) as { sessionId?: string }
  if (!sessionId?.trim()) return reply.code(400).send({ message: "body must include { sessionId }" })
  const project = await getProject(id)
  if (!project) return reply.code(404).send(notFound(`no project ${id}`))
  await linkSession(project.id, todoId, sessionId)
  return reply.code(204).send()
})

app.delete("/api/projects/:id/board/:todoId/session", async (req, reply) => {
  const { id, todoId } = req.params as { id: string; todoId: string }
  const project = await getProject(id)
  if (!project) return reply.code(404).send(notFound(`no project ${id}`))
  await unlinkRow(project.id, todoId)
  return reply.code(204).send()
})

/**
 * The branch a commit would land on. Shown on the button so it is never a guess.
 *
 * It matters more than it used to. A commit used to go to a branch aide made for
 * the conversation; it now goes to whatever the human has checked out, so the
 * name of that branch is part of what they are approving.
 */
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
// The repository itself
//
// Read-only, and separate from the task-worktree routes above on purpose: those
// show what an agent did, these show the repo it did it in. Split across three
// requests because they have three different lifetimes — the summary is polled,
// the working tree is re-read only while you are looking at it, and a commit is
// immutable and therefore fetched once and never again.
// ---------------------------------------------------------------------------

const DEFAULT_LOG = 50
const MAX_LOG = 500

app.get("/api/projects/:id/git", async (req, reply) => {
  const { id } = req.params as { id: string }
  const { limit } = req.query as { limit?: string }
  const project = await getProject(id)
  if (!project) return reply.code(404).send(notFound(`no project ${id}`))

  const n = Math.min(Math.max(Number(limit) || DEFAULT_LOG, 1), MAX_LOG)
  try {
    return {
      overview: await repo.overview(project.root),
      dirty: repo.countDirt(await repo.status(project.root)),
      log: await repo.log(project.root, n),
    }
  } catch (err) {
    // A project whose directory was moved or deleted is the common case here,
    // and it must not read as the daemon being broken.
    return reply.code(502).send({
      message: `could not read ${project.root}: ${err instanceof Error ? err.message : String(err)}`,
    })
  }
})

/**
 * What is still uncommitted, cheap enough to poll from an always-visible rail.
 *
 * Separate from `/git` above rather than folded into it: that one builds a
 * history graph nothing in the UI asks for any more, this one is read on every
 * beat from every pane. It is also the exact question the new-conversation
 * gate below asks, and the two must never be able to disagree — the indicator
 * saying "clean" while the daemon refuses to start a chat would be unexplainable
 * from the screen.
 */
app.get("/api/projects/:id/git/pending", async (req, reply) => {
  const { id } = req.params as { id: string }
  const project = await getProject(id)
  if (!project) return reply.code(404).send(notFound(`no project ${id}`))
  try {
    return await repo.pending(project.root)
  } catch (err) {
    return reply.code(502).send({
      message: `could not read ${project.root}: ${err instanceof Error ? err.message : String(err)}`,
    })
  }
})

app.get("/api/projects/:id/git/working", async (req, reply) => {
  const { id } = req.params as { id: string }
  const project = await getProject(id)
  if (!project) return reply.code(404).send(notFound(`no project ${id}`))
  try {
    return await repo.workingTree(project.root)
  } catch (err) {
    return reply.code(502).send({
      message: `could not read ${project.root}: ${err instanceof Error ? err.message : String(err)}`,
    })
  }
})

app.get("/api/projects/:id/git/commits/:sha", async (req, reply) => {
  const { id, sha } = req.params as { id: string; sha: string }
  const project = await getProject(id)
  if (!project) return reply.code(404).send(notFound(`no project ${id}`))
  // 400 rather than 404 for a malformed sha: the difference between "that is not
  // a sha" and "no commit by that name" is the one a stuck UI needs.
  if (!repo.isSha(sha)) return reply.code(400).send({ message: `${sha} is not a commit sha` })

  const found = await repo.commitDetail(project.root, sha)
  if (!found) return reply.code(404).send(notFound(`no commit ${sha} in ${project.name}`))
  return found
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
    // Status is attached here rather than inside `listConversations`, which is
    // deliberately a reader of the SDK's session store and nothing else. The
    // board is aide's own bookkeeping and does not belong in it.
    const list = await listConversations(project, activeChatRun)
    const statuses = await chatStatuses(project, list, liveChat)
    return list.map((c) => ({ ...c, status: statuses[c.sessionId] ?? UNTRACKED }))
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
    const found = await getConversation(project, sessionId, activeChatRun, liveChatTurn)
    if (!found) return reply.code(404).send(notFound(`no conversation ${sessionId} in this project`))
    const statuses = await chatStatuses(project, [found.summary], liveChat)
    return { ...found, summary: { ...found.summary, status: statuses[sessionId] ?? UNTRACKED } }
  } catch (err) {
    return reply.code(502).send({
      message: `could not read that conversation: ${err instanceof Error ? err.message : String(err)}`,
    })
  }
})

/**
 * Reviewing a conversation's work.
 *
 * There is no `land` here any more, because there is no branch to merge. What
 * used to be two gates on the code — commit to a branch, then merge it — is now
 * one gate on the code and one on the backlog: you press commit, and the row
 * closes only when you say the work is done. Recoverability moved with it, from
 * an unmerged branch to the checkpoint ref.
 *
 * The reading moved too, from before the commit to after it. See
 * `commitConversation` for what the commit writes down so that reading is still
 * possible, and for what that trade actually costs.
 */

/** The review baseline, or a 409 explaining why there is not one. */
const reviewable = async (
  project: Project,
  sessionId: string,
  reply: FastifyReply,
): Promise<{ rowId: string | null; checkpoint: string } | null> => {
  // Committing underneath a working agent races its next write. It is also
  // impossible to review honestly: the diff would be a half-finished turn.
  if (chat.turnForSession(sessionId)) {
    await reply.code(409).send({ message: "a turn is still in flight for this conversation" })
    return null
  }
  const found = await conversationBaseline(project, sessionId)
  if (!found) {
    await reply.code(409).send({
      message: "this conversation has no checkpoint, so there is nothing to measure a change against",
    })
    return null
  }
  return found
}

app.get("/api/projects/:id/conversations/:sessionId/diff", async (req, reply) => {
  const { id, sessionId } = req.params as { id: string; sessionId: string }
  const project = await getProject(id)
  if (!project) return reply.code(404).send(notFound(`no project ${id}`))
  const found = await conversationBaseline(project, sessionId)
  if (!found) return reply.code(409).send({ message: "this conversation has no checkpoint" })

  const changes = await runChanges(project.root, found.checkpoint)
  return {
    root: project.root,
    diff: changes.diff,
    paths: changes.paths,
    mixed: changes.overlap,
  }
})

/**
 * What the conversation cost and where it went wrong, as one pasteable document.
 *
 * Deliberately NOT behind `reviewable`. That guard exists because committing
 * underneath a working agent races its next write; reading a receipt races
 * nothing, and a turn in flight is exactly when you want to see what the last
 * five did. The renderer reports an unfinished turn as unfinished rather than
 * pretending it ended.
 */
app.get("/api/projects/:id/conversations/:sessionId/receipt", async (req, reply) => {
  const { id, sessionId } = req.params as { id: string; sessionId: string }
  const project = await getProject(id)
  if (!project) return reply.code(404).send(notFound(`no project ${id}`))
  return await conversationReceipt(log, project, sessionId)
})

/**
 * Commit a conversation's work, as a run you can watch.
 *
 * Returns a run id rather than a sha, and that is the whole change: the drafting
 * is two model calls on the diff and takes about as long as a short turn, so it
 * goes onto the event stream like one. The browser subscribes to it and the
 * message, the paths and the sha arrive in the transcript of the conversation
 * that earned them.
 *
 * There is no message in the body any more. There was one when a panel drafted a
 * message, showed it in a textarea and posted it back; that panel is gone,
 * because a review sitting underneath the transcript is not where anybody was
 * looking. See `commitConversation` for what replaced it and what that costs.
 */
app.post("/api/projects/:id/conversations/:sessionId/commit", async (req, reply) => {
  const { id, sessionId } = req.params as { id: string; sessionId: string }

  const project = await getProject(id)
  if (!project) return reply.code(404).send(notFound(`no project ${id}`))
  const found = await reviewable(project, sessionId, reply)
  if (!found) return

  const row = found.rowId ? await findTodo(project, found.rowId) : undefined
  try {
    // Throws if another conversation holds the checkout, with that
    // conversation's name in it. `reviewable` has already refused the narrower
    // case — this one's own turn still running.
    const runId = chat.hold({
      project,
      sessionId,
      text: "committing this conversation's work",
      model: CONFIG.helperModel,
      work: (run) =>
        commitConversation({
          project,
          sessionId,
          rowId: found.rowId,
          checkpoint: found.checkpoint,
          request: row?.text ?? "",
          emit: run.emit,
          stopped: run.stopped,
        }),
    })
    return { runId }
  } catch (err) {
    return reply.code(409).send({ message: err instanceof Error ? err.message : String(err) })
  }
})

/**
 * The verdict. The one thing in this product an agent cannot reach.
 *
 * Both verdicts remove the backlog row: the work is finished, or it is not
 * wanted. See `closeChat` for why the verdict is expressed as the shape of the
 * todo file rather than as a status field, and why there is no verdict for work
 * that simply is not done yet.
 */
app.post("/api/projects/:id/conversations/:sessionId/close", async (req, reply) => {
  const { id, sessionId } = req.params as { id: string; sessionId: string }
  const { verdict } = (req.body ?? {}) as { verdict?: unknown }
  if (!isChatVerdict(verdict)) {
    return reply.code(400).send({ message: `verdict must be one of ${CHAT_VERDICTS.join(", ")}` })
  }
  const project = await getProject(id)
  if (!project) return reply.code(404).send(notFound(`no project ${id}`))
  return closeChat(project, sessionId, verdict)
})

app.post("/api/projects/:id/conversations/:sessionId/reopen", async (req, reply) => {
  const { id, sessionId } = req.params as { id: string; sessionId: string }
  const project = await getProject(id)
  if (!project) return reply.code(404).send(notFound(`no project ${id}`))
  await reopenChat(project, sessionId)
  return reply.code(204).send()
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
    /** Start this conversation on an existing board row. */
    todoId?: string
    /** Put it on the board with no row yet — one gets created from the message. */
    track?: boolean
  }
  if (!body.text?.trim() && !body.attachments?.length) {
    return reply.code(400).send({ message: "nothing to send" })
  }

  const project = await getProject(id)
  if (!project) return reply.code(404).send(notFound(`no project ${id}`))

  /**
   * One conversation's work is committed before the next one begins.
   *
   * Not tidiness. Every conversation measures its diff against a checkpoint
   * taken when it started, so a chat opened on top of uncommitted work inherits
   * that work as its baseline — and when the two touch the same file, git cannot
   * separate them again and neither review can be honest about what it is
   * committing. Refusing here is what keeps `mixed` empty in the ordinary case.
   *
   * Only for a NEW conversation. Refusing a follow-up would be the opposite of
   * the rule: the way out of this state is to finish the chat you are in.
   *
   * A repo that cannot be read at all lets the message through rather than
   * blocking it — the exception to fail-closed, because the very next thing this
   * turn does is take a checkpoint of that same tree, which will fail loudly and
   * say why. Guessing "dirty" here would answer a broken repository with a
   * lecture about committing.
   */
  if (!body.sessionId) {
    const outstanding = await repo.pending(project.root).catch(() => null)
    if (outstanding && outstanding.files.length > 0) {
      const n = outstanding.files.length
      return reply.code(409).send({
        message:
          `${n} uncommitted file${n === 1 ? "" : "s"} on ${outstanding.branch ?? "this checkout"}. ` +
          "Commit from the conversation that made them — the commit button beside send does it in " +
          "one press — or commit them yourself if they are not aide's.",
      })
    }
  }

  // Validated rather than cast: these come from a form, and an unknown mode
  // would otherwise reach the SDK as an undefined permission mode.
  const mode = (CHAT_MODES as readonly string[]).includes(body.mode ?? "")
    ? (body.mode as ChatMode)
    : "manual"
  const effort = (EFFORT_LEVELS as readonly string[]).includes(body.effort ?? "")
    ? (body.effort as EffortLevel)
    : "high"

  /**
   * Which backlog row this conversation is working, decided HERE.
   *
   * It no longer picks a working directory — every conversation runs in the
   * project root — so getting it wrong is no longer destructive. It is still
   * resolved server-side rather than trusted from the client, because a
   * follow-up must stay on the row its conversation is already on and the board
   * is the thing that knows which that is.
   */
  let rowId: string | null = null
  try {
    if (body.sessionId) {
      rowId = await rowForSession(project.id, body.sessionId)
    } else if (body.todoId) {
      const row = await findTodo(project, body.todoId)
      if (!row) return reply.code(404).send(notFound(`no todo ${body.todoId}`))
      rowId = row.id
    } else if (body.track) {
      // A cold conversation that asked to be tracked gets a row. Work happening
      // off the board is the blindness the board exists to remove — you would
      // write a todo for something an agent is already doing.
      const first = (body.text ?? "").trim().split(/\r?\n/)[0]?.slice(0, 120) ?? ""
      rowId = (await addTodo(project, first || "untitled")).id
    }
  } catch (err) {
    return reply.code(500).send({ message: err instanceof Error ? err.message : String(err) })
  }

  try {
    const runId = await chat.send({
      project,
      sessionId: body.sessionId ?? null,
      text: body.text?.trim() ?? "",
      attachments: body.attachments ?? [],
      mode,
      effort,
      rowId,
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

/**
 * A route this daemon has never heard of, explained.
 *
 * Fastify's own 404 says `Route GET:/api/projects/x/git not found`, which is
 * true and useless: the overwhelmingly likely reason is that the browser is
 * running code newer than this process. Saying so turns a bug report into a
 * button press.
 *
 * Only for unmatched routes — the explicit 404s above, for a project or task
 * that genuinely does not exist, never reach this.
 */
app.setNotFoundHandler(async (req, reply) => {
  const message = (await isStale())
    ? `this daemon booted before ${req.method} ${req.url} existed — its source has changed since, so restart it`
    : `Route ${req.method}:${req.url} not found`
  return reply.code(404).send({ statusCode: 404, error: "Not Found", message })
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
  await app.close().catch(() => {})
  process.exit(0)
}

// Ctrl-C on `pnpm daemon`, and any orderly kill. Note what these CANNOT catch:
// Windows `taskkill /F` is TerminateProcess and delivers no signal at all.
//
// Boot reconciliation used to live here, and no longer needs to: a task filed
// `running` in a file was wreckage a crash could leave behind, but a
// conversation's state is derived on every read from whether a turn is actually
// in flight. There is nothing left to correct at boot because nothing was
// written that could be wrong.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void stopEverything(signal))
}

const address = await app.listen({ port: CONFIG.port, host: "127.0.0.1" })
console.log(`aide daemon on ${address}`)
console.log(`  model        ${CONFIG.taskModel}`)
console.log(`  runs         one per project, in the project's own checkout`)