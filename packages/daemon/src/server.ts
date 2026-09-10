import { existsSync } from "node:fs"
import { dirname } from "node:path"
import fastifyWebsocket from "@fastify/websocket"
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify"
import type {
  Activity,
  Attachment,
  ChatMode,
  ChatSpend,
  ChatStatus,
  ClientMessage,
  EffortLevel,
  FolderPick,
  Health,
  PlanUsage,
  Project,
  RunEvent,
  ServerMessage,
  SshHost,
  SshListing,
} from "@aide/protocol"
import { CHAT_MODES, EFFORT_LEVELS, isChatModel } from "@aide/protocol"
import { runLogPath, sshConfigPath } from "@aide/protocol/node"
import { activity } from "./activity.js"
import { MAX_PROJECT_DOC_CHARS } from "./agent.js"
import {
  chatStatuses,
  closeChat,
  reopenChat,
} from "./board.js"
import { currentBranch, pushBranch, runChanges, squashAndPush } from "./changes.js"
import { ChatLane } from "./chat.js"
import { CONFIG } from "./config.js"
import { EventLog } from "./eventlog.js"
import { repoOf } from "./git.js"
import { nameChat } from "./helper.js"
import {
  addProject,
  addRemoteProject,
  getProject,
  listProjects,
  readProjectDoc,
  removeProject,
} from "./registry.js"
import { pickFolder } from "./picker.js"
import { listRemoteDirectories, listSshHosts } from "./ssh.js"
import { conversationProfile } from "./profile.js"
import {
  commitWorkingTree,
  conversationBaseline,
  turnCommitMessage,
  VerifyFailed,
} from "./review.js"
import * as repo from "./repo.js"
import { BOOT_SOURCE_ID, currentSourceId, isStale } from "./source.js"
import { getConversation, listConversations } from "./sessions.js"
import { sessionOfRun, spendBySession, terminalEvent } from "./spend.js"
import { planUsage } from "./usage.js"

const log = new EventLog()
const chat = new ChatLane(log)

// `bodyLimit` because a chat turn carries its attachments — pasted screenshots
// and dropped files alike — as base64 in its JSON body. Fastify's default is
// 1MiB, which the web side's own rules exceed by design —
// `MAX_ATTACHMENT_BYTES` allows 10MB per attachment and base64 adds a third —
// so a send with a few screenshots died here as a 413 before any aide code saw
// it. From the list that read as ▶ flickering and nothing running: the refusal
// put the draft back, and the reason was drawn in a pane the eye had already
// left. Sized to four max-size attachments plus text; loopback-only behind the
// origin guard, so the cap is sanity, not exposure.
const app = Fastify({
  logger: { level: process.env["AIDE_LOG_LEVEL"] ?? "warn" },
  bodyLimit: 64 * 1024 * 1024,
})
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
// request that runs the project's checks, spends a model call on a message,
// stages and writes a commit and may push it, all before it answers. So
// mutating requests are counted here, which is the only place that sees them.
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

const notFound = (msg: string) => ({ statusCode: 404, error: "Not Found", message: msg })

/**
 * The three lines every project route opened with, written once.
 *
 * `const { id } = req.params as { id: string }`, a `getProject`, and a 404 —
 * fifteen copies of it, each with its own hand-written cast that the compiler
 * cannot check against the route string it is supposed to match. A typo in the
 * param name does not fail to compile; it yields `undefined` and a 404 for a
 * project that is plainly there.
 *
 * `handler` receives the resolved project, so a route that reaches its body has
 * one — which is the other half of what this removes: the `project!` and the
 * re-checks that come of a value the type system had already lost track of.
 *
 * Extra params (`:sessionId`, `:sha`) still come off `req.params` in the route,
 * because they vary and a generic that covered them would be a schema library
 * in all but name — and `packages/protocol` deliberately has none.
 */
const withProject = <T>(
  handler: (project: Project, req: FastifyRequest, reply: FastifyReply) => Promise<T>,
) => {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string }
    const project = await getProject(id)
    if (!project) return reply.code(404).send(notFound(`no project ${id}`))
    return await handler(project, req, reply)
  }
}

