import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import type { MessageImage, RunEvent, RunStatus } from "@aide/protocol"
import { Markdown } from "../Markdown.js"
import { Button, Empty, money } from "../ui.js"

/**
 * A run's event log, rendered as a conversation.
 *
 * Shared by every surface that shows one, because they are all the same thing:
 * the daemon normalizes a replayed session file into exactly the events a live
 * turn emits, so history and the message arriving right now render through one
 * component rather than two that drift.
 */

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
/**
 * The snapshot taken before the agent was let near the working tree.
 *
 * This row replaced the bootstrap row, and it is a much smaller thing on screen
 * than what it replaced — a checkout and a dependency install used to be the
 * longest wait in the product. It still gets a line because "what happened to my
 * uncommitted work" has to be answerable from the transcript alone, and because
 * the line carries the command that undoes the run.
 */
interface CheckpointLine {
  kind: "checkpoint"
  seq: number
  ref: string
  sha: string
  restore: string
  /**
   * The conversation's baseline carries how much of the human's own work it is
   * standing in front of; a turn boundary carries which turn it closed. Exactly
   * one of the two is present, and which one decides how the row reads.
   */
  dirtyCount?: number
  turn?: number
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
/** What the human said, and whatever they pasted with it. */
interface UserLine {
  kind: "user"
  seq: number
  text: string
  images: MessageImage[]
}
/**
 * One step of a commit.
 *
 * A commit is not an agent and has no tool calls, but it does spend ten seconds
 * of model time writing its own message — so it narrates, and these are what it
 * narrates with. `done` is not on the wire: a step is over once anything else is
 * in the log after it, which is a thing the reader can see for itself.
 */
interface CommitStepLine {
  kind: "commit-step"
  seq: number
  label: string
  done: boolean
}
/** What was committed, and what it took. */
interface CommitLandedLine {
  kind: "commit-landed"
  seq: number
  sha: string
  paths: string[]
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
  | UserLine
  | CheckpointLine
  | { kind: "denied"; seq: number; name: string; reason: string }
  | PermissionLine
  | { kind: "retry"; seq: number; text: string }
  | { kind: "error"; seq: number; text: string }
  | CommitStepLine
  | CommitLandedLine
  | { kind: "commit-message"; seq: number; message: string; model: string; specChanged: boolean }

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
  const byRequestId = new Map<string, PermissionLine>()

