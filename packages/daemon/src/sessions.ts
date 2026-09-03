/**
 * Reading Claude sessions off disk.
 *
 * The third and last file that imports the Agent SDK. `agent.ts` runs sessions,
 * `helper.ts` makes one-shot calls, this one reads sessions the SDK already
 * wrote. It deliberately does NOT interpret SDK messages itself — that stays in
 * `normalizeSdkMessage`, so the union has one reader.
 *
 * Nothing here is aide's own storage. `~/.claude/projects/<encoded-dir>/` is the
 * SDK's session store, shared with the Claude Code CLI and the VS Code
 * extension, which is why a chat you had in VS Code appears in aide with no
 * import step — and why deleting one here would delete it there.
 *
 * That store is on the machine that RAN the agent, which for a remote project is
 * not this one. The SDK's readers take a directory and read it locally, so they
 * cannot be pointed at another host — `listSessions({ dir })` for a Linux root
 * found no directory at all here and answered with an empty list, which the UI
 * drew as a project with no conversations while a 1.2MB transcript sat intact on
 * the far side. So a remote project asks `aide-agent` instead; see
 * `remoteQuery`.
 */
import { execFile } from "node:child_process"
import { open, readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, relative } from "node:path"
import { promisify } from "node:util"
import { getSessionMessages, listSessions } from "@anthropic-ai/claude-agent-sdk"
import type { ChatMode, ConversationSummary, Project, RunEvent } from "@aide/protocol"
import { STATE_DIR, chatModeFromSdk } from "@aide/protocol"
import { sshConfigPath } from "@aide/protocol/node"
import { normalizeSdkMessage } from "./agent.js"

const run = promisify(execFile)

/** Where `deploy-agent` puts it. Matches `REMOTE_AGENT` in `chat.ts`. */
const REMOTE_AGENT = process.env["AIDE_REMOTE_AGENT"] ?? "$HOME/.aide/agent/aide-agent"

/**
 * How long a remote session read may take.
 *
 * Same reasoning as `REMOTE_GIT_TIMEOUT_MS` in `git.ts`, and the same failure it
 * prevents: this is called from an HTTP handler the browser polls, so a hang
 * here is a pane that never fills and a request that never returns. Shorter than
 * git's 90s because this reads a directory listing, not a tree.
 */
const REMOTE_SESSION_TIMEOUT_MS = 30_000

/**
 * How long a remote answer is reused.
 *
 * Only remote reads are cached, because only they are slow: the local SDK call
 * is a directory read at single-digit milliseconds and a cache in front of it
 * would add a staleness bug to buy nothing. Measured against `tg`: 6.5s to list
 * a project's conversations, 9.8s to open a 1.2MB transcript, essentially all of
 * it the ssh connection and the transfer.
 *
 * Sixty seconds is long because the invalidation below, not the clock, is what
 * makes this correct. Everything that CHANGES a conversation goes through this
 * daemon — a turn finishing, a chat being ticked off — so those drop the entry
 * outright and the next read is fresh. The TTL is only a backstop for the one
 * writer aide does not see: somebody running `claude` in a terminal on the far
 * machine. A minute of staleness for that case, against a 6.5s wait on every
 * project switch, is the trade.
 */
const REMOTE_CACHE_MS = 60_000

/**
 * Remote answers, keyed by what was asked.
 *
 * The PROMISE is stored, not the result, and that is the half that matters most
 * on a slow read: two requests arriving three seconds apart — the browser
 * refetching while the first is still in flight — share one ssh connection
 * instead of opening a second. Connections are a budget here, not just a
 * latency; see the `MaxStartups` note in CLAUDE.md.
 *
 * A rejected promise is evicted rather than cached, or one unreachable moment
 * would be replayed as an error for a full minute after the host came back.
 */
const remoteCache = new Map<string, { at: number; value: Promise<unknown> }>()

/**
 * Forget what was read for a project, so the next read goes to the machine.
 *
 * Called wherever aide itself changes a conversation. Without it the cache would
 * be a plain TTL, which is wrong in the precise case the UI cares about: the
 * chat list refetches BECAUSE a turn just finished, and serving that request a
 * cached list from before the turn shows the user a stale row at the one moment
 * they are looking for a fresh one.
 *
 * Takes the project id and clears every entry for it — list and transcripts
 * alike — because a finished turn changes both and the id is what every caller
 * has to hand.
 */