/**
 * A read of somebody's repository that may simply not be reachable.
 *
 * The `catch` blocks this replaces were four distinct messages for one situation,
 * and the common case is not exotic: a project whose directory was moved or
 * deleted, or a remote whose host is not answering. It must not read as the
 * daemon being broken — hence 502 rather than 500, since the failure is
 * downstream of this process. aide is fine; the thing it was asked to read is not.
 *
 * The message names the ROOT rather than the operation, because that is the part
 * that tells you which of your projects has gone missing.
 */
const readingRepo = async <T>(
  project: Project,
  reply: FastifyReply,
  read: () => Promise<T>,
): Promise<T | never> => {
  try {
    return await read()
  } catch (err) {
    return reply.code(502).send({
      message: `could not read ${project.root}: ${err instanceof Error ? err.message : String(err)}`,
    })
  }
}

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
 * Activity across every project — what the dashboard draws.
 *
 * Machine-scoped rather than project-scoped, which is why it sits beside usage
 * up here rather than under `/api/projects/:id`. It is the one question in aide
 * that is about the whole of `~/.aide/runs` at once.
 *
 * One route for the whole page rather than one per tile: every figure comes from
 * a single pass over the same run index, so splitting it would re-reduce the
 * same array six times and — worse — let two tiles answer from either side of a
 * poll boundary and disagree on screen.
 *
 * `days` is clamped rather than validated into an error. It arrives from a query
 * string, so it can be anything; a dashboard that answers a nonsense window with
 * a 400 is worse than one that answers the nearest sensible window, and there is
 * no destructive act on the other side of it to protect.
 */
app.get("/api/activity", async (req): Promise<Activity> => {
  const asked = (req.query as { days?: unknown }).days
  // `Number("")` is 0, not NaN, so an empty `?days=` would clamp to a ONE-day
  // window rather than falling back to the default — a query string that looks
  // like it asked for nothing quietly asking for today only. Anything that is
  // not a non-empty string is no parameter at all.
  const raw = typeof asked === "string" && asked.trim() !== "" ? Number(asked) : Number.NaN
  const days = Number.isFinite(raw) ? Math.min(365, Math.max(1, Math.floor(raw))) : 30
  return activity(await listProjects(), days)
})

/**
 * Every project, and who has its checkout.
 *
 * The holder rather than a count, because one run at a time makes a count a
 * boolean wearing a number's clothes — and the useful question when you cannot
 * start a run is which conversation to go and look at.
 *
 * This is the only per-conversation liveness the browser polls. The chat list is
 * fetched when you arrive at a project and when something you did changed it,
 * never on the beat — reading the session store and every run log twice a second
 * to redraw thirty rows is not worth it. So the two facts that move DURING a turn
 * ride here instead, on the object that already says who is in your way, and one
 * agent per project is what makes that possible: at most one conversation is
 * running, so at most one can be waiting on a click.
 */
