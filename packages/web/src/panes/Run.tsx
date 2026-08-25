import { useEffect, useMemo, useRef, useState } from "react"
import type { RunEvent, RunStatus } from "@aide/protocol"
import { api, type DiffView, type TaskView } from "../api.js"
import { Button, Empty, PaneHeader, money } from "../ui.js"
import { useRunStream, type StreamState } from "../useRunStream.js"

/** tool.start and tool.end arrive separately; pair them into one line per call. */
interface ToolLine {
  kind: "tool"
  seq: number
  toolUseId: string
  name: string
  input: unknown
  nested: boolean
  ok: boolean | null
  summary: string
}
interface OutcomeLine {
  kind: "outcome"
  seq: number
  status: RunStatus
  subtype: string
  turns: number
  ms: number
  cost: number
}
type Line =
  | ToolLine
  | OutcomeLine
  | { kind: "text"; seq: number; text: string; nested: boolean }
  | { kind: "thinking"; seq: number; text: string }
  | { kind: "denied"; seq: number; name: string; reason: string }
  | { kind: "retry"; seq: number; text: string }
  | { kind: "error"; seq: number; text: string }

/**
 * A run must always end with a visible line saying how it ended. Without one, a
 * cancelled run is indistinguishable from a run that is still going, and the
 * only end-marker is whatever internal string the SDK happened to throw.
 */
function describeOutcome(l: OutcomeLine): { label: string; className: string } {
  if (l.status === "success") return { label: "done", className: "text-ok" }
  if (l.status === "cancelled") return { label: "interrupted by you", className: "text-fg-muted" }
  if (l.subtype === "error_max_budget_usd")
    return { label: "stopped: per-run budget reached", className: "text-warn" }
  if (l.subtype === "error_max_turns")
    return { label: "stopped: turn limit reached", className: "text-warn" }
  return { label: "failed", className: "text-err" }
}

/**
 * The SDK surfaces internal diagnostics as error text. They are useful in a log
 * and meaningless in a UI, so translate the ones we have actually seen and keep
 * the raw string on the title attribute.
 */
function humanizeError(message: string): string {
  if (message.includes("ede_diagnostic")) {
    return "The run ended before finishing its turn (usually an interrupt or a dropped connection)."
  }
  return message
}

function toLines(events: RunEvent[]): Line[] {
  const lines: Line[] = []
  const byToolId = new Map<string, ToolLine>()

  for (const e of events) {
    switch (e.type) {
      case "assistant.text":
        lines.push({ kind: "text", seq: e.seq, text: e.text, nested: !!e.parentToolUseId })
        break
      case "assistant.thinking":
        lines.push({ kind: "thinking", seq: e.seq, text: e.text })
        break
      case "tool.start": {
        const line: ToolLine = {
          kind: "tool",
          seq: e.seq,
          toolUseId: e.toolUseId,
          name: e.name,
          input: e.input,
          nested: !!e.parentToolUseId,
          ok: null,
          summary: "",
        }
        byToolId.set(e.toolUseId, line)
        lines.push(line)
        break
      }
      case "tool.end": {
        const line = byToolId.get(e.toolUseId)
        if (line) {
          line.ok = e.ok
          line.summary = e.summary
        }
        break
      }
      case "tool.denied":
        lines.push({ kind: "denied", seq: e.seq, name: e.name, reason: e.reason })
        break
      case "run.retry":
        lines.push({
          kind: "retry",
          seq: e.seq,
          text: `retry ${e.attempt}/${e.maxRetries} in ${e.retryDelayMs}ms — ${e.error}`,
        })
        break
      case "run.error":
        lines.push({ kind: "error", seq: e.seq, text: e.message })
        break
      case "run.finished":
        lines.push({
          kind: "outcome",
          seq: e.seq,
          status: e.status,
          subtype: e.subtype,
          turns: e.numTurns,
          ms: e.durationMs,
          cost: e.totalCostUsd,
        })
        break
    }
  }

  // Runs logged before duplicate-suppression landed carry a redundant run.error
  // after their result. Drop it here so old transcripts read like new ones.
  const outcomeAt = lines.findIndex((l) => l.kind === "outcome")
  return outcomeAt === -1
    ? lines
    : lines.filter((l, i) => !(l.kind === "error" && i > outcomeAt))
}