export function forgetConversations(projectId: string): void {
  for (const key of remoteCache.keys()) {
    if (key.startsWith(`${projectId} `)) remoteCache.delete(key)
  }
}

/** A cached remote read. `key` must identify the question, not just the host. */
async function cachedRemote<T>(key: string, read: () => Promise<T>): Promise<T> {
  const hit = remoteCache.get(key)
  if (hit && Date.now() - hit.at < REMOTE_CACHE_MS) return hit.value as Promise<T>

  const value = read()
  remoteCache.set(key, { at: Date.now(), value })
  // Evicted on failure, so an error is never served from cache — and evicted
  // only if this entry is still the current one, or a retry that has already
  // replaced it would be thrown away by its predecessor's rejection.
  value.catch(() => {
    if (remoteCache.get(key)?.value === value) remoteCache.delete(key)
  })
  return value
}

/**
 * Ask `aide-agent` on the far side to read its own session store.
 *
 * One ssh call that answers and exits, deliberately NOT a message on the
 * `ToWorker` protocol: that protocol describes a live conversation holding the
 * project's lock, and this is a stateless read that has to work when no agent is
 * running at all. Shaped like `gitBatch` and `readRepoFile` instead.
 *
 * Throws with the host named, because the two failures a caller must tell apart
 * are "this project has no conversations" and "aide could not reach the machine
 * that has them" — and an empty list for the second is exactly the bug this
 * function exists to fix, one hop further out.
 */
async function remoteQuery<T>(host: string, args: string[]): Promise<T> {
  const command = [REMOTE_AGENT, ...args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`)].join(" ")
  let stdout: string
  try {
    ;({ stdout } = await run(
      "ssh",
      ["-o", "BatchMode=yes", "-F", sshConfigPath(), host, command],
      { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: REMOTE_SESSION_TIMEOUT_MS },
    ))
  } catch (err) {
    const e = err as { stderr?: string; killed?: boolean }
    if (e.killed) throw new Error(`${host} did not answer in ${REMOTE_SESSION_TIMEOUT_MS / 1000}s`)
    const detail = (e.stderr ?? "").trim()
    // A missing agent is the one failure with an obvious next step, and it is
    // likely: a machine can be added as a project before it is deployed to.
    if (/not found|No such file/i.test(detail)) {
      throw new Error(`${host} has no aide-agent — run \`pnpm deploy-agent ${host}\``)
    }
    throw new Error(detail || `could not read conversations from ${host}`)
  }

  let parsed: T & { error?: string }
  try {
    parsed = JSON.parse(stdout) as T & { error?: string }
  } catch {
    // stdout is one JSON document by contract. Anything else means something
    // wrote to it that should not have — the exact corruption `stdio.ts`
    // reassigns `console.log` to prevent — so show a slice rather than a bare
    // "unexpected token".
    throw new Error(`${host} answered with something that is not JSON: ${stdout.slice(0, 200)}`)
  }
  if (parsed.error) throw new Error(`${host}: ${parsed.error}`)
  return parsed
}

/**
 * A transcript this long is already unreadable, and the JSONL behind it can be
 * several megabytes. Cap the read rather than the response size so the number
 * shown to the user ("1200 of 4000 messages") means something.
 */
const MAX_MESSAGES = 1_500

/**
 * The backwards scan for the mode a conversation was last driven at.
 *
 * The mode is stamped on every user turn, so the last one is a single assistant
 * turn from the end — but that turn carries its tool results, and one session
 * here put 363KB between the last stamp and EOF. Any fixed tail is therefore a
 * guess that silently returns "unknown" on exactly the long, busy conversations
 * where getting the mode right matters most, so this walks backwards a window at
 * a time and stops at the first window with a hit. Almost always that is the
 * first one; the budget bounds the pathological case.
 */
/** Enough of the front of a transcript to carry its opening turn. */
const HEAD_BYTES = 64 * 1024

const MODE_WINDOW_BYTES = 512 * 1024
const MODE_MAX_SCAN_BYTES = 8 * 1024 * 1024
/** Enough to cover the pattern straddling a window boundary. */
const MODE_OVERLAP_BYTES = 256

const PERMISSION_MODE = /"permissionMode"\s*:\s*"([a-zA-Z]+)"/g

/** `.aide/worktrees/task-0004` anywhere in the path means this ran for a task. */
const TASK_CWD = new RegExp(`${STATE_DIR}[\\\\/]worktrees[\\\\/]task-(\\d+)`, "i")

/**
 * History only, and kept for exactly that reason.
 *
 * Nothing aide runs can produce a `task` any more — every conversation runs in
 * the project root now, so every NEW session classifies as a chat. But the
 * session store is on disk and shared with the CLI, and it still holds the runs
 * that happened back when a task meant a worktree. Deleting this would not
 * simplify anything; it would relabel those old transcripts as something they
 * were not.
 */
function classify(cwd: string): { kind: ConversationSummary["kind"]; taskId: string | null } {
  const hit = TASK_CWD.exec(cwd)
  return hit?.[1] ? { kind: "task", taskId: hit[1] } : { kind: "chat", taskId: null }
}

/**
 * Every conversation that belongs to a project.
 *
 * `includeWorktrees` is left at its default of true on purpose. It is what folds
 * a project's task runs in beside its chats — they are the same kind of object,
 * and hiding the runs would mean aide could not show you the transcript of work
 * it did itself.
 *
 * `includeProgrammatic` likewise: the SDK's own docs say IDE session pickers
 * pass false "for parity with terminal /resume", which would hide every session
 * aide created, since aide is a programmatic consumer.
 */
export async function listConversations(
  project: Project,
  /** The lock. Injected so this file stays a reader of the session store. */
  live: LiveChats = NO_TURNS,
): Promise<ConversationSummary[]> {
  // The far side's store for a remote project, this machine's for a local one.
  // Same shape either way — it is the same SDK call, just executed where the
  // files are.
  const sessions = project.host
    ? (
        await cachedRemote(`${project.id} list`, () =>
          remoteQuery<{ sessions: Awaited<ReturnType<typeof listSessions>> }>(project.host!, [
            "--sessions",
            project.root,
          ]),
        )
      ).sessions
    : await listSessions({ dir: project.root })

  const rows: ConversationSummary[] = sessions
    .map((s) => {
      const cwd = s.cwd ?? project.root
      const { kind, taskId } = classify(cwd)
      return {
        sessionId: s.sessionId,
        kind,
        taskId,
        title: s.customTitle ?? s.summary ?? firstLine(s.firstPrompt ?? "") ?? "(untitled)",
        firstPrompt: s.firstPrompt ?? "",
        cwd,
        gitBranch: s.gitBranch ?? null,
        lastModified: s.lastModified,
        createdAt: s.createdAt ?? null,
        bytes: s.fileSize ?? 0,
        activeRunId: live.turnForSession(s.sessionId)?.runId ?? null,
        // Left null for the list. Filling it here would mean a file read per
        // conversation on every poll, to answer a question only the open
        // conversation asks; `getConversation` fills it for that one.
        lastMode: null,
      } satisfies ConversationSummary
    })

  // A conversation the daemon is running must not be MISSING from the list of
  // conversations, for the same reason it must not 404 — see `liveSummary`.
  //
  // `listSessions` drops any session it cannot name yet, and the browser asks
  // for this list exactly once per new chat: the moment `run.started` announces
  // the session id, which is about 64ms BEFORE the SDK has written the
  // transcript that would name it. Lose that race and the chat being watched has
  // no row in the list and nothing selected — for the rest of the turn, because
  // the list is fetched on things you did rather than on a beat, and the next
  // thing that asks is the run ending.
  const holder = live.holderFor(project.id)
  const running = holder?.sessionId ? liveSummary(project, holder.sessionId, holder) : null
  if (running && !rows.some((c) => c.sessionId === running.sessionId)) rows.push(running)

  return rows.sort((a, b) => b.lastModified - a.lastModified)
}

