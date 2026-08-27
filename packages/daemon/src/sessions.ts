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
import { join } from "node:path"
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
  const summary = (await listConversations(project, activeRunFor)).find(
    (c) => c.sessionId === sessionId,
  )
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
