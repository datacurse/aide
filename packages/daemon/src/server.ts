import { dirname } from "node:path"
import fastifyWebsocket from "@fastify/websocket"
import Fastify from "fastify"
import type {
  Attachment,
  ChatMode,
  ChatStatus,
  ClientMessage,
  EffortLevel,
  FolderPick,
  Health,
  PlanUsage,
  RunEvent,
  ServerMessage,
} from "@aide/protocol"
import { CHAT_MODES, EFFORT_LEVELS } from "@aide/protocol"
import { MAX_PROJECT_DOC_CHARS } from "./agent.js"
import {
  chatStatuses,
  closeChat,
  reopenChat,
} from "./board.js"
import { currentBranch, runChanges } from "./changes.js"
import { ChatLane } from "./chat.js"
import { CONFIG } from "./config.js"
import { EventLog } from "./eventlog.js"
import { addProject, getProject, listProjects, readProjectDoc, removeProject } from "./registry.js"
import { pickFolder } from "./picker.js"
import { conversationReceipt } from "./receipt.js"
import { commitWorkingTree, conversationBaseline } from "./review.js"
import * as repo from "./repo.js"
import { BOOT_SOURCE_ID, currentSourceId, isStale } from "./source.js"
import { getConversation, listConversations } from "./sessions.js"
import { spendBySession } from "./spend.js"
import { planUsage } from "./usage.js"

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
 * A conversation nothing is known about.
 *
 * Used when `chatStatuses` has no entry — which should not happen, since it is
 * asked about exactly the sessions being returned, but the alternative is
 * shipping `undefined` over the wire into a field the browser destructures.
 */
const UNTRACKED: ChatStatus = {
  state: null,
  blocked: false,
  done: false,
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
  supervised: CONFIG.supervised,
  busy: {
    chats: chat.turns().length,
    writes: inFlightWrites.size,
  },
  idleMs: Date.now() - lastWriteFinishedAt,
}))

/**
 * How much of the plan is left, and when each window resets.
 *
 * Its own route rather than a field on health, because it is the one answer here
 * that is not free: a cold reading opens a session with the CLI and takes a
 * second or so. Health is polled on the app's beat and decides whether a daemon
 * can be restarted; it must not start waiting on the network to say so.
 *
 * Cached in `usage.ts` for a minute, so a second tab costs nothing.
 */
app.get("/api/usage", async (): Promise<PlanUsage> => planUsage())

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

/**
 * Point aide at a repository by opening the machine's own folder dialog.
 *
 * Separate from the POST above rather than folded into it, because the two fail
 * in ways that need different words: cancelling is not an error and must leave
 * the screen alone, and "no dialog on this machine" is answered by typing a path
 * instead — see `picker.ts` for why the browser cannot produce one itself.
 *
 * This stays in flight for as long as the window is open, so it shows up in
 * `busy.writes` and holds off an automatic restart. That is the behaviour we
 * want and not a cost of it: a restart kills the process tree, and this tree
 * ends in a window somebody is looking at.
 */
app.post("/api/projects/browse", async (): Promise<FolderPick> => {
  // Beside the last project rather than at the home directory. Repositories are
  // kept together, so the one being added is usually a sibling of one already
  // here — and `pickFolder` falls back to home if that path has since gone.
  const last = (await listProjects()).at(-1)
  try {
    return await pickFolder(last ? dirname(last.root) : undefined)
  } catch (err) {
    // Never a 500. Whatever went wrong, the useful next move is the same one the
    // caller already has for a machine with no dialog: type the path.
    return { path: null, unavailable: err instanceof Error ? err.message : String(err) }
  }
})

app.delete("/api/projects/:id", async (req, reply) => {
  const { id } = req.params as { id: string }
  await removeProject(id)
  return reply.code(204).send()
})

/**
 * What the chat lane knows about a conversation.
 *
 * `turnForSession` returns the turn IN FLIGHT, so null here does not mean the
 * conversation is gone — it means nothing is running.
 */
const liveChat = (sessionId: string) => {
  const turn = chat.turnForSession(sessionId)
  return turn ? { working: true, blocked: turn.blocked } : null
}


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

/**
 * Where HEAD is and what is behind it — the lower half of the uncommitted rail.
 *
 * Deliberately without a file count beside the log, though it would be one more
 * line here: the rail reads `/git/pending` on the app's own beat and already has
 * that number, and the call behind it is the priciest one git makes on a large
 * tree. Two beats, two questions, and neither pays for the other's answer.
 */