/** One-line preview of a tool's arguments — enough to know what it touched. */
function describeInput(name: string, input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>
  const first =
    o["command"] ?? o["file_path"] ?? o["pattern"] ?? o["path"] ?? o["url"] ?? o["prompt"]
  if (typeof first === "string") {
    const short = name === "Bash" ? first : first.split(/[/\\]/).slice(-2).join("/")
    return short.length > 90 ? `${short.slice(0, 90)}…` : short
  }
  return ""
}

function ToolRow({ line }: { line: ToolLine }) {
  const mark =
    line.ok === null ? (
      <span className="text-info">▸</span>
    ) : line.ok ? (
      <span className="text-ok">✓</span>
    ) : (
      <span className="text-err">✗</span>
    )
  const [open, setOpen] = useState(false)

  return (
    <div className={line.nested ? "ml-4 border-l border-line pl-3" : ""}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-left hover:bg-hover"
      >
        {mark}
        <span className="text-syn-func">{line.name}</span>
        <span className="truncate text-syn-string">{describeInput(line.name, line.input)}</span>
      </button>
      {open && (
        <pre className="mt-1 mb-2 max-h-64 overflow-auto rounded-sm bg-chrome p-2 text-[11px] leading-relaxed whitespace-pre-wrap text-fg-muted">
          {JSON.stringify(line.input, null, 2)}
          {line.summary ? `\n\n--- result ---\n${line.summary}` : ""}
        </pre>
      )}
    </div>
  )
}

const STREAM_LABEL: Record<StreamState, string> = {
  idle: "",
  connecting: "connecting…",
  live: "live",
  reconnecting: "reconnecting…",
}