app.get("/api/projects", async () => {
  const projects = await listProjects()
  return projects.map((p) => {
    const holder = chat.holderFor(p.id)
    return {
      ...p,
      holder: holder
        ? {
            runId: holder.runId,
            sessionId: holder.sessionId,
            title: firstLine(holder.text),
            startedAt: holder.startedAt,
            blocked: holder.blocked,
            held: holder.held,
          }
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

/**
 * The machines in `~/.aide/ssh_config`.
 *
 * A GET, and therefore something the poll could call — but it is not on one. The
 * file changes when a person edits it, which is rare and is followed by them
 * opening the picker, so it is read when the picker opens.
 */
app.get("/api/ssh/hosts", async (): Promise<{ hosts: SshHost[]; configPath: string }> => {
  // The path travels with the list because the empty case needs it: "no machines
  // yet" is only actionable next to the name of the file to put one in.
  return { hosts: await listSshHosts(), configPath: sshConfigPath() }
})

/**
 * What is in a directory on one of those machines.
 *
 * A POST rather than a GET despite reading nothing, because the path is a body
 * rather than a query string: it can contain slashes, spaces and `#`, and the
 * round trip through URL encoding is a bug farm for no gain.
 *
 * A 502 rather than a 400 when ssh fails, and the distinction is worth keeping:
 * an unknown host alias is this end's fault and a 400, while a machine that is
 * asleep or refusing a key is the far end's and is not something the caller can
 * fix by sending different bytes.
 */
app.post("/api/ssh/list", async (req, reply): Promise<SshListing | { message: string }> => {
  const { host, path } = (req.body ?? {}) as { host?: string; path?: string }
  if (!host) return reply.code(400).send({ message: "body must include { host }" })

  const known = (await listSshHosts()).find((h) => h.alias === host)
  if (!known) {
    return reply
      .code(400)
      .send({ message: `no host named ${host} in ${sshConfigPath()}` })
  }
  try {
    return await listRemoteDirectories(known, path ?? ".")
  } catch (err) {
    return reply.code(502).send({ message: err instanceof Error ? err.message : String(err) })
  }
})

/**
 * Add a repository that lives on one of those machines.
 *
 * Separate from `POST /api/projects`, which takes a local path and resolves it
 * against this filesystem. Folding the two together would mean a body with a
 * `host` on it silently changing what `path` means, and the failure of getting
 * that wrong is a remote path read as a local one — the exact confusion the
 * picker used to refuse outright.
 */
app.post("/api/ssh/projects", async (req, reply) => {
  const { host, path } = (req.body ?? {}) as { host?: string; path?: string }
  if (!host || !path) {
    return reply.code(400).send({ message: "body must include { host, path }" })
  }
  const known = (await listSshHosts()).find((h) => h.alias === host)
  if (!known) return reply.code(400).send({ message: `no host named ${host} in ${sshConfigPath()}` })
  try {
    return await addRemoteProject(known, path)
  } catch (err) {
    return reply.code(400).send({ message: err instanceof Error ? err.message : String(err) })
  }
})

/**
 * Forget a project. The registry entry only — see `removeProject`.
 *
 * Refused while a run holds the checkout, on the same terms as a push and for a
 * sharper reason: the lane belongs to the daemon, not to the registry, so
 * dropping the entry under a live turn does not stop it. It orphans it. The run
 * keeps writing to a checkout that nothing on screen can name any more, and the
 * only thing that could have interrupted it — the project's own column — is the
 * thing that just went away. Adding it back would not reattach the UI to it
 * either, since the chat list is read per project and the run is mid-turn.
 */
app.delete("/api/projects/:id", async (req, reply) => {
  const { id } = req.params as { id: string }
  const holder = chat.holderFor(id)
  if (holder) {
    return reply.code(409).send({
      message: `"${firstLine(holder.text)}" is working in this checkout — stop it before removing the project`,
    })
  }
  await removeProject(id)
  return reply.code(204).send()
})

/**
 * A conversation summary with aide's own bookkeeping attached.
 *
 * Both conversation routes want the same three things joined: the row from the
 * SDK's session store, the status from the board and the lock, and the spend from
 * the event logs. They differ only in how many rows they are joining — the list
 * does N, the open conversation does one — so the join lives here rather than
 * being written twice and drifting.
 *
 * The status and the spend are attached OUT here rather than inside
 * `listConversations`, which is deliberately a reader of the SDK's session store
 * and nothing else. The board and the run logs are aide's own and do not belong
 * in it.
 */
async function withBookkeeping<T extends { sessionId: string }>(
  project: Project,
  rows: readonly T[],
): Promise<Array<T & { status: ChatStatus; spend: ChatSpend | null }>> {
  // Together: the board is a small JSON read and the spend is an mtime-keyed scan
  // that is warm after the first poll, and neither needs the other's answer.
  const [statuses, spend] = await Promise.all([chatStatuses(project, rows, chat), spendBySession()])
  return rows.map((row) => ({
    ...row,
    status: statuses[row.sessionId] ?? UNTRACKED,
    spend: spend.get(row.sessionId) ?? null,
  }))
}

// ---------------------------------------------------------------------------
// The repository itself
//
// Read-only, and separate from the conversation routes above on purpose: those
// show what an agent did, these show the repo it did it in. Split by lifetime:
// the summary is polled on the app's beat, the file tree is re-read only while
// you are looking at it.
//
// There was a `/branch` route here, answering the one question the commit button
// asks. It is now a field on `GitPending`, which the rail already polls — so the
// answer arrives in a request that was happening anyway rather than in one of
// its own. `currentBranch` is still the thing that computes it.
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
app.get(
  "/api/projects/:id/git",
  withProject(async (project, req, reply) => {
    const { limit } = req.query as { limit?: string }
    const n = Math.min(Math.max(Number(limit) || DEFAULT_LOG, 1), MAX_LOG)
    return await readingRepo(project, reply, async () => ({
      overview: await repo.overview(repoOf(project)),
      log: await repo.log(repoOf(project), n),
    }))
  }),
)


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
app.get(
  "/api/projects/:id/git/pending",
  withProject((project, _req, reply) =>
    readingRepo(project, reply, () => repo.pending(repoOf(project))),
  ),
)

/**
 * One directory of the working tree, for the rail's file view.
 *
 * A query parameter rather than a wildcard route, because the thing being named
 * is a path with slashes in it and Fastify would otherwise need `*` — which
 * makes the empty string, meaning the repository root, the one value the route
 * cannot express.
 *
 * Answered one level at a time. See `GitTree`: the alternative reads every path
 * in the repository to draw the twenty rows you can see, and does it again down
 * a 1.4s ssh connection for a remote project.
 */
app.get(
  "/api/projects/:id/git/tree",
  withProject(async (project, req, reply) => {
    const { path } = req.query as { path?: string }

    // This value comes from the URL and ends up as a git argument, so the same
    // rule `isSha` enforces for commits applies: a path that starts with a dash
    // reaches `ls-tree` as a FLAG rather than as a directory, and git is very
    // willing to run programs it has been told to. `..` is refused for the
    // ordinary reason — the tree of a project is the project.
    const dir = (path ?? "").replace(/\\/g, "/")
    if (dir.startsWith("-") || dir.split("/").includes("..")) {
      return reply.code(400).send({ message: `${dir} is not a path inside this project` })
    }

    return await readingRepo(project, reply, () => repo.tree(repoOf(project), dir))
  }),
)

// `git/working` and `git/commits/:sha` used to be here, and went with the
// repository browser they were built for — nothing in the web package ever
// called either, and the brief rules out reading a diff outside the
// conversation that produced it. `repo.workingTree` and `repo.commitDetail`
// stay: `pnpm smoke` drives both directly, which is where their behaviour was
// actually pinned even while the routes existed.

// ---------------------------------------------------------------------------
// Conversations
//
// Read straight out of the SDK's own session store, not out of anything aide
// keeps. That is what makes a chat you had in the VS Code extension show up here
// with no import step — and it is why a project's task runs appear alongside its
// chats: both are sessions, told apart by the directory they ran in.
// ---------------------------------------------------------------------------

// These two keep their own `catch` rather than using `readingRepo`, and the
// difference is not cosmetic: what fails here is the SDK's session store, which
// for a remote project is a query over ssh to a different thing entirely. A
// message naming the repository root would point at the wrong object.

app.get(
  "/api/projects/:id/conversations",
  withProject(async (project, _req, reply) => {
    try {
      // The lane is passed in so a chat whose first turn is in flight has a row
      // even before the SDK has indexed a name for it — see the fallback there.
      return await withBookkeeping(project, await listConversations(project, chat))
    } catch (err) {
      return reply.code(502).send({
        message: `could not read the session store: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }),
)

app.get(
  "/api/projects/:id/conversations/:sessionId",
  withProject(async (project, req, reply) => {
    const { sessionId } = req.params as { sessionId: string }
    try {
      const found = await getConversation(project, sessionId, chat)
      if (!found) {
        return reply.code(404).send(notFound(`no conversation ${sessionId} in this project`))
      }
      const [summary] = await withBookkeeping(project, [found.summary])
      return { ...found, summary }
    } catch (err) {
      return reply.code(502).send({
        message: `could not read that conversation: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }),
)

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
 * Note which route the commit hangs off: the PROJECT's, because what it takes is
 * the working tree — see `review.ts` for the wedge that came of hanging it off a
 * conversation instead.
 *
 * There was a companion `…/conversations/:sessionId/diff` here, answering "what
 * did this chat change" from its checkpoint. It went unused: a diff is read in
 * the conversation that produced it, from the transcript, and nothing in the web
 * package ever called the route. `conversationBaseline` and `runChanges` are
 * both still live — the commit gate is their real caller.
 */


/**
 * What the conversation cost and where it went wrong, as one pasteable document.
 *
 * Deliberately unguarded, unlike the commit below. That guard exists because
 * committing underneath a working agent races its next write; reading a profile
 * races nothing, and a turn in flight is exactly when you want to see what the
 * last five did. The renderer reports an unfinished turn as unfinished rather
 * than pretending it ended.
 */
app.get(
  "/api/projects/:id/conversations/:sessionId/profile",
  withProject(async (project, req) => {
    const { sessionId } = req.params as { sessionId: string }
    return await conversationProfile(log, project, sessionId)
  }),
)

/**
 * Start a commit run over a project's working tree.
 *
 * There is no route in front of this any more, and no button in front of a
 * route: aide commits its own work, once per turn, from the idle hook below.
 * Committing takes the working tree — the same list the rail draws — so what an
 * editor changed alongside a turn lands with it; the run, its checks, its
 * message and its sha all stream into the attributed conversation's transcript
 * exactly as the pressed commit's did. The one thing that stayed a button is
 * push, because sending work off the machine is the one irreversible step.
 *
 * One function on purpose: a second, subtly different commit path — one that
 * skipped the gate, or attributed itself differently, or held the lock by
 * another route — would be a second implementation of the one thing in aide
 * that writes to history. It throws what `hold` throws, which is how a caller
 * learns the checkout is busy.
 *
 * `turn` is what the finished turn can lend the message: its summary headline
 * becomes the subject and its prompt's first line the body, with no model call
 * — see `turnCommitMessage`. Null (no turn, or no summary written) falls back
 * to the helper model drafting from the diff.
 */
async function startCommit(opts: {
  project: Project
  sessionId: string | null
  force: boolean
  push: boolean
  turn?: { text: string; headline: string | null } | null
}): Promise<string> {
  const { project, sessionId, force } = opts
  // What the work was asked for, so the drafter can tell intent from incident.
  // The turn's own prompt when there is one; otherwise the conversation's
  // opening message. With no conversation there is no intent to give it, and
  // the diff is the whole of what the drafter has to go on.
  const opening = sessionId
    ? (await listConversations(project)).find((c) => c.sessionId === sessionId)
    : undefined
  // Read on the press rather than cached from when the project was added: the
  // checks live in the repository, so a run that added one has changed the gate
  // it is about to be measured by, and reading a copy from boot would apply the
  // old gate to the diff that changed it.
  //
  // Passed as the READER rather than the answer, for the same reason one step
  // further in: the commit's own repair attempt can edit `.aide/project.md`, so
  // even a read taken on the press is stale by the time the retry runs. See
  // `verify` in `CommitWorkingTreeOptions`.
  const readVerify = async () => (await readProjectDoc(repoOf(project))).verify
  // Before the hold rather than inside the run: it is one more remote read, a
  // commit does not create an upstream so the answer cannot go stale in between,
  // and asking only when the box is ticked keeps it off the path of every commit
  // that is not pushing.
  const hasUpstream = opts.push ? (await repo.pending(repoOf(project))).ahead !== null : false
  // Throws if another conversation holds the checkout, with that conversation's
  // name in it.
  return chat.hold({
    project,
    sessionId,
    text: "committing what is uncommitted",
    model: CONFIG.helperModel,
    work: (run) =>
      commitWorkingTree({
        project,
        sessionId,
        request: opts.turn?.text || (opening?.firstPrompt ?? ""),
        // The turn's own words, when it left any — no model call and no wait.
        message: turnCommitMessage(opts.turn?.headline, opts.turn?.text ?? ""),
        verify: readVerify,
        push: opts.push,
        hasUpstream,
        force,
        // One go at whatever the checks refused, run as a turn in the
        // conversation this commit is attributed to — which is where its
        // reasoning and its diff have to be readable, and the only place there
        // is to put them. A commit pressed with no chat open gets no attempt
        // and refuses exactly as it always did.
        //
        // `run.runId` rather than a fresh one: it keeps the fix inside the run
        // the browser is already watching, and inside the lock, so nothing can
        // be admitted into the checkout between the failure and the retry.
        //
        // Effort is not read from anywhere. There is nowhere honest to read it
        // from — it is a per-turn choice in the composer, not conversation
        // state — and `high` is what that composer defaults to.
        repair: sessionId
          ? (request) =>
              chat.turnUnderHold({
                runId: run.runId,
                project,
                sessionId,
                text: request,
                effort: "high",
              })
          : null,
        emit: run.emit,
        delta: run.delta,
        stopped: run.stopped,
      }).then(
        (spent) => {
          // A landed commit means the tree's dirt (if any is left) is nobody's
          // leftover — the next turn's pre-sweep may treat it as manual edits.
          void chat.clearRedGate(project.id)
          return spent
        },
        (err: unknown) => {
          // A refused gate leaves the tree dirty ON PURPOSE, as the failure the
          // conversation was handed. Marking it is what stops the next turn's
          // pre-sweep committing that tree as "manual edits" — see `#redGates`
          // in chat.ts. The run id names the refusing commit in `board.json`.
          if (err instanceof VerifyFailed) void chat.noteRedGate(project.id, run.runId)
          throw err
        },
      ),
  })
}

/**
 * The escape hatch: force a commit over a red gate, API only.
 *
 * A gate that fails twice leaves the tree dirty on purpose, and with no commit
 * button there is no UI way past it — which is right as the default (fix the
 * code) and a trap as an absolute (a pre-existing failure, a check that cannot
 * pass on this machine). So the route exists and the button does not: reachable
 * by `pnpm commit-force <project>` or curl, never drawn, and refused without
 * the explicit `?force=true` so nothing can wander into it by posting to a
 * remembered URL. The subject gets a `WIP:` prefix when a check actually
 * failed — see `commitWorkingTree` — so the red state is visible in `git log`.
 *
 * The checks still RUN (force means "land it anyway", not "don't tell me");
 * what is skipped is the refusal and the repair attempt.
 */
app.post(
  "/api/projects/:id/commit",
  withProject(async (project, req, reply) => {
    if ((req.query as { force?: unknown } | null)?.force !== "true") {
      return reply.code(400).send({
        message:
          "commits are automatic — aide commits each turn's work itself. This route is " +
          "the force-only escape hatch and requires ?force=true.",
      })
    }
    const body = (req.body ?? {}) as { sessionId?: unknown }
    const sessionId = typeof body.sessionId === "string" && body.sessionId ? body.sessionId : null
    try {
      const runId = await startCommit({ project, sessionId, force: true, push: false })
      return { runId }
    } catch (err) {
      return reply.code(409).send({ message: err instanceof Error ? err.message : String(err) })
    }
  }),
)

/**
 * Commit each turn's work as the turn finishes. Not a setting — the only path.
 *
 * Registered on the lane rather than polled, and it runs AFTER the turn has let
 * go of the checkout — see `onProjectIdle`, which is only called for a chat turn
 * ending, so a commit cannot trigger another one. There is no button, and the
 * only route is the force-only escape hatch above; the human's one remaining
 * git control is push.
 *
 * Everything it skips is deliberate. It never pushes: sending work off the
 * machine is the one irreversible step, and it stays a press. It never forces: a
 * tree that fails its checks gets the one repair attempt and then stays dirty,
 * with the failure written into the transcript — the brief's
 * one-attempt-then-a-person rule is not about who pressed the button, and a red
 * commit in history would be worse than no commit. And it does not tick the
 * chat off — that is the second gate, and it is yours.
 *
 * Failures are swallowed to a log line. The turn already succeeded; the tree is
 * still dirty, the rail still says so, and the next turn to end tries again.
 */
chat.onProjectIdle = (projectId, sessionId, turn) => {
  void (async () => {
    try {
      const project = await getProject(projectId)
      if (!project) return
      // Nothing to commit is the common case — most turns are questions. Asked
      // before taking the lock so a read-only turn costs one `git status` rather
      // than a run somebody has to watch start and stop.
      const pending = await repo.pending(repoOf(project))
      if (pending.files.length === 0) return
      await startCommit({ project, sessionId, force: false, push: false, turn })
    } catch (err) {
      // Including `hold` refusing because something else took the checkout in
      // the moment between the release and here. That is a race with a correct
      // outcome — the other thing is working, and the next turn to end will find
      // the same uncommitted tree and try again.
      app.log.warn({ err, projectId }, "auto-commit did not start")
    }
  })()
}

/**
 * Send the branch upstream. The second half of the commit button, on its own.
 *
 * Separate from the commit route rather than only a flag on it, because the two
 * are separate acts and the common case for this one is a commit that already
 * happened — the checkbox was not ticked, or the push failed, or the work was
 * committed before there was a remote. A button that can only push as part of
 * committing cannot clear either of those.
 *
 * Under the project's lock like a commit, and for the same reason: pushing while
 * an agent writes would send a branch whose tip is about to move. It is NOT a
 * run — there is no transcript worth writing for one git call, no model, and
 * nothing to attribute — so it answers synchronously with what it did.
 */
app.post(
  "/api/projects/:id/push",
  withProject(async (project, req, reply) => {
    const holder = chat.holderFor(project.id)
    if (holder) {
      return reply.code(409).send({
        message: `"${firstLine(holder.text)}" is working in this checkout — wait for it to finish`,
      })
    }

    // Fold the auto-commits into one commit before sending. The moment of the
    // push is where that choice belongs: the per-turn commits are the local
    // record, and whether upstream wants the steps or the change is decided by
    // whoever presses this. Only meaningful with an upstream to measure against
    // — a branch being published has nothing to squash to, so the flag is
    // quietly a plain publish there rather than a refusal.
    const squash = (req.body as { squash?: unknown } | null)?.squash === true

    try {
      const { ahead } = await repo.pending(repoOf(project))
      if (squash && ahead !== null) {
        const { branch, pushed, squashed } = await squashAndPush(repoOf(project))
        return { branch, pushed, squashed }
      }
      const { branch, pushed } = await pushBranch(repoOf(project), ahead !== null)
      return { branch, pushed }
    } catch (err) {
      // 502 rather than 500: the failure is almost always the remote saying no —
      // a non-fast-forward, no network, no permission — and the message git wrote
      // is the only useful thing anybody can act on.
      return reply.code(502).send({ message: err instanceof Error ? err.message : String(err) })
    }
  }),
)

/**
 * Done. The one thing in this product an agent cannot reach.
 *
 * A toggle rather than a verdict: the states worth telling apart are "this
 * served its purpose" and "not yet", and the transcript already says everything
 * a third one would have. Nothing is removed by it — the conversation is the
 * record — so `reopen` below genuinely undoes it.
 */
app.post(
  "/api/projects/:id/conversations/:sessionId/close",
  withProject(async (project, req) => {
    const { sessionId } = req.params as { sessionId: string }
    return await closeChat(project, sessionId)
  }),
)

app.post(
  "/api/projects/:id/conversations/:sessionId/reopen",
  withProject(async (project, req, reply) => {
    const { sessionId } = req.params as { sessionId: string }
    await reopenChat(project, sessionId)
    return reply.code(204).send()
  }),
)

/**
 * Send a message. `sessionId` may be null, which starts a new conversation.
 *
 * Returns as soon as the turn is admitted, with a runId to subscribe to — the
 * answer arrives on the event stream, not in this response.
 */
app.post(
  "/api/projects/:id/chat",
  withProject(async (project, req, reply) => {
    const body = (req.body ?? {}) as {
      sessionId?: string | null
      text?: string
      attachments?: Attachment[]
      mode?: string
      effort?: string
      thinking?: boolean
      model?: string
    }
    if (!body.text?.trim() && !body.attachments?.length) {
      return reply.code(400).send({ message: "nothing to send" })
    }


    // A dirty tree no longer refuses a new conversation. It used to — a chat's
    // diff is measured against a checkpoint, and uncommitted work becomes its
    // baseline — but the way out was the commit button, and the button is gone:
    // commits are automatic, once per turn, and a tree dirtied by an editor is
    // swept into the next turn's commit rather than cleared by a press. Keeping
    // the refusal without its release would be the wedge the brief warns about,
    // built on purpose. The cost is honest and small: a chat started over a
    // dirty tree may show the human's own edits as `mixed` in its diff, and the
    // checkpoint still recovers everything either way.

    // Validated rather than cast: these come from a form, and an unknown mode
    // would otherwise reach the SDK as an undefined permission mode.
    //
    // The fallback is the narrower of the two, and that is the point of having
    // one. A page that has not reloaded since Manual was removed still sends it,
    // and the human at that page believes they will be asked before anything
    // happens — answering that with Auto would be the one surprise here that costs
    // something. Plan surprises them with a plan.
    const mode = (CHAT_MODES as readonly string[]).includes(body.mode ?? "")
      ? (body.mode as ChatMode)
      : "plan"
    const effort = (EFFORT_LEVELS as readonly string[]).includes(body.effort ?? "")
      ? (body.effort as EffortLevel)
      : "high"
    // An unrecognised id is dropped rather than refused, and the turn goes out
    // on the daemon's default. Refusing would be the stricter answer and the
    // wrong one: this is a page that may be older than the list — a model
    // retired between the tab loading and the send — and the cost of that is a
    // turn on Opus rather than a red line over a message somebody has typed.
    // The composer only ever offers ids from `CHAT_MODELS`, so this is the
    // stale-tab case rather than a typo, which is why there is no free-text box.
    const model = isChatModel(body.model) ? body.model : undefined
    // Only an explicit `false` turns it off. A page that has not reloaded since
    // the toggle existed sends nothing, and the answer for it is the behaviour it
    // has always had — thinking on — rather than a silent downgrade of every turn
    // sent from an old tab.
    const thinking = body.thinking !== false

    try {
      const runId = await chat.send({
        project,
        sessionId: body.sessionId ?? null,
        text: body.text?.trim() ?? "",
        attachments: body.attachments ?? [],
        mode,
        effort,
        thinking,
        // Spread, so an unrecognised or absent id leaves the field off entirely
        // rather than sending an explicit `undefined` — `SendOptions.model` is
        // optional and "not chosen" is the state it is optional for.
        ...(model ? { model } : {}),
      })
      return { runId }
    } catch (err) {
      return reply.code(409).send({ message: err instanceof Error ? err.message : String(err) })
    }
  }),
)

/**
 * A short name for a chat that has not started.
 *
 * The SDK names a session on its first turn, which names the chats you have
 * already spent money on and leaves the backlog — the rows you actually have to
 * find again — showing the first line of whatever you typed. This names one at
 * the moment it is written instead.
 *
 * Not a project's route and not a conversation's: there is no conversation yet
 * and nothing here reads the repository. It is one prompt in, one line out, so
 * it is also the one model call in aide that takes no lock and can happen while
 * an agent has the checkout — parking an idea must never wait on a run.
 *
 * A failure is a 502 rather than a 500 because the failure is always the model
 * call: the caller has nothing to fix, and the row it wanted a name for is fine
 * without one.
 */
app.post("/api/chat-name", async (req, reply) => {
  const { text } = (req.body ?? {}) as { text?: string }
  if (!text?.trim()) return reply.code(400).send({ message: "nothing to name" })
  try {
    return { title: await nameChat({ model: CONFIG.helperModel, text: text.trim() }) }
  } catch (err) {
    return reply.code(502).send({ message: err instanceof Error ? err.message : String(err) })
  }
})

/**
 * Which conversation a run's first turn became, and whether it is over.
 *
 * The browser's one blind spot. A new chat has no session id until the SDK
 * assigns one a second or two into its first turn, and that name is announced
 * exactly once — `run.started`, on that run's live stream. A page that has moved
 * on by then never hears it, and the unsent record that WAS the chat is
 * stranded. This is how it catches up, out of the log, which is where the name
 * was written down.
 *
 * `ended` is the other half, and it is the half that stops the asking: a turn
 * that died before the SDK named anything never will, and a caller polling for a
 * name that is not coming would poll for as long as the tab is open.
 */
app.get("/api/runs/:runId/session", async (req, reply) => {
  const { runId } = req.params as { runId: string }
  // Checked rather than trusted, because it goes into a filename. Run ids are
  // `randomUUID`s; anything else is a caller building a path, not asking about a
  // run — and the log directory sits in the home folder, not in a repository.
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(runId)) {
    return reply.code(400).send({ message: `${runId} is not a run id` })
  }
  const path = runLogPath(runId)
  // A log that is not there counts as ended. Nothing is going to name a run
  // nobody wrote, and the caller is asking precisely so it can stop waiting.
  if (!existsSync(path)) return { sessionId: null, ended: true }
  const [named, terminal] = await Promise.all([sessionOfRun(path), terminalEvent(path)])
  return { sessionId: named?.sessionId ?? null, ended: terminal !== null }
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