app.get("/api/projects/:id/git", async (req, reply) => {
  const { id } = req.params as { id: string }
  const { limit } = req.query as { limit?: string }
  const project = await getProject(id)
  if (!project) return reply.code(404).send(notFound(`no project ${id}`))

  const n = Math.min(Math.max(Number(limit) || DEFAULT_LOG, 1), MAX_LOG)
  try {
    return {
      overview: await repo.overview(project.root),
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
 * Separate from `/git` above rather than folded into it, and the split is by
 * lifetime rather than by subject: history moves when someone commits, this
 * moves on every keystroke an agent makes, and one route would drag a fifty
 * commit graph along behind an indicator that has to stay cheap. It is also the
 * exact question the new-conversation gate below asks, and the two must never be
 * able to disagree — the indicator saying "clean" while the daemon refuses to
 * start a chat would be unexplainable from the screen.
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
    // Spend is attached here for the same reason status is: it is aide's own
    // bookkeeping, read out of aide's event logs, and `listConversations` is a
    // reader of the SDK's session store and nothing else.
    const spend = await spendBySession()
    return list.map((c) => ({
      ...c,
      status: statuses[c.sessionId] ?? UNTRACKED,
      spend: spend.get(c.sessionId) ?? null,
    }))
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
    const spend = await spendBySession()
    return {
      ...found,
      summary: {
        ...found.summary,
        status: statuses[sessionId] ?? UNTRACKED,
        spend: spend.get(sessionId) ?? null,
      },
    }
  } catch (err) {
    return reply.code(502).send({
      message: `could not read that conversation: ${err instanceof Error ? err.message : String(err)}`,
    })
  }
})

/**
 * Reviewing the work, and committing it.
 *
 * There is no `land` here any more, because there is no branch to merge. What
 * used to be two gates on the code — commit to a branch, then merge it — is now
 * one gate on the code and one on the backlog: you press commit, and the row
 * closes only when you say the work is done. Recoverability moved with it, from
 * an unmerged branch to the checkpoint ref.
 *
 * The reading moved too, from before the commit to after it. See
 * `commitWorkingTree` for what the commit writes down so that reading is still
 * possible, and for what that trade actually costs.
 *
 * Note which route each half hangs off. The DIFF is a conversation's, because
 * "what did this chat change" is a question only a checkpoint can answer. The
 * COMMIT is the project's, because what it takes is the working tree — see
 * `review.ts` for the wedge that came of hanging it off a conversation too.
 */

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
 * Deliberately unguarded, unlike the commit below. That guard exists because
 * committing underneath a working agent races its next write; reading a receipt
 * races nothing, and a turn in flight is exactly when you want to see what the
 * last five did. The renderer reports an unfinished turn as unfinished rather
 * than pretending it ended.
 */
app.get("/api/projects/:id/conversations/:sessionId/receipt", async (req, reply) => {
  const { id, sessionId } = req.params as { id: string; sessionId: string }
  const project = await getProject(id)
  if (!project) return reply.code(404).send(notFound(`no project ${id}`))
  return await conversationReceipt(log, project, sessionId)
})

/**
 * Commit what is uncommitted, as a run you can watch.
 *
 * The project's route, not a conversation's, and that is the point of it. What
 * this takes is the working tree — the same list the rail draws and the same
 * list the new-chat block reads — so it can be pressed over work no chat
 * produced. It used to hang off `/conversations/:sessionId/commit` and measure
 * against that conversation's checkpoint, which meant a project dirtied by an
 * editor was blocked from every new chat with no button in aide that would clear
 * it. See `review.ts`.
 *
 * `sessionId` is optional and is attribution only: the commit's trailer, the
 * intent handed to the drafter, and the transcript the run streams into. Absent
 * is a normal case, not a degraded one.
 *
 * Returns a run id rather than a sha: the drafting is a model call on the diff
 * and takes about as long as a short turn, so it goes onto the event stream like
 * one. The browser subscribes, and the message, the paths and the sha arrive in
 * the conversation pane.
 *
 * There is no message in the body. There was one when a panel drafted a message,
 * showed it in a textarea and posted it back; that panel is gone, because a
 * review sitting underneath the transcript is not where anybody was looking. See
 * `commitWorkingTree` for what replaced it and what that costs.
 */
app.post("/api/projects/:id/commit", async (req, reply) => {
  const { id } = req.params as { id: string }

  const project = await getProject(id)
  if (!project) return reply.code(404).send(notFound(`no project ${id}`))

  const body = (req.body ?? {}) as { sessionId?: unknown; force?: unknown }
  // Anything that is not a non-empty string is no attribution, including the
  // `null` the browser sends when no chat is open. A session id off the wire
  // only ever reaches a trailer and a lookup, so it needs no more shape than
  // this.
  const sessionId = typeof body.sessionId === "string" && body.sessionId ? body.sessionId : null
  const force = body.force === true

  // Committing underneath a working agent races its next write, and the diff
  // would be a half-finished turn. `hold` refuses the whole project below; this
  // says the narrower case in the conversation's own words before it gets there.
  if (sessionId && chat.turnForSession(sessionId)) {
    return reply.code(409).send({ message: "a turn is still in flight for this conversation" })
  }

  // What the work was asked for, so the drafter can tell intent from incident.
  // The conversation's opening message, now that there is no backlog row to
  // carry it — which is the better source anyway: it is what you actually typed
  // rather than a line somebody summarised it into. With no conversation there
  // is no intent to give it, and the diff is the whole of what it has to go on.
  const opening = sessionId
    ? (await listConversations(project)).find((c) => c.sessionId === sessionId)
    : undefined
  // Read on the press rather than cached from when the project was added: the
  // checks live in the repository, so a run that added one has changed the gate
  // it is about to be measured by, and reading a copy from boot would apply the
  // old gate to the diff that changed it.
  const doc = await readProjectDoc(project.root)
  try {
    // Throws if another conversation holds the checkout, with that
    // conversation's name in it.
    const runId = chat.hold({
      project,
      sessionId,
      text: "committing what is uncommitted",
      model: CONFIG.helperModel,
      work: (run) =>
        commitWorkingTree({
          project,
          sessionId,
          request: opening?.firstPrompt ?? "",
          verify: doc.verify,
          force,
          emit: run.emit,
          delta: run.delta,
          stopped: run.stopped,
        }),
    })
    return { runId }
  } catch (err) {
    return reply.code(409).send({ message: err instanceof Error ? err.message : String(err) })
  }
})

/**
 * Done. The one thing in this product an agent cannot reach.
 *
 * A toggle rather than a verdict: the states worth telling apart are "this
 * served its purpose" and "not yet", and the transcript already says everything
 * a third one would have. Nothing is removed by it — the conversation is the
 * record — so `reopen` below genuinely undoes it.
 */
app.post("/api/projects/:id/conversations/:sessionId/close", async (req, reply) => {
  const { id, sessionId } = req.params as { id: string; sessionId: string }
  const project = await getProject(id)
  if (!project) return reply.code(404).send(notFound(`no project ${id}`))
  return closeChat(project, sessionId)
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
    autoAfterPlan?: boolean
    effort?: string
  }
  if (!body.text?.trim() && !body.attachments?.length) {
    return reply.code(400).send({ message: "nothing to send" })
  }

  const project = await getProject(id)
  if (!project) return reply.code(404).send(notFound(`no project ${id}`))

  /**
   * The tree is committed before the next conversation begins.
   *
   * Not tidiness. Every conversation measures its diff against a checkpoint
   * taken when it started, so a chat opened on top of uncommitted work inherits
   * that work as its baseline — and when the two touch the same file, git cannot
   * separate them again, so no reading of what THIS chat did can be honest.
   * Refusing here is what keeps `mixed` empty in the ordinary case.
   *
   * The way out is the rail's commit button, which reads this same list and
   * takes all of it. That is not a detail: this refusal is only fair if the
   * button that clears it is measured on exactly what is being refused, and for
   * a long time it was not — it committed a conversation's work, so a tree
   * dirtied by an editor was refused here and uncommittable there.
   *
   * Only for a NEW conversation. Refusing a follow-up would be the opposite of
   * the rule: finishing the chat you are in is one of the ways out.
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
          "Press commit in the rail on the right — it takes everything in that list, whether or " +
          "not a chat made it — or commit them yourself.",
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

  try {
    const runId = await chat.send({
      project,
      sessionId: body.sessionId ?? null,
      text: body.text?.trim() ?? "",
      attachments: body.attachments ?? [],
      mode,
      // `=== true` rather than a cast: this comes off the wire, and anything
      // truthy-but-not-true reaching the permission path should read as "no".
      // Re-scoped to Plan here even though the composer already does it, because
      // a browser that sends this alongside Manual is confused about something,
      // and the answer to that is not to widen Manual.
      autoAfterPlan: mode === "plan" && body.autoAfterPlan === true,
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
      // log, because they are never stored. Any live run may have them — a turn's
      // tokens, or a commit's message as it is written — and a run that is over
      // simply never fires this, so subscribing to history costs nothing.
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
// Windows `taskkill /F` is TerminateProcess and delivers no signal at all —
// which is exactly the case the reconciliation below exists for.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void stopEverything(signal))
}

/**
 * Close whatever the last daemon left open.
 *
 * Boot reconciliation was removed once, and the note left behind said there was
 * nothing at boot that could be wrong: a task filed `running` in a file was
 * wreckage a crash could leave, but a conversation's state is DERIVED on every
 * read from whether a turn is actually in flight. That is still true of the
 * lock, and it is why nothing here rebuilds one.
 *
 * It was never true of the event log, which is written rather than derived. Six
 * runs on this machine end mid-tool-call and never say how they ended, because
 * the process that owed them an outcome was killed before it could write one —
 * and every reader since has reported them as still running.
 *
 * Before `listen`, so no request can see the half-repaired state, and awaited
 * because a browser that connects first would cache the wrong answer for a
 * second.
 */
const abandoned = await log.sealAbandoned()
if (abandoned.length) {
  console.log(`  closed       ${abandoned.length} run(s) left open by a previous daemon`)
}

const address = await app.listen({ port: CONFIG.port, host: "127.0.0.1" })
console.log(`aide daemon on ${address}`)
console.log(`  model        ${CONFIG.taskModel}`)
console.log(`  runs         one per project, in the project's own checkout`)