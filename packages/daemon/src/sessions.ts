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
 */
import { open, readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, relative } from "node:path"
import { getSessionMessages, listSessions } from "@anthropic-ai/claude-agent-sdk"
import type { ChatMode, ConversationSummary, Project, RunEvent } from "@aide/protocol"
import { STATE_DIR, chatModeFromSdk } from "@aide/protocol"
import { normalizeSdkMessage } from "./agent.js"

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
  /** Which conversations have a turn in flight. Injected so this file stays a reader. */
  activeRunFor: (sessionId: string) => string | null = () => null,
): Promise<ConversationSummary[]> {
  const sessions = await listSessions({ dir: project.root })

  return sessions
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
        activeRunId: activeRunFor(s.sessionId),
        // Left null for the list. Filling it here would mean a file read per
        // conversation on every poll, to answer a question only the open
        // conversation asks; `getConversation` fills it for that one.
        lastMode: null,
      } satisfies ConversationSummary
    })
    .sort((a, b) => b.lastModified - a.lastModified)
}

export async function getConversation(
  project: Project,
  sessionId: string,
  activeRunFor: (sessionId: string) => string | null = () => null,
): Promise<{ summary: ConversationSummary; events: RunEvent[]; truncated: boolean; totalMessages: number } | null> {
  const listed = (await listConversations(project, activeRunFor)).find(
    (c) => c.sessionId === sessionId,
  )
  // Not in the listing is not the same as not existing — see summaryFromFile.
  const summary = listed ?? (await summaryFromFile(project, sessionId, activeRunFor))
  if (!summary) return null

  const messages = await getSessionMessages(sessionId, { dir: project.root })
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
      taskId: summary.taskId ?? "",
      projectId: project.id,
      cwd: summary.cwd,
      worktree: summary.cwd,
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
 */
async function summaryFromFile(
  project: Project,
  sessionId: string,
  activeRunFor: (sessionId: string) => string | null,
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
    activeRunId: activeRunFor(sessionId),
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
