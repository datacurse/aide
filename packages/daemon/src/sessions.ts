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
import { getSessionMessages, listSessions } from "@anthropic-ai/claude-agent-sdk"
import type { ConversationSummary, Project, RunEvent } from "@aide/protocol"
import { STATE_DIR } from "@aide/protocol"
import { normalizeSdkMessage } from "./agent.js"

/**
 * A transcript this long is already unreadable, and the JSONL behind it can be
 * several megabytes. Cap the read rather than the response size so the number
 * shown to the user ("1200 of 4000 messages") means something.
 */
const MAX_MESSAGES = 1_500

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
export async function listConversations(project: Project): Promise<ConversationSummary[]> {
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
      } satisfies ConversationSummary
    })
    .sort((a, b) => b.lastModified - a.lastModified)
}

export async function getConversation(
  project: Project,
  sessionId: string,
): Promise<{ summary: ConversationSummary; events: RunEvent[]; truncated: boolean; totalMessages: number } | null> {
  const summary = (await listConversations(project)).find((c) => c.sessionId === sessionId)
  if (!summary) return null

  const messages = await getSessionMessages(sessionId, { dir: project.root })
  const capped = messages.slice(0, MAX_MESSAGES)

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
    summary,
    events,
    truncated: messages.length > capped.length,
    totalMessages: messages.length,
  }
}

function firstLine(s: string): string | null {
  const line = s.split("\n").find((l) => l.trim())
  if (!line) return null
  return line.length > 80 ? `${line.slice(0, 80)}…` : line
}