export function RunPane({
  projectId,
  task,
  runId,
  onChanged,
}: {
  projectId: string | null
  task: TaskView | null
  runId: string | null
  onChanged: () => void
}) {
  const { events, state } = useRunStream(runId)
  const [tab, setTab] = useState<"stream" | "diff">("stream")
  const [diff, setDiff] = useState<DiffView | null>(null)
  const [busy, setBusy] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  const lines = useMemo(() => toLines(events), [events])
  const finished = useMemo(
    () => events.find((e) => e.type === "run.finished"),
    [events],
  ) as Extract<RunEvent, { type: "run.finished" }> | undefined
  const isActive = !!task?.activeRunId
  const outcome = finished
    ? describeOutcome({
        kind: "outcome",
        seq: finished.seq,
        status: finished.status,
        subtype: finished.subtype,
        turns: finished.numTurns,
        ms: finished.durationMs,
        cost: finished.totalCostUsd,
      })
    : null

  // Follow the tail, but stop fighting the user the moment they scroll up.
  useEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [lines.length])

  useEffect(() => {
    if (tab !== "diff" || !projectId || !task) return
    setDiff(null)
    void api.diff(projectId, task.id).then(setDiff).catch(() => setDiff(null))
  }, [tab, projectId, task?.id, finished?.seq])

  if (!task) {
    return (
      <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-editor">
        <PaneHeader title="run" />
        <Empty>Select a task to see its run.</Empty>
      </section>
    )
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-editor">
      <PaneHeader title={`run · ${task.title}`}>
        <div className="mr-1 flex overflow-hidden rounded border border-line">
          {(["stream", "diff"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`px-2 py-0.5 text-xs ${
                tab === t ? "bg-input text-fg" : "text-fg-muted hover:text-fg"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        {isActive ? (
          <Button
            tone="danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await api.interrupt(task.activeRunId!)
              } finally {
                setBusy(false)
                onChanged()
              }
            }}
          >
            interrupt
          </Button>
        ) : (
          <Button
            tone="primary"
            disabled={busy || !projectId}
            onClick={async () => {
              setBusy(true)
              try {
                await api.runTask(projectId!, task.id)
              } finally {
                setBusy(false)
                onChanged()
              }
            }}
          >
            {task.runs.length ? "run again" : "run"}
          </Button>
        )}
      </PaneHeader>

      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
        className="flex-1 overflow-auto px-3 py-2 font-mono text-xs leading-relaxed"
      >
        {tab === "diff" ? (
          diff === null ? (
            <Empty>Loading diff…</Empty>
          ) : diff.diff.trim() === "" ? (
            <Empty>No changes in the worktree yet.</Empty>
          ) : (
            <pre className="whitespace-pre">
              {diff.diff.split("\n").map((l, i) => (
                <div
                  key={i}
                  className={
                    l.startsWith("+++") || l.startsWith("---")
                      ? "text-fg-muted"
                      : l.startsWith("+")
                        ? "bg-diff-add text-diff-add-fg"
                        : l.startsWith("-")
                          ? "bg-diff-del text-diff-del-fg"
                          : l.startsWith("@@")
                            ? "text-syn-comment"
                            : l.startsWith("diff --git")
                              ? "mt-3 text-syn-var"
                              : "text-fg-muted"
                  }
                >
                  {l || " "}
                </div>
              ))}
            </pre>
          )
        ) : !runId ? (
          <Empty>This task has not run yet.</Empty>
        ) : lines.length === 0 ? (
          <Empty>Waiting for the first event…</Empty>
        ) : (
          <div className="space-y-1">
            {lines.map((line) => {
              if (line.kind === "tool") return <ToolRow key={line.seq} line={line} />
              if (line.kind === "thinking")
                return (
                  <p key={line.seq} className="px-1 text-syn-comment italic">
                    {line.text}
                  </p>
                )
              if (line.kind === "denied")
                return (
                  <p key={line.seq} className="px-1 text-warn">
                    ✗ denied {line.name} — {line.reason}
                  </p>
                )
              if (line.kind === "retry")
                return (
                  <p key={line.seq} className="px-1 text-warn">
                    ↻ {line.text}
                  </p>
                )
              if (line.kind === "error")
                return (
                  <p key={line.seq} className="px-1 text-err" title={line.text}>
                    ! {humanizeError(line.text)}
                  </p>
                )
              if (line.kind === "outcome") {
                const outcome = describeOutcome(line)
                return (
                  <p
                    key={line.seq}
                    title={`SDK result subtype: ${line.subtype}`}
                    className={`mt-3 border-t border-line px-1 pt-2 ${outcome.className}`}
                  >
                    ● {outcome.label}
                    <span className="text-fg-dim">
                      {" — "}
                      {line.turns} turns · {(line.ms / 1000).toFixed(1)}s · ~{money(line.cost)} est.
                    </span>
                  </p>
                )
              }
              return (
                <p
                  key={line.seq}
                  className={`px-1 whitespace-pre-wrap text-fg ${
                    line.nested ? "ml-4 border-l border-line pl-3" : ""
                  }`}
                >
                  {line.text}
                </p>
              )
            })}
          </div>
        )}
      </div>

      <footer className="flex h-[22px] shrink-0 items-center gap-4 border-t border-line bg-chrome px-3 font-sans text-[11px] text-fg-muted">
        {finished && outcome ? (
          <>
            <span className={outcome.className}>{outcome.label}</span>
            <span>{finished.numTurns} turns</span>
            <span>{(finished.durationMs / 1000).toFixed(1)}s</span>
            <span title="Client-side estimate from a price table bundled into the SDK. Not billing data.">
              ~{money(finished.totalCostUsd)} est.
            </span>
            {finished.permissionDenials.length > 0 && (
              <span className="text-warn">{finished.permissionDenials.length} denied</span>
            )}
            <span className="ml-auto text-fg-dim" title="raw SDK result subtype">
              {finished.subtype}
            </span>
          </>
        ) : (
          <span>{STREAM_LABEL[state]}</span>
        )}
      </footer>
    </section>
  )
}