export async function getConversation(
  project: Project,
  sessionId: string,
  live: LiveChats = NO_TURNS,
): Promise<{ summary: ConversationSummary; events: RunEvent[]; truncated: boolean; totalMessages: number } | null> {
  const listed = (await listConversations(project, live)).find((c) => c.sessionId === sessionId)
  // Neither absent from the listing nor absent from disk means it does not
  // exist — see summaryFromFile and liveSummary.
  const summary =
    listed ??
    (await summaryFromFile(project, sessionId, live)) ??
    liveSummary(project, sessionId, live.turnForSession(sessionId))
  if (!summary) return null

  const messages = project.host
    ? (
        await cachedRemote(`${project.id} session ${sessionId}`, () =>
          remoteQuery<{ messages: Awaited<ReturnType<typeof getSessionMessages>> }>(project.host!, [
            "--session",
            project.root,
            sessionId,
          ]),
        )
      ).messages
    : await getSessionMessages(sessionId, { dir: project.root })
  // The TAIL, not the head. Slicing from the front served the oldest 1500
  // messages of a long conversation and hid everything recent — the exact
  // opposite of what anyone opening it wants to read.
  const capped = messages.slice(-MAX_MESSAGES)

  const events: RunEvent[] = []
  let seq = 0
  for (const message of capped) {
    // The session file stores the message under `message` with the envelope
    // around it; normalizeSdkMessage expects the envelope, which is what a
    // SessionMessage already is.
    for (const body of normalizeSdkMessage(message, {
      projectId: project.id,
      cwd: summary.cwd,
      fallbackModel: "",
    })) {
      seq += 1
      // `ts` is not in the session envelope, so ordering carries the time
      // information and the UI must not present these as wall-clock stamps.
      events.push({ ...body, runId: sessionId, seq, ts: 0 } as RunEvent)
    }
  }

  return {
    summary: { ...summary, lastMode: await sessionMode(sessionId) },
    events,
    truncated: messages.length > capped.length,
    totalMessages: messages.length,
  }
}

/** What the daemon knows about a turn it is running right now. */
export interface LiveTurn {
  runId: string
  projectId: string
  /** null until the SDK reports one — a brand new conversation has no id yet. */
  sessionId: string | null
  startedAt: number
  /** The message that opened the turn. */
  text: string
  /** A tool call is waiting on a human. The only thing that is stopped ON you. */
  blocked: boolean
}

/**
 * The lock, as the readers see it.
 *
 * One interface rather than the three closures this used to be handed — a
 * `runId` getter for the summary, a whole turn for the not-on-disk fallback, and
 * a `{working, blocked}` projection for the board. All three were `turnForSession`
 * with different fields dropped, so the type they need is the lane's own pair of
 * questions: which turn belongs to a conversation, and which one holds a project.
 *
 * It matters that this is ONE object rather than three arguments. Every reader
 * here answers from the lock, and the brief's wedge is a gate whose precondition
 * and whose release read different objects; three closures over one Map is that
 * shape in miniature, and it is exactly the shape that lets two of them be
 * updated and the third forgotten. `ChatLane` satisfies this directly, so there
 * is nothing to keep in step.
 *
 * `NO_TURNS` is the reader for a caller that has no lane — the tests, and
 * `getConversation`'s own internal listing, which wants the rows and not the
 * liveness.
 */
export interface LiveChats {
  /** The turn in flight for a conversation, or null if it is not running. */
  turnForSession(sessionId: string): LiveTurn | null
  /** The turn holding a project's checkout, or null if it is free. */
  holderFor(projectId: string): LiveTurn | null
}

export const NO_TURNS: LiveChats = {
  turnForSession: () => null,
  holderFor: () => null,
}

/**
 * A summary for a conversation that is not on disk at all yet.
 *
 * The last resort, and the one that actually matters for a new chat. Measured:
 * `run.started` carries the session id to the browser about 64ms before the SDK
 * has created the transcript file, and the browser follows it to the new URL
 * immediately. So for that window there is no listing row AND no file — nothing
 * to read, however patiently you read it.
 *
 * But the daemon is not guessing here: it started this turn and is supervising
 * the process running it. A conversation it is actively serving is the last
 * thing that should 404, which is what put "no conversation <id> in this
 * project" in red over a chat that was busy answering.
 *
 * The events are empty on purpose. The live stream is already delivering them;
 * this only has to say the conversation exists and what it is called.
 */