  for (const e of events) {
    switch (e.type) {
      case "user.message":
        lines.push({ kind: "user", seq: e.seq, text: e.text, images: e.images ?? [] })
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
      case "checkpoint.taken":
        lines.push({
          kind: "checkpoint",
          seq: e.seq,
          ref: e.ref,
          sha: e.sha,
          dirtyCount: e.dirtyCount,
          restore: e.restore,
        })
        break
      case "turn.checkpoint":
        lines.push({
          kind: "checkpoint",
          seq: e.seq,
          ref: e.ref,
          sha: e.sha,
          turn: e.n,
          restore: e.restore,
        })
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
      case "commit.step":
        lines.push({ kind: "commit-step", seq: e.seq, label: e.label, done: false })
        break
      case "commit.drafted":
        lines.push({
          kind: "commit-message",
          seq: e.seq,
          message: e.message,
          model: e.model,
          specChanged: e.specChanged,
        })
        break
      case "commit.landed":
        lines.push({ kind: "commit-landed", seq: e.seq, sha: e.sha, paths: e.paths })
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

  // Every step but the last one in the log has been overtaken by whatever came
  // after it. Marked here rather than sent as a second event per step, which
  // would put nothing in the log that its ordering does not already say.
  for (let i = 0; i < lines.length - 1; i += 1) {
    const line = lines[i]
    if (line?.kind === "commit-step") line.done = true
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
 * The question, pinned.
 *
 * `position: sticky` rather than a copy rendered into a header bar: there is one
 * element, so it cannot disagree with itself, and the browser hands off from one
 * question to the next for free — the next one paints over this one as it
 * arrives, because a later sibling with the same z-index wins. The z-index is
 * needed for the other half of that: without it every ordinary line AFTER this
 * block paints over the pinned copy, and the answer scrolls through it rather
 * than under it.
 *
 * Clipped when collapsed for a reason worth naming: a question is usually a
 * sentence, but sometimes it is thirty lines of pasted log, and pinning all of
 * that leaves no pane left to read the answer in.
 */
function UserRow({ line }: { line: UserLine }) {
  const [open, setOpen] = useState(false)
  const [clipped, setClipped] = useState(false)
  const body = useRef<HTMLDivElement>(null)

  // Measured, not guessed from the length of the text: whether it overflows
  // depends on how wide the pane is and on whether a screenshot came with it,
  // and a "more" button that reveals nothing is worse than no button.
  useLayoutEffect(() => {
    const el = body.current
    if (!el || open) return
    setClipped(el.scrollHeight > el.clientHeight + 1)
  }, [line.text, line.images.length, open])

  return (
    <div className="sticky top-0 z-10 my-2 border-b-line border-l-syn-var border-b border-l-2 bg-chrome px-3 py-1.5">
      <div className="mb-0.5 flex items-baseline gap-2">
        <span className="font-sans text-[10px] tracking-wide text-syn-var uppercase">you</span>
        {(clipped || line.images.length > 0) && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="ml-auto shrink-0 font-sans text-[11px] text-fg-dim hover:text-fg"
          >
            {open ? "collapse" : "expand"}
          </button>
        )}
      </div>
      <div ref={body} className={open ? "" : "max-h-24 overflow-hidden"}>
        {line.images.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1.5">
            {line.images.map((img, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setOpen((v) => !v)}
                title={open ? "Shrink it" : "Show it full size"}
                className={open ? "cursor-zoom-out" : "cursor-zoom-in"}
              >
                <img
                  src={`data:${img.mediaType};base64,${img.data}`}
                  alt="pasted screenshot"
                  className={`w-auto rounded-sm border border-line ${open ? "max-h-80" : "h-12"}`}
                />
              </button>
            ))}
          </div>
        )}
        <Markdown text={line.text} />
      </div>
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

/**
 * Mirrors ToolRow: one collapsed row, click for the command that goes back here.
 *
 * Two things render through it — the snapshot taken before the conversation
 * started, and the boundary at the end of each turn that changed something — on
 * purpose. They are the same object doing the same job at different
 * granularities, and giving them two looks would suggest one of them is not a
 * place you can return to.
 */
function CheckpointRow({ line }: { line: CheckpointLine }) {
  const [open, setOpen] = useState(false)
  const isTurn = line.turn !== undefined
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 items-baseline gap-2 rounded px-1 py-0.5 text-left hover:bg-hover"
      >
        <span className="text-ok">✓</span>
        <span className="shrink-0 text-syn-keyword">
          {isTurn ? `after turn ${line.turn}` : "checkpoint"}
        </span>
        <span className="min-w-0 truncate text-syn-string">{line.sha.slice(0, 7)}</span>
        {/* Only when there was something to protect. "0 files already changed"
            on every clean run would train everyone to stop reading the row. */}
        {!!line.dirtyCount && (
          <span className="shrink-0 text-fg-dim">
            {line.dirtyCount} file{line.dirtyCount === 1 ? "" : "s"} already changed
          </span>
        )}
      </button>
      {open && (
        <div className="mt-1 mb-2 rounded-sm bg-chrome p-2">
          <pre className="overflow-auto text-[11px] leading-relaxed whitespace-pre-wrap text-fg-muted">
            {line.restore}
          </pre>
          {/* Said here rather than left to be discovered. A restore that quietly
              leaves later files behind reads as a failed undo. */}
          <p className="mt-1 font-sans text-[10px] text-fg-dim">
            {isTurn
              ? "Puts the tree back to how it stood when this turn ended. What later turns changed or deleted goes back; what they created stays."
              : "Puts back what the run changed or deleted. Files it created stay — they are listed in the diff."}
          </p>
        </div>
      )}
    </div>
  )
}

/**
 * What the commit wrote, before it wrote it anywhere permanent.
 *
 * Nobody typed this message. Showing it is the whole of the review that is left
 * once the commit has already happened, so it is shown in full rather than
 * summarised, and as monospace rather than markdown — this is a file's worth of
 * text going into the history verbatim, and rendering it would show you
 * something the history will not have.
 */
function CommitMessageBox({ message, note }: { message: string; note: ReactNode }) {
  return (
    <div className="my-2 rounded border border-line bg-chrome px-3 py-2">
      <div className="mb-1 flex flex-wrap items-baseline gap-2 font-sans text-[10px] text-fg-dim">
        <span className="tracking-wide text-syn-var uppercase">commit message</span>
        {note}
      </div>
      <pre className="overflow-auto font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-fg">
        {message}
      </pre>
    </div>
  )
}

function CommitMessageRow({
  message,
  model,
  specChanged,
}: {
  message: string
  model: string
  specChanged: boolean
}) {
  return (
    <CommitMessageBox
      message={message}
      note={
        <>
          <span>drafted by {model}</span>
          {specChanged && <span className="text-warn">· .aide/spec.md rewritten with it</span>}
        </>
      }
    />
  )
}

/**
 * The message as it is being typed, in the box the finished one lands in.
 *
 * Deliberately not the markdown blob a chat turn's draft renders into. A commit
 * message is preformatted text with a 72-column body, and rendering it as prose
 * for ten seconds and then as a `pre` reflows the one thing the reader is in the
 * middle of reading.
 */
export function CommitMessageDraft({ text, model }: { text: string; model: string }) {
  return (
    <CommitMessageBox
      message={text}
      note={<span>{model ? `${model} is writing it` : "being written"}</span>}
    />
  )
}

/** Mirrors CheckpointRow: one line, click for exactly what was staged. */
function CommitLandedRow({ line }: { line: CommitLandedLine }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 items-baseline gap-2 rounded px-1 py-0.5 text-left hover:bg-hover"
      >
        <span className="text-diff-add-fg">●</span>
        <span className="shrink-0 text-diff-add-fg">committed {line.sha.slice(0, 7)}</span>
        <span className="shrink-0 text-fg-dim">
          {line.paths.length} file{line.paths.length === 1 ? "" : "s"}
        </span>
      </button>
      {open && (
        <pre className="mt-1 mb-2 max-h-64 overflow-auto rounded-sm bg-chrome p-2 text-[11px] leading-relaxed whitespace-pre-wrap text-fg-muted">
          {line.paths.join("\n")}
        </pre>
      )}
    </div>
  )
}

function renderLine(
  line: Line,
  onPermission?: (requestId: string, allowed: boolean) => void,
): ReactNode {
  if (line.kind === "tool") return <ToolRow key={line.seq} line={line} />
  if (line.kind === "commit-step")
    return (
      <p key={line.seq} className="flex min-w-0 items-baseline gap-2 px-1">
        <span className={line.done ? "text-ok" : "text-info"}>{line.done ? "✓" : "▸"}</span>
        <span className="min-w-0 text-fg-muted">{line.label}</span>
      </p>
    )
  if (line.kind === "commit-message")
    return (
      <CommitMessageRow
        key={line.seq}
        message={line.message}
        model={line.model}
        specChanged={line.specChanged}
      />
    )
  if (line.kind === "commit-landed") return <CommitLandedRow key={line.seq} line={line} />
  if (line.kind === "checkpoint") return <CheckpointRow key={line.seq} line={line} />
  if (line.kind === "thinking")
    return (
      <p key={line.seq} className="px-1 break-words whitespace-pre-wrap text-syn-comment italic">
        {line.text}
      </p>
    )
  if (line.kind === "user") return <UserRow key={line.seq} line={line} />
  if (line.kind === "permission")
    return <PermissionRow key={line.seq} line={line} onAnswer={onPermission} />
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
          {/* A commit run has no SDK steps to count, and "0 turns" on the end of
              one reads as a failure rather than as a category difference. */}
          {line.turns > 0 && `${line.turns} turns · `}
          {(line.ms / 1000).toFixed(1)}s · ~{money(line.cost)} est.
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
}

/**
 * The lines, cut into one box per question.
 *
 * This is what makes the pinned question hand over cleanly, and it is not
 * cosmetic: a sticky element sticks inside its own parent and nowhere else. In
 * one flat list every question would stay pinned for the rest of the
 * conversation, stacked behind the newest one — and since the boxes are
 * different heights, a taller old question would leave a strip of itself showing
 * under the new one. A box per exchange means each question is pushed out by the
 * next, which is the behaviour you already know from an editor.
 *
 * Anything before the first question — the checkpoint row, say — is its own
 * leading box, so it is never adopted by a question it came before.
 */
function groupByQuestion(lines: Line[]): Line[][] {
  const groups: Line[][] = []
  let current: Line[] | null = null
  for (const line of lines) {
    if (line.kind === "user" || current === null) {
      current = [line]
      groups.push(current)
    } else {
      current.push(line)
    }
  }
  return groups
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
  children,
}: {
  events: RunEvent[]
  /** Present only for a live chat turn; a replayed transcript cannot be answered. */
  onPermission?: (requestId: string, allowed: boolean) => void
  /**
   * The reply still streaming in, which has no event of its own yet.
   *
   * Taken as children rather than rendered after this component so it lands
   * inside the LAST question's box. Outside it, scrolling into the streaming
   * reply released the pinned question — precisely when the answer is arriving
   * and you most want to see what it is answering.
   */
  children?: ReactNode
}) {
  const groups = useMemo(() => groupByQuestion(toLines(events)), [events])

  if (groups.length === 0) {
    if (!children) return <Empty>Nothing in this transcript.</Empty>
    return <div className="space-y-1">{children}</div>
  }
  return (
    <div className="space-y-1">
      {groups.map((group, i) => (
        <section key={group[0]?.seq ?? i} className="space-y-1">
          {group.map((line) => renderLine(line, onPermission))}
          {i === groups.length - 1 && children}
        </section>
      ))}
    </div>
  )
}
