import { useEffect, useMemo, useRef, useState } from "react"
import type { RunEvent, RunStatus, TaskStatus } from "@aide/protocol"
import { api, type CommitResult, type DiffView, type TaskView } from "../api.js"
import { Markdown } from "../Markdown.js"
import { Button, Empty, PaneHeader, STATUS_STYLE, money } from "../ui.js"
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
/** The project's setup command, run before the agent in a fresh worktree. */
interface BootstrapLine {
  kind: "bootstrap"
  seq: number
  command: string
  ok: boolean | null
  exitCode: number | null
  ms: number
  output: string
}
/** A tool call a chat turn is blocked on, paired with its answer if it has one. */
interface PermissionLine {
  kind: "permission"
  seq: number
  requestId: string
  name: string
  input: unknown
  /** null while still waiting on the human. */
  allowed: boolean | null
  reason: string
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
  | { kind: "queued"; seq: number; position: number }
  | { kind: "user"; seq: number; text: string }
  | BootstrapLine
  | { kind: "denied"; seq: number; name: string; reason: string }
  | PermissionLine
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
  let bootstrap: BootstrapLine | null = null
  const byRequestId = new Map<string, PermissionLine>()

  for (const e of events) {
    switch (e.type) {
      case "user.message":
        lines.push({ kind: "user", seq: e.seq, text: e.text })
        break
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
      case "run.queued":
        lines.push({ kind: "queued", seq: e.seq, position: e.position })
        break
      case "bootstrap.started": {
        const line: BootstrapLine = {
          kind: "bootstrap",
          seq: e.seq,
          command: e.command,
          ok: null,
          exitCode: null,
          ms: 0,
          output: "",
        }
        bootstrap = line
        lines.push(line)
        break
      }
      case "bootstrap.finished":
        // Paired into the started line, the same way tool.end folds into
        // tool.start, so a completed install is one row rather than two.
        if (bootstrap) {
          bootstrap.ok = e.ok
          bootstrap.exitCode = e.exitCode
          bootstrap.ms = e.durationMs
          bootstrap.output = e.output
        }
        break
      case "permission.request": {
        const line: PermissionLine = {
          kind: "permission",
          seq: e.seq,
          requestId: e.requestId,
          name: e.name,
          input: e.input,
          allowed: null,
          reason: "",
        }
        byRequestId.set(e.requestId, line)
        lines.push(line)
        break
      }
      case "permission.resolved": {
        const line = byRequestId.get(e.requestId)
        if (line) {
          line.allowed = e.allowed
          line.reason = e.reason
        }
        break
      }
      case "context.usage":
        // Consumed by the composer's meter, not drawn in the transcript.
        break
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
        className="flex w-full min-w-0 items-baseline gap-2 rounded px-1 py-0.5 text-left hover:bg-hover"
      >
        {mark}
        <span className="shrink-0 text-syn-func">{line.name}</span>
        {/* min-w-0 is what makes `truncate` real: a flex child defaults to
            min-width:auto and refuses to shrink below its content, so without it
            the row grows to fit the command and drags the whole pane sideways. */}
        <span className="min-w-0 truncate text-syn-string">
          {describeInput(line.name, line.input)}
        </span>
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

/**
 * The turn is stopped here until you answer.
 *
 * Rendered inline in the transcript rather than as a modal so it is legible in
 * context — what Claude was about to do, right after what it said it would do —
 * and so a replayed transcript shows what was asked and what you decided.
 */
function PermissionRow({
  line,
  onAnswer,
}: {
  line: PermissionLine
  onAnswer?: (requestId: string, allowed: boolean) => void
}) {
  const [open, setOpen] = useState(line.allowed === null)
  const pending = line.allowed === null

  return (
    <div
      className={`my-2 rounded border px-3 py-2 ${
        pending ? "border-warn bg-warn/5" : "border-line bg-chrome"
      }`}
    >
      <div className="flex min-w-0 items-center gap-2 font-sans text-[12px]">
        <span className={`shrink-0 ${pending ? "text-warn" : "text-fg-dim"}`}>
          {pending ? "needs your approval" : line.allowed ? "you allowed" : "you declined"}
        </span>
        <span className="shrink-0 font-mono text-syn-func">{line.name}</span>
        <span className="min-w-0 truncate font-mono text-[11px] text-syn-string">
          {describeInput(line.name, line.input)}
        </span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="ml-auto shrink-0 text-[11px] text-fg-dim hover:text-fg"
        >
          {open ? "hide" : "details"}
        </button>
      </div>

      {open && (
        <pre className="mt-2 max-h-48 overflow-auto rounded-sm bg-editor p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg-muted">
          {JSON.stringify(line.input, null, 2)}
        </pre>
      )}

      {pending && onAnswer && (
        <div className="mt-2 flex gap-1.5">
          <Button tone="primary" onClick={() => onAnswer(line.requestId, true)}>
            allow
          </Button>
          <Button onClick={() => onAnswer(line.requestId, false)}>decline</Button>
        </div>
      )}
      {pending && !onAnswer && (
        <p className="mt-1 font-sans text-[11px] text-fg-dim">
          This turn is no longer running, so it cannot be answered.
        </p>
      )}
    </div>
  )
}

/** Mirrors ToolRow: one collapsed row, click to see why it failed. */
function BootstrapRow({ line }: { line: BootstrapLine }) {
  const [open, setOpen] = useState(false)
  const mark =
    line.ok === null ? (
      <span className="text-info">▸</span>
    ) : line.ok ? (
      <span className="text-ok">✓</span>
    ) : (
      <span className="text-err">✗</span>
    )
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 items-baseline gap-2 rounded px-1 py-0.5 text-left hover:bg-hover"
      >
        {mark}
        <span className="shrink-0 text-syn-keyword">bootstrap</span>
        <span className="min-w-0 truncate text-syn-string">{line.command}</span>
        {line.ok !== null && (
          <span className="shrink-0 text-fg-dim">
            {(line.ms / 1000).toFixed(1)}s
            {line.ok ? "" : ` · exit ${line.exitCode ?? "killed"}`}
          </span>
        )}
      </button>
      {open && (
        <pre className="mt-1 mb-2 max-h-64 overflow-auto rounded-sm bg-chrome p-2 text-[11px] leading-relaxed whitespace-pre-wrap text-fg-muted">
          {line.output || "(no output captured)"}
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

/**
 * Statuses whose worktree is worth offering to commit.
 *
 * `cancelled` and `failed` are in here deliberately. A run you interrupted, or
 * one that died on turn nine, still leaves real work on disk — refusing to let
 * you keep it would mean the only way to salvage a partial run is to leave aide
 * and use git by hand.
 */
const ACCEPTABLE = new Set<TaskStatus>(["needs-review", "committed", "cancelled", "failed"])

/**
 * The last gate. A run stopping is not the same as its work being accepted, and
 * this is where the difference gets resolved.
 *
 * Drafting is a separate step from committing on purpose: the message costs a
 * model call and a few seconds, and it lands in a textarea rather than straight
 * into a commit, because the human editing it is the review. Landing is a
 * second button for the same reason — a commit on a task branch is recoverable,
 * and a merge is what the rest of the repo has to live with.
 */
function AcceptBar({
  projectId,
  task,
  onChanged,
}: {
  projectId: string
  task: TaskView
  onChanged: () => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [drafter, setDrafter] = useState<string | null>(null)
  const [branch, setBranch] = useState<string | null>(null)
  const [result, setResult] = useState<CommitResult | null>(null)
  const [busy, setBusy] = useState<"draft" | "commit" | "land" | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Switching tasks must not carry the previous task's draft across — it would
  // read as a suggestion for work it was never written about.
  useEffect(() => {
    setDraft(null)
    setResult(null)
    setError(null)
  }, [task.id])

  useEffect(() => {
    void api
      .branch(projectId)
      .then((r) => setBranch(r.branch))
      .catch(() => setBranch(null))
  }, [projectId])

  const attempt = async (kind: "draft" | "commit" | "land", fn: () => Promise<void>) => {
    setBusy(kind)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const sha = task.commits.at(-1)

  return (
    <div className="shrink-0 border-t border-line bg-chrome px-3 py-2 font-sans text-[11px]">
      {task.status === "committed" ? (
        <div className="flex items-center gap-3">
          <span className="text-diff-add-fg">committed</span>
          {sha && (
            <code className="font-mono text-fg-muted" title={sha}>
              {sha.slice(0, 8)}
            </code>
          )}
          {result?.journal && <span className="min-w-0 truncate text-fg-dim">{result.journal}</span>}
          <div className="ml-auto flex items-center gap-2">
            <span className="text-fg-dim">
              {branch ? `merges into ${branch}` : "merges into the checked-out branch"}
            </span>
            <Button
              tone="primary"
              disabled={busy !== null}
              title="Merge the task branch with --no-ff and remove the worktree"
              onClick={() =>
                attempt("land", async () => {
                  const landed = await api.land(projectId, task.id)
                  if (landed.warning) setError(landed.warning)
                  onChanged()
                })
              }
            >
              {busy === "land" ? "landing…" : `land${branch ? ` into ${branch}` : ""}`}
            </Button>
          </div>
        </div>
      ) : draft === null ? (
        <div className="flex items-center gap-3">
          <span className={STATUS_STYLE[task.status].text}>{STATUS_STYLE[task.status].label}</span>
          <span className="text-fg-dim">
            Read the diff, then write a commit message for it.
          </span>
          <div className="ml-auto">
            <Button
              disabled={busy !== null}
              onClick={() =>
                attempt("draft", async () => {
                  const d = await api.draftCommit(projectId, task.id)
                  setDrafter(d.model)
                  setDraft(d.message)
                })
              }
            >
              {busy === "draft" ? "drafting…" : "write commit message"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={Math.min(12, Math.max(4, draft.split(/\n/).length + 1))}
            spellCheck={false}
            className="w-full resize-y rounded border border-line-soft bg-input px-2 py-1 font-mono text-xs leading-relaxed outline-none focus:border-accent"
          />
          <div className="flex items-center gap-3">
            <span className="text-fg-dim">
              {drafter ? `drafted by ${drafter} — edit freely; ` : ""}
              Aide-Task and Aide-Run trailers are appended on commit
            </span>
            <div className="ml-auto flex gap-1.5">
              <Button disabled={busy !== null} onClick={() => setDraft(null)}>
                discard
              </Button>
              <Button
                tone="primary"
                disabled={busy !== null || !draft.trim()}
                onClick={() =>
                  attempt("commit", async () => {
                    const committed = await api.commit(projectId, task.id, draft)
                    setResult(committed)
                    setDraft(null)
                    if (committed.warning) setError(committed.warning)
                    onChanged()
                  })
                }
              >
                {busy === "commit" ? "committing…" : "commit"}
              </Button>
            </div>
          </div>
        </div>
      )}
      {error && <p className="mt-2 whitespace-pre-wrap text-err">{error}</p>}
    </div>
  )
}


/**
 * The transcript, as a component rather than as part of the run pane.
 *
 * A conversation replayed from the SDK's session store normalizes into the same
 * `RunEvent` shapes a live run emits, so it renders through exactly this code.
 * Sharing it is the point: a chat you had in VS Code and a task aide ran itself
 * read identically, with the same tool rows and the same outcome line.
 */
export function Transcript({
  events,
  onPermission,
}: {
  events: RunEvent[]
  /** Present only for a live chat turn; a replayed transcript cannot be answered. */
  onPermission?: (requestId: string, allowed: boolean) => void
}) {
  const lines = useMemo(() => toLines(events), [events])
  if (lines.length === 0) return <Empty>Nothing in this transcript.</Empty>
  return (
            <div className="space-y-1">
              {lines.map((line) => {
                if (line.kind === "tool") return <ToolRow key={line.seq} line={line} />
                if (line.kind === "bootstrap") return <BootstrapRow key={line.seq} line={line} />
                if (line.kind === "thinking")
                  return (
                    <p key={line.seq} className="px-1 break-words whitespace-pre-wrap text-syn-comment italic">
                      {line.text}
                    </p>
                  )
                if (line.kind === "queued")
                  return (
                    <p key={line.seq} className="px-1 text-fg-dim">
                      ◦ queued{line.position > 1 ? ` behind ${line.position - 1}` : ""}
                    </p>
                  )
                if (line.kind === "user")
                  return (
                    <div
                      key={line.seq}
                      className="my-2 border-l-2 border-syn-var bg-chrome px-3 py-1.5"
                    >
                      <div className="mb-0.5 font-sans text-[10px] tracking-wide text-syn-var uppercase">
                        you
                      </div>
                      <Markdown text={line.text} />
                    </div>
                  )
                if (line.kind === "permission")
                  return (
                    <PermissionRow key={line.seq} line={line} onAnswer={onPermission} />
                  )
                if (line.kind === "denied")
                  return (
                    <p key={line.seq} className="px-1 break-words text-warn">
                      ✗ denied {line.name} — {line.reason}
                    </p>
                  )
                if (line.kind === "retry")
                  return (
                    <p key={line.seq} className="px-1 break-words text-warn">
                      ↻ {line.text}
                    </p>
                  )
                if (line.kind === "error")
                  return (
                    <p key={line.seq} className="px-1 break-words text-err" title={line.text}>
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
                  <div
                    key={line.seq}
                    className={`px-1 ${line.nested ? "ml-4 border-l border-line pl-3" : ""}`}
                  >
                    <Markdown text={line.text} />
                  </div>
                )
              })}
            </div>
  )
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
        className="flex-1 overflow-x-hidden overflow-y-auto px-3 py-2 font-mono text-xs leading-relaxed"
      >
        {tab === "diff" ? (
          diff === null ? (
            <Empty>Loading diff…</Empty>
          ) : diff.diff.trim() === "" ? (
            <Empty>No changes in the worktree yet.</Empty>
          ) : (
            <pre className="w-full overflow-x-auto whitespace-pre">
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
          <Transcript events={events} />
        )}
      </div>

      {projectId && !isActive && ACCEPTABLE.has(task.status) && (
        <AcceptBar projectId={projectId} task={task} onChanged={onChanged} />
      )}

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