function liveSummary(
  project: Project,
  sessionId: string,
  turn: LiveTurn | null,
): ConversationSummary | null {
  // Scoped by project like every other path here: a turn running for one project
  // must not answer through another project's URL.
  if (!turn || turn.projectId !== project.id) return null
  return {
    sessionId,
    // A chat runs in the project root by definition — that is what makes it a
    // chat rather than a task — so this is not an assumption about the cwd.
    kind: "chat",
    taskId: null,
    title: firstLine(turn.text) ?? "(new conversation)",
    firstPrompt: turn.text,
    cwd: project.root,
    gitBranch: null,
    lastModified: turn.startedAt,
    createdAt: turn.startedAt,
    bytes: 0,
    activeRunId: turn.runId,
    lastMode: null,
  }
}

/**
 * A summary for a conversation `listSessions` will not return.
 *
 * The SDK drops any session it cannot name. In sdk.mjs the row is built as
 * `customTitle || aiTitle || lastPrompt || summaryHint || firstPrompt`, and then
 * `if (!s) return null` — so a session with no title yet is ABSENT from the
 * listing rather than merely stale in it.
 *
 * Which makes a brand-new chat invisible for the window between its first turn
 * starting and its prompt being indexed. That window is precisely when the
 * browser follows `run.started` to the conversation's new URL and asks for it,
 * so "no conversation <id> in this project" landed in red over a chat that was
 * working perfectly. A session that never gets a nameable prompt — an
 * image-only opener, say — would have stayed invisible for good.
 *
 * Looking it up through the listing was the mistake: reading the transcript
 * never needed the index, so neither does finding it.
 *
 * LOCAL only, and it degrades rather than lying: `findSessionFile` scans this
 * machine's store, so for a remote project it finds nothing and the caller falls
 * through to `liveSummary` — which covers the same window, because the only way
 * to reach an unnameable remote session is to have just started it here. What is
 * lost is the narrower case of an unnameable session with no live turn, which
 * would need another round trip to the far side to answer and is not worth one
 * on a path the browser polls.
 */
async function summaryFromFile(
  project: Project,
  sessionId: string,
  live: LiveChats,
): Promise<ConversationSummary | null> {
  const file = await findSessionFile(sessionId)
  if (!file) return null

  let head: Awaited<ReturnType<typeof readSessionHead>>
  let size = 0
  let mtime = 0
  try {
    const info = await stat(file)
    size = info.size
    mtime = info.mtimeMs
    head = await readSessionHead(file)
  } catch {
    return null
  }
  if (!head) return null

  // findSessionFile searches every project directory, because the session id is
  // the only stable handle. So the project this was asked through has to be the
  // project it actually belongs to, or one project's URL would read another's
  // conversations — the listing is scoped by `dir` and this must be too.
  //
  // An unreadable cwd is a refusal, NOT a default of project.root. Defaulting
  // was tested and let a session through from a project it did not belong to:
  // the check compares the cwd against project.root, so filling the cwd IN from
  // project.root makes it compare the root to itself and pass for everyone.
  if (!head.cwd) return null
  const within = relative(project.root, head.cwd)
  if (within.startsWith("..") || isAbsolute(within)) return null

  const { kind, taskId } = classify(head.cwd)
  return {
    sessionId,
    kind,
    taskId,
    title: firstLine(head.firstPrompt) ?? "(untitled)",
    firstPrompt: head.firstPrompt,
    cwd: head.cwd,
    gitBranch: head.gitBranch,
    lastModified: mtime,
    createdAt: head.createdAt,
    bytes: size,
    activeRunId: live.turnForSession(sessionId)?.runId ?? null,
    lastMode: null,
  }
}

/**
 * The few facts a summary needs, from the front of the transcript.
 *
 * Deliberately shallow: enough lines to find the opening user turn, and a
 * tolerant read of it. Anything malformed is skipped rather than thrown on,
 * because this runs precisely when the file is being written.
 */
