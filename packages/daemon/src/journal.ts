import { mkdir, writeFile } from "node:fs/promises"
import type { Project, RunEvent, Task } from "@aide/protocol"
import { slugify, STATE_DIR } from "@aide/protocol"
import { journalDir, journalEntryPath } from "@aide/protocol/node"

/**
 * A journal entry is assembled from the run's own event log, not written by a
 * model.
 *
 * The tempting version asks Sonnet to narrate what happened. The problem is that
 * a journal exists to be trusted later, when nobody remembers the run — and a
 * narrated one is indistinguishable from an invented one at that distance. Every
 * line below is a fact the daemon recorded: what the agent said in its own
 * words, which tools it called, what it cost, what it was denied.
 *
 * The one model-written part is the commit message, and it is quoted as such.
 */

const pad2 = (n: number) => String(n).padStart(2, "0")

/** Local date, not UTC: these filenames sort into the days the user worked. */
function dateStamp(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function toolTally(events: readonly RunEvent[]): string {
  const counts = new Map<string, number>()
  for (const e of events) {
    if (e.type === "tool.start") counts.set(e.name, (counts.get(e.name) ?? 0) + 1)
  }
  if (counts.size === 0) return "none"
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => (n === 1 ? name : `${name} ×${n}`))
    .join(", ")
}

/**
 * The agent's closing words. Subagent output (`parentToolUseId` non-null) is
 * skipped: it is addressed to the main loop, not to the reader of a journal.
 */
function closingNote(events: readonly RunEvent[]): string {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]
    if (e?.type === "assistant.text" && e.parentToolUseId === null && e.text.trim()) {
      return e.text.trim()
    }
  }
  return ""
}

const usd = (n: number) => `$${n.toFixed(2)}`

function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${pad2(s % 60)}s`
}

export interface JournalEntryOptions {
  project: Project
  task: Task
  /** The full event log for the run being committed. */
  events: readonly RunEvent[]
  /** Run this entry describes. */
  runId: string
  /** The commit that just landed on the task branch. */
  sha: string
  /** The message that was committed, after any human edits. */
  message: string
  /** `git diff --stat`, captured before the commit staged everything. */
  diffStat: string
}

/**
 * Write one entry and return its path relative to the project root, so the
 * caller can show where it went without leaking an absolute path into the UI.
 */
export async function writeJournalEntry(opts: JournalEntryOptions): Promise<string> {
  const { project, task, events, runId, sha, message, diffStat } = opts

  const finished = [...events].reverse().find((e) => e.type === "run.finished")
  const started = events.find((e) => e.type === "run.started")
  const ts = finished?.ts ?? Date.now()
  const short = sha.slice(0, 8)

  const [subject = "", ...rest] = message.split("\n")
  const body = rest.join("\n").trim()
  const note = closingNote(events)
  const denials = finished?.type === "run.finished" ? finished.permissionDenials : []

  const lines: string[] = [
    "---",
    `task: "${task.id}"`,
    `title: ${JSON.stringify(task.title)}`,
    `commit: ${sha}`,
    `run: ${runId}`,
    `model: ${started?.type === "run.started" ? started.model : "unknown"}`,
    `date: ${new Date(ts).toISOString()}`,
  ]
  if (finished?.type === "run.finished") {
    lines.push(
      `costUsd: ${finished.totalCostUsd}`,
      `turns: ${finished.numTurns}`,
      `durationMs: ${finished.durationMs}`,
    )
  }
  lines.push(
    "---",
    "",
    `# ${task.id} — ${task.title}`,
    "",
    `\`${short}\` on \`${task.branch}\``,
    "",
    "## Commit message",
    "",
    `> ${subject}`,
  )
  if (body) {
    lines.push(">", ...body.split("\n").map((l) => (l.trim() ? `> ${l}` : ">")))
  }

  if (note) {
    lines.push("", "## What the agent reported", "", note)
  }

  lines.push("", "## Run", "", `- Tools: ${toolTally(events)}`)
  if (finished?.type === "run.finished") {
    lines.push(
      `- Turns: ${finished.numTurns}`,
      `- Duration: ${duration(finished.durationMs)}`,
      // Same caveat as everywhere else this number appears: it is the SDK's
      // client-side estimate, and a journal read months later should say so.
      `- Cost: ${usd(finished.totalCostUsd)} (estimate)`,
    )
  }

  if (diffStat.trim()) {
    lines.push("", "## Files", "", "```", diffStat.trim(), "```")
  }

  if (denials.length) {
    lines.push(
      "",
      "## Denied",
      "",
      ...denials.map((d) => `- \`${d.tool}\` — ${d.reason || "not in this run's allowlist"}`),
    )
  }

  const file = `${dateStamp(ts)}-${task.id}-${slugify(task.title)}.md`
  await mkdir(journalDir(project.root), { recursive: true })
  await writeFile(journalEntryPath(project.root, file), `${lines.join("\n")}\n`, "utf8")
  return `${STATE_DIR}/journal/${file}`
}