async function readSessionHead(
  file: string,
): Promise<{ cwd: string | null; gitBranch: string | null; createdAt: number | null; firstPrompt: string } | null> {
  const handle = await open(file, "r")
  try {
    const buffer = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0)
    const out = { cwd: null as string | null, gitBranch: null as string | null, createdAt: null as number | null, firstPrompt: "" }
    // The last line of the window is very likely truncated; dropping it is
    // simpler than trying to tell a partial write from a whole one.
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n").slice(0, -1)
    for (const line of lines) {
      let record: Record<string, unknown>
      try {
        record = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      if (out.cwd === null && typeof record["cwd"] === "string") out.cwd = record["cwd"]
      if (out.gitBranch === null && typeof record["gitBranch"] === "string") {
        out.gitBranch = record["gitBranch"]
      }
      if (out.createdAt === null && typeof record["timestamp"] === "string") {
        const at = Date.parse(record["timestamp"])
        if (!Number.isNaN(at)) out.createdAt = at
      }
      if (!out.firstPrompt && record["type"] === "user") out.firstPrompt = userText(record["message"])
    }
    return out
  } finally {
    await handle.close()
  }
}

/** The text of a user turn, whichever of the two shapes it arrived in. */
function userText(message: unknown): string {
  if (typeof message !== "object" || message === null) return ""
  const content = (message as { content?: unknown }).content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  for (const part of content) {
    if (typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text") {
      const text = (part as { text?: unknown }).text
      if (typeof text === "string" && text.trim()) return text
    }
  }
  return ""
}

/**
 * The mode the conversation was last driven at, read from the raw JSONL.
 *
 * The SDK's own reader drops this: `permissionMode` is on every user record on
 * disk, but `SessionMessage` does not carry it. So this is the one place aide
 * reads the session store directly rather than through the SDK — deliberately
 * narrow, one undocumented field, and every failure returns null.
 *
 * That null matters. This is inherited state feeding a permission mode, so
 * anything unreadable, unrecognised, or from a future SDK must mean "no
 * opinion" and leave the human's own choice standing.
 */
async function sessionMode(sessionId: string): Promise<ChatMode | null> {
  const file = await findSessionFile(sessionId)
  if (!file) return null
  try {
    const handle = await open(file, "r")
    try {
      const { size } = await handle.stat()
      const floor = Math.max(0, size - MODE_MAX_SCAN_BYTES)
      let end = size
      while (end > floor) {
        const start = Math.max(floor, end - MODE_WINDOW_BYTES)
        const length = end - start
        const buffer = Buffer.alloc(length)
        await handle.read(buffer, 0, length, start)
        // The last match in the window wins: scanning forward and keeping the
        // final hit is simpler than reversing a regex, and the window is capped.
        // Slicing on byte boundaries can split a multi-byte character, which is
        // harmless — the pattern is ASCII, and the overlap covers a split across
        // the boundary itself.
        let last: string | null = null
        for (const hit of buffer.toString("utf8").matchAll(PERMISSION_MODE)) last = hit[1] ?? null
        if (last !== null) return chatModeFromSdk(last)
        if (start === floor) break
        end = start + MODE_OVERLAP_BYTES
      }
      return null
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

/**
 * Locate `<sessionId>.jsonl` under `~/.claude/projects/`.
 *
 * By scanning rather than by encoding the project path into a directory name —
 * that encoding is the SDK's, undocumented, and getting it subtly wrong would
 * fail silently. The session id IS the filename, which is the stable part.
 */
async function findSessionFile(sessionId: string): Promise<string | null> {
  // A session id reaches this from a URL and is about to become a path
  // component, so anything that is not the UUID shape it should be is refused
  // rather than joined.
  if (!/^[0-9a-fA-F-]{36}$/.test(sessionId)) return null
  const root = join(homedir(), ".claude", "projects")
  let dirs: string[]
  try {
    dirs = await readdir(root)
  } catch {
    return null
  }
  for (const dir of dirs) {
    const candidate = join(root, dir, `${sessionId}.jsonl`)
    try {
      if ((await stat(candidate)).isFile()) return candidate
    } catch {
      // Not in this project directory. Keep looking.
    }
  }
  return null
}

function firstLine(s: string): string | null {
  const line = s.split("\n").find((l) => l.trim())
  if (!line) return null
  return line.length > 80 ? `${line.slice(0, 80)}…` : line
}
