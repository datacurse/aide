import { useEffect, useMemo, useState, type ReactNode, type RefObject } from "react"
import {
  classifyFailure,
  foldRows,
  isImageAttachment,
  stripPartialTurnSummary,
  stripTurnSummary,
  timelineMeta,
  toolTarget,
  type MessageFile,
  type MessageImage,
  type RunEvent,
  type RunStatus,
  type TimelineCall,
  type TimelineMeta,
} from "@aide/protocol"
import {
  ArrowClockwise,
  ArrowUp,
  CaretRight,
  Check,
  Circle,
  GitCommit,
  Minus,
  Warning,
  X,
} from "../icons.js"
import { Markdown } from "../Markdown.js"
import { ToolTimeline } from "../ToolTimeline.js"
import { Button, Empty, money } from "../ui.js"
import type { LiveTool } from "../useRunStream.js"

/**
 * A run's event log, rendered as a conversation.
 *
 * Shared by every surface that shows one, because they are all the same thing:
 * the daemon normalizes a replayed session file into exactly the events a live
 * turn emits, so history and the message arriving right now render through one
 * component rather than two that drift.
 */

/**
 * A marker in the left-hand column of a row: a check, a cross, a caret.
 *
 * One class string, because that column only reads as a column if every icon in
 * it is the same size and sits on the same line as the text beside it. See
 * `icons.tsx` for why the nudge is there at all.
 */
const MARK = "size-3 shrink-0 translate-y-[0.15em]"

/**
 * The same marker, for a row that is a paragraph rather than a flex line.
 *
 * `inline` because Tailwind's preflight makes every `svg` a block — left at
 * that, the icon takes a line of its own and the sentence it introduces starts
 * underneath it.
 */
const INLINE_MARK = "mr-1 inline size-3 align-[-0.15em]"

/**
 * The marker for a row that has not finished: a turning ring, in the column the
 * check and the cross land in.
 *
 * It was a caret, which is a shape and not a motion — a row that had been
 * running for a minute drew exactly what a row that had just opened drew, so
 * the only thing on screen saying the tool had not wedged was the seconds
 * beside it, and a number that changes twice a second is easy to read as a
 * timestamp. The ring is the same idiom `WorkingBar` and `RunDial` already use
 * for the same claim — though "borrowed" overstates it: this and `WorkingBar`'s
 * are the same four Tailwind classes written out twice, and a change to one is a
 * change somebody has to remember to make to the other.
 *
 * A bordered `span` rather than an `svg`: `animate-spin` on a stroked icon
 * wobbles unless the artwork is exactly centred in its viewBox, and this needs
 * none of the artwork. `size-2.5` inside `size-3`'s box, centred, because a
 * ring drawn to the full 12px reads heavier than the check it alternates with.
 */
function Spinner() {
  return (
    <span className={`${MARK} flex items-center justify-center`}>
      <span className="size-2.5 animate-spin rounded-full border border-info border-t-transparent" />
    </span>
  )
}

/** tool.start and tool.end arrive separately; pair them into one line per call. */
interface ToolLine {
  kind: "tool"
  key: string
  toolUseId: string
  name: string
  input: unknown
  nested: boolean
  ok: boolean | null
  summary: string
  /**
   * When the call went out, by the daemon's clock — the same trick `VerifyLine`
   * plays, and sound for the same reason: aide is loopback-only, so there is no
   * skew between that stamp and the browser's `Date.now()`.
   */
  startedAt: number
  /** Null while it is still running; the row counts up from `startedAt` instead. */
  ms: number | null
  /**
   * Which assistant message issued this call — 1-based within its turn — and
   * whether it re-attempts a call that failed in an earlier message. The two
   * facts the timeline grid draws; `timelineMeta` in protocol derives both.
   * 0 and false for a call announced by a delta whose event has not landed.
   */
  message: number
  retry: boolean
  /**
   * The target a `tool.target` delta named, for a row whose event — and so
   * whose `input` — has not arrived. It is what lets the live dot sit on its
   * real file row, and the live flat row name its file, instead of both
   * showing a placeholder until the message completes.
   */
  liveTarget?: string
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
  key: string
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
  key: string
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
  key: string
  text: string
  images: MessageImage[]
  files: MessageFile[]
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
  key: string
  label: string
  done: boolean
}
/** What was committed, and what it took. */
interface CommitLandedLine {
  kind: "commit-landed"
  key: string
  sha: string
  paths: string[]
}
/** What was pushed, and where. The moment work left the machine. */
interface PushLandedLine {
  kind: "push-landed"
  key: string
  branch: string
  pushed: number
}
/**
 * One of the project's own checks, run by aide rather than by the agent.
 *
 * Opened by `verify.started` and settled in place by `verify.result`, the same
 * way a tool row is. Before it was opened on the result alone, a check was a row
 * that did not exist until it was over — so the longest wait in a commit was the
 * one part of it with nothing on screen.
 */
interface VerifyLine {
  kind: "verify"
  key: string
  command: string
  /** Null while it is still running. */
  ok: boolean | null
  exitCode: number | null
  /** Null while it is still running; the row counts up from `startedAt` instead. */
  ms: number | null
  /**
   * When the check was spawned, by the daemon's clock.
   *
   * Compared against the browser's `Date.now()`, which is only sound because
   * both are this machine — aide is loopback-only by design, so there is no skew
   * to correct for. Zero for a row that had no start event to open it.
   */
  startedAt: number
  output: string
}
interface OutcomeLine {
  kind: "outcome"
  key: string
  status: RunStatus
  subtype: string
  turns: number
  ms: number
  cost: number
  /** Why it failed, when the SDK said. Empty for a turn that went fine, and for
   * every outcome logged before `run.finished` carried this. */
  errors: string[]
}
/**
 * A block of prose, from either copy of it.
 *
 * Keyed by its position within its run — the third thing the model said on run X
 * — rather than by the event's seq like every other row. That is the whole trick
 * behind `LiveText` below: the copy being typed has no seq yet, so a block's
 * ordinal is the only name both copies can agree on.
 */
interface BlockLine {
  kind: "text" | "thinking"
  key: string
  text: string
  nested: boolean
}

/**
 * The reply as it is being typed, before it is an event.
 *
 * Rendered as an ordinary block line rather than tacked on after the list, and
 * that is the point: the finished `assistant.text` is the same block of the same
 * run, so it arrives with the same key in the same place and React updates the
 * node it is already in. Two different nodes was the bug — the streamed copy was
 * torn down and a byte-identical one built beside it, and a selection anchored
 * in the old one snapped back to the start of the reply. It happened at every
 * tool call, because every tool call ends a block.
 */
export interface LiveText {
  runId: string
  thinking: string
  text: string
  /**
   * Calls the model has opened but whose events have not landed. Keyed by
   * `toolUseId` — the same id the event carries — so when it does land the row
   * is updated in place rather than swapped for an identical one, which is the
   * same reason the two blocks above are keyed by ordinal.
   */
  tools: LiveTool[]
}
/**
 * A run of consecutive tool calls, drawn as one row you can open.
 *
 * The transcript's problem was never that it lacked a concise reading — the
 * closing prose IS that reading, and it was correct — but that it sat under
 * thirty rows of derivation with no more visual weight than a `Grep` that
 * matched nothing. A turn of 34 tool calls and a turn of 2 read the same until
 * you had scrolled both.
 *
 * This is the opposite trade to the card that was tried and removed. A card was
 * FIXED-SIZE and MODEL-WRITTEN: it spent the same three lines on every turn, so
 * it carried least where there was most, and what it said could be wrong about
 * the very rows it replaced. A fold is variable-size and derived — it counts
 * calls and sums stamps off the event log, asserts nothing, and hides nothing,
 * because `steps` holds the original `ToolLine`s and opening it renders exactly
 * the rows that were there before. The compression is structural, not semantic,
 * which is the only kind that cannot lie about the turn.
 */
interface StepsLine {
  kind: "steps"
  key: string
  /** The run as it happened, calls and narration interleaved — what opening draws. */
  rows: Line[]
  /** The calls alone, for the closed row's label. */
  steps: ToolLine[]
  /** Reasoning blocks inside the run, counted so the label can admit to them. */
  thought: number
  /**
   * A commit rather than a turn's derivation — drawn as its own kind of row.
   *
   * The closed row has to say how the commit ENDED, because that is the fact you
   * would otherwise open it for: a sha and a file count, or that it was refused.
   * A fold you must expand to learn whether it worked is a fold nobody leaves
   * closed.
   */
  commit?: {
    sha: string | null
    paths: number
    pushed: string | null
    checks: number
    failed: boolean
  }
  /**
   * This fold is the live turn's, and it is the last thing in the transcript —
   * the state in which the model is composing its next message and the grid
   * would otherwise look identical to a stale one. Set by `foldSteps`; the
   * timeline draws its thinking indicator from it.
   */
  live?: boolean
}
type Line =
  | ToolLine
  | StepsLine
  | OutcomeLine
  | BlockLine
  | UserLine
  | CheckpointLine
  | { kind: "denied"; key: string; name: string; reason: string }
  | PermissionLine
  | { kind: "retry"; key: string; text: string }
  | { kind: "error"; key: string; text: string }
  | CommitStepLine
  | CommitLandedLine
  | PushLandedLine
  | { kind: "commit-message"; key: string; message: string; model: string }
  | { kind: "stale"; key: string; supervised: boolean }
  | VerifyLine
  /** A declared check the diff could not break. Shown, so the gate reads whole. */
  | { kind: "verify-skipped"; key: string; command: string; reason: string }

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

/**
 * Group runs of consecutive tool calls into one openable row.
 *
 * A separate pass over the finished lines rather than a branch inside `toLines`,
 * because everything that makes those lines correct — the run-scoped keys, the
 * live-delta matching, the block ordinals — is decided there and would have to be
 * reasoned about twice if this were interleaved. Here the input is already right
 * and the only question is which neighbours travel together.
 *
 * The rule itself is `foldRows` in protocol, where `pnpm smoke` can reach it;
 * this is the part that knows what a row looks like on screen.
 */
function foldSteps(lines: Line[], live: boolean): Line[] {
  const out = foldRows(lines, live).map((r) => {
    if (!r.folded) return r.row
    const rows = r.group.rows as Line[]
    const line: StepsLine = {
      kind: "steps",
      key: `steps:${rows[0]?.key ?? ""}`,
      rows,
      steps: r.group.steps as ToolLine[],
      thought: rows.filter((x) => x.kind === "thinking").length,
    }
    if (!r.group.commit) return line

    // Read off the rows themselves rather than carried down from the events, so
    // the closed row and the opened one cannot disagree about what happened.
    const landed = rows.find((x) => x.kind === "commit-landed")
    const pushed = rows.find((x) => x.kind === "push-landed")
    const checks = rows.filter((x) => x.kind === "verify")
    return {
      ...line,
      commit: {
        sha: landed?.kind === "commit-landed" ? landed.sha : null,
        paths: landed?.kind === "commit-landed" ? landed.paths.length : 0,
        pushed: pushed?.kind === "push-landed" ? pushed.branch : null,
        checks: checks.length,
        failed: checks.some((c) => c.kind === "verify" && c.ok === false),
      },
    }
  })
  // Only the LAST line, and only while the turn runs: the fold with rows still
  // arriving under it is the one place "is that stale, or is Claude thinking"
  // gets asked, and any fold above it is by definition settled.
  const last = out[out.length - 1]
  if (live && last !== undefined && last.kind === "steps" && !last.commit) last.live = true
  return out
}

function toLines(
  events: RunEvent[],
  live: LiveText | null | undefined,
  meta: Map<string, TimelineMeta>,
): Line[] {
  const lines: Line[] = []
  const byToolId = new Map<string, ToolLine>()
  const byRequestId = new Map<string, PermissionLine>()
  let openVerify: VerifyLine | null = null

  // The run has to be in the key, not just the seq. History is numbered from 1
  // for the whole session and a run's own log is numbered from 1 for that run,
  // and this list is the two concatenated — so `seq: 3` names two different rows
  // the moment a turn has been sent in this sitting. Duplicate keys among
  // siblings let React map a fiber onto the wrong row and rebuild DOM that did
  // not change, which is the same way a selection dies.
  const rowKey = (e: RunEvent): string => `${e.runId}:${e.seq}`

  // Looked up while building the rows, so a call that was drawn from a delta
  // keeps the stamp it started counting from once its event arrives.
  const liveTools = new Map((live?.tools ?? []).map((t) => [t.toolUseId, t]))

  // Counted over every event, not over the slice that ends up on screen: an
  // ordinal that shifts when the head of a long transcript is trimmed would
  // re-key — and so remount — every block below it on each new event.
  const blocks = new Map<string, number>()
  const blockKey = (runId: string, kind: string): string => {
    const at = `${runId}:${kind}`
    const n = blocks.get(at) ?? 0
    blocks.set(at, n + 1)
    return `${at}:${n}`
  }

  for (const e of events) {
    switch (e.type) {
      case "user.message":
        lines.push({
          kind: "user",
          key: rowKey(e),
          text: e.text,
          images: e.images ?? [],
          files: e.files ?? [],
        })
        break
      case "assistant.text":
        lines.push({
          kind: "text",
          key: blockKey(e.runId, "text"),
          // Stripped HERE and not before the log, so `~/.aide/runs` keeps the
          // reply exactly as the model wrote it. The card draws these fields
          // above the conversation; leaving them in would print them twice, the
          // second time as pseudo-YAML under the prose.
          text: stripTurnSummary(e.text),
          nested: !!e.parentToolUseId,
        })
        break
      case "assistant.thinking":
        lines.push({
          kind: "thinking",
          key: blockKey(e.runId, "thinking"),
          text: e.text,
          nested: false,
        })
        break
      case "tool.start": {
        // The one row not keyed by seq, because it is the one row that can
        // already be on screen before its event exists: a `tool` delta draws it
        // the moment the model opens the call. Keyed on the id both copies
        // share, React updates that node in place instead of tearing down a
        // counting row and building an identical one beside it.
        const live = liveTools.get(e.toolUseId)
        const line: ToolLine = {
          kind: "tool",
          key: `tool:${e.runId}:${e.toolUseId}`,
          toolUseId: e.toolUseId,
          name: e.name,
          input: e.input,
          nested: !!e.parentToolUseId,
          message: meta.get(e.toolUseId)?.message ?? 0,
          retry: meta.get(e.toolUseId)?.retry ?? false,
          ok: null,
          summary: "",
          // The delta's stamp when there was one. This event is appended once
          // the whole assistant message is complete, which is LATER — often by
          // the length of the call itself — so preferring it would show a row
          // that had been counting for twenty seconds start again from zero.
          startedAt: live?.startedAt ?? e.ts,
          ms: null,
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
          // Subtracted from the two stamps rather than carried on the event: the
          // SDK reports a tool result, not a timing, so the daemon has nothing to
          // put in such a field that this does not already say. Guarded because a
          // replayed session file can pair an end with a start it did not see,
          // and `ts - 0` would print the row as fifty-six years old.
          if (line.startedAt > 0) line.ms = Math.max(0, e.ts - line.startedAt)
        }
        break
      }
      case "checkpoint.taken":
        lines.push({
          kind: "checkpoint",
          key: rowKey(e),
          ref: e.ref,
          sha: e.sha,
          dirtyCount: e.dirtyCount,
          restore: e.restore,
        })
        break
      case "turn.checkpoint":
        lines.push({
          kind: "checkpoint",
          key: rowKey(e),
          ref: e.ref,
          sha: e.sha,
          turn: e.n,
          restore: e.restore,
        })
        break
      case "turn.stale":
        lines.push({ kind: "stale", key: rowKey(e), supervised: e.supervised })
        break
      case "permission.request": {
        const line: PermissionLine = {
          kind: "permission",
          key: rowKey(e),
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
        lines.push({ kind: "commit-step", key: rowKey(e), label: e.label, done: false })
        break
      // A step like any other to read. It is its own event because of what it
      // says to the pane around this one — that what is streaming now is a
      // commit message — and not because it deserves a row of its own shape.
      case "commit.drafting":
        lines.push({
          kind: "commit-step",
          key: rowKey(e),
          label: `writing the message · ${e.model}`,
          done: false,
        })
        break
      case "commit.drafted":
        lines.push({
          kind: "commit-message",
          key: rowKey(e),
          message: e.message,
          model: e.model,
        })
        break
      case "push.landed":
        lines.push({ kind: "push-landed", key: rowKey(e), branch: e.branch, pushed: e.pushed })
        break
      case "commit.landed":
        lines.push({ kind: "commit-landed", key: rowKey(e), sha: e.sha, paths: e.paths })
        break
      case "verify.skipped":
        lines.push({
          kind: "verify-skipped",
          key: rowKey(e),
          command: e.command,
          reason: e.reason,
        })
        break
      case "verify.started": {
        const line: VerifyLine = {
          kind: "verify",
          key: rowKey(e),
          command: e.command,
          ok: null,
          exitCode: null,
          ms: null,
          startedAt: e.ts,
          output: "",
        }
        // One slot, not a map: `runChecks` runs the commands in series and stops
        // at the first failure, so at most one check is ever in flight.
        openVerify = line
        lines.push(line)
        break
      }
      case "verify.result": {
        // Settle the row its start opened. The fallback is not defensive
        // padding: every transcript written before `verify.started` existed
        // carries only this half, and has to keep rendering.
        if (openVerify && openVerify.command === e.command) {
          openVerify.ok = e.ok
          openVerify.exitCode = e.exitCode
          openVerify.ms = e.durationMs
          openVerify.output = e.output
          openVerify = null
          break
        }
        lines.push({
          kind: "verify",
          key: rowKey(e),
          command: e.command,
          ok: e.ok,
          exitCode: e.exitCode,
          ms: e.durationMs,
          startedAt: 0,
          output: e.output,
        })
        break
      }
      case "tool.denied":
        lines.push({ kind: "denied", key: rowKey(e), name: e.name, reason: e.reason })
        break
      case "run.retry":
        lines.push({
          kind: "retry",
          key: rowKey(e),
          text: `retry ${e.attempt}/${e.maxRetries} in ${e.retryDelayMs}ms — ${e.error}`,
        })
        break
      case "run.error":
        lines.push({ kind: "error", key: rowKey(e), text: e.message })
        break
      case "run.finished":
        lines.push({
          kind: "outcome",
          key: rowKey(e),
          status: e.status,
          subtype: e.subtype,
          turns: e.numTurns,
          ms: e.durationMs,
          cost: e.totalCostUsd,
          // Not for a run you stopped. The SDK still reports WHY its stream
          // ended, and for an interrupt that reason is the interrupt — so the
          // row said "interrupted by you" and then contradicted itself with an
          // error underneath, which reads as the turn having failed on top of
          // being stopped. The header already carries the outcome; the raw
          // string is still in the log for anyone reading that.
          errors: e.status === "cancelled" ? [] : (e.errors ?? []),
        })
        break
      default: {
        // Drawn by nothing, ON PURPOSE, and the assignment is what makes that a
        // statement rather than an oversight. Every other event above turns into
        // a row; a new one added to `RunEventBody` and forgotten here used to
        // render as nothing at all — no error, no blank row, no failing check,
        // just an event the transcript silently did not mention.
        //
        // So the two that legitimately draw nothing are named, and anything else
        // reaching this arm fails to compile until somebody decides which it is.
        // `assistant.start` exists only for its timestamp (see `RunEventBody`),
        // and `run.started` carries the session id for the resume handle — the
        // reader learns nothing from a row saying a run it is already reading
        // has begun.
        // `turn.summary` is the third: it is the CARD's layer, drawn above the
        // conversation, and its text is already in the reply this transcript
        // renders — `stripTurnSummary` takes the fenced block out of that reply
        // so the same four fields do not appear twice on one screen, once as a
        // card and once as pseudo-YAML at the end of a message.
        const drawnByNothing: "assistant.start" | "run.started" | "turn.summary" = e.type
        void drawnByNothing
        break
      }
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
  const settled =
    outcomeAt === -1 ? lines : lines.filter((l, i) => !(l.kind === "error" && i > outcomeAt))

  // Appended last, and after both passes above, so the two blocks still being
  // typed cannot be mistaken for a step that something came after.
  if (live?.thinking) {
    settled.push({
      kind: "thinking",
      key: blockKey(live.runId, "thinking"),
      text: live.thinking,
      nested: false,
    })
  }
  if (live?.text) {
    settled.push({
      kind: "text",
      key: blockKey(live.runId, "text"),
      // The partial form: mid-stream the closing fence has not arrived, so the
      // ordinary strip matches nothing and the reader watches the block's own
      // field names type themselves out.
      text: stripPartialTurnSummary(live.text),
      nested: false,
    })
  }
  // After the prose, because that is the order they were produced in: the model
  // says what it is about to do and then opens the call. Only ones the log has
  // not caught up with — `useRunStream` drops each as its `tool.start` arrives,
  // and rendering both copies would show the same call twice for the frame
  // between them.
  for (const t of live?.tools ?? []) {
    if (byToolId.has(t.toolUseId)) continue
    settled.push({
      kind: "tool",
      // The same key the event's row will take, which is what makes the handover
      // an update rather than a swap.
      key: `tool:${live?.runId}:${t.toolUseId}`,
      toolUseId: t.toolUseId,
      name: t.name,
      // The delta cannot carry arguments — see `RunDelta`. So the row names the
      // tool and counts, and fills in what it touched when the event lands.
      input: null,
      nested: false,
      // Not yet logged, so no message ordinal — the grid resolves 0 to the
      // column the streaming message will become.
      message: 0,
      retry: false,
      // Spread conditionally so absent stays absent rather than `undefined`.
      ...(t.target !== undefined ? { liveTarget: t.target } : {}),
      ok: null,
      summary: "",
      startedAt: t.startedAt,
      ms: null,
    })
  }
  return settled
}

/**
 * A row you can both read and click.
 *
 * Every collapsible row here used to be a `<button>` wrapping its own text, and
 * a browser will not start a selection inside a button — so the one line naming
 * the file a run touched was the one line you could not drag your cursor across.
 * A plain div gets the text back; this is the other half of the trade, because
 * releasing a drag inside it also fires a click, and expanding a row you were
 * only trying to copy is exactly as annoying as the thing it replaced.
 */
function toggleUnlessSelecting(setOpen: (f: (v: boolean) => boolean) => void) {
  const sel = window.getSelection()
  if (sel && !sel.isCollapsed) return
  setOpen((v) => !v)
}

/** Shorten one target for a one-line row: a command whole, a path to its tail. */
function shortTarget(name: string, target: string): string {
  const short = name === "Bash" ? target : target.split(/[/\\]/).slice(-2).join("/")
  return short.length > 90 ? `${short.slice(0, 90)}…` : short
}

/** One-line preview of a tool's arguments — enough to know what it touched. */
function describeInput(name: string, input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>
  const first =
    o["command"] ?? o["file_path"] ?? o["pattern"] ?? o["path"] ?? o["url"] ?? o["prompt"]
  return typeof first === "string" ? shortTarget(name, first) : ""
}

/**
 * How long something took, in the units a reader of that duration wants.
 *
 * Shared by the two kinds of row that time something — a tool call and a check —
 * because a transcript where 1.4s and 1400ms both appear reads as two different
 * measurements of two different things.
 */
function took(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

/**
 * Not shown on every row: the great majority of tool calls are a Read or an Edit
 * that lands in single-digit milliseconds, and a duration against each of those
 * is a column of noise you have to look past to find the Bash that took a minute.
 * Above the threshold it is the most useful thing on the line.
 */
const SLOW_TOOL_MS = 2000

/**
 * A folded run of tool calls: what it was made of, what it wrote, how long it
 * took. Closed by default — see `StepsLine` for why this is not the card.
 */
/**
 * A commit, closed: what it did, in one line, with a clear top and bottom.
 *
 * Bordered rather than drawn as a plain row — this is the one thing in a
 * transcript that is neither the model talking nor a tool it called, and the
 * complaint that produced it was that a commit had no visible beginning or end.
 * A box has both. Open, the same border wraps every row it contains, so the
 * episode still reads as one thing at whichever size you are looking at.
 */
function CommitFold({ line }: { line: StepsLine & { commit: NonNullable<StepsLine["commit"]> } }) {
  const [open, setOpen] = useState(false)
  const c = line.commit
  const tone = c.failed && !c.sha ? "text-err" : c.sha ? "text-diff-add-fg" : "text-fg-muted"

  return (
    <div className="my-1.5 overflow-hidden rounded border border-line">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 items-baseline gap-2 bg-chrome px-2 py-1 text-left text-[11px] hover:bg-hover"
      >
        <CaretRight
          className={`${MARK} shrink-0 text-fg-dim transition-transform ${open ? "rotate-90" : ""}`}
        />
        <GitCommit className={`${MARK} ${tone}`} />
        <span className={`shrink-0 ${tone}`}>
          {c.sha ? `committed ${c.sha.slice(0, 7)}` : c.failed ? "commit refused" : "commit"}
        </span>
        <span className="min-w-0 truncate text-fg-dim">
          {c.paths > 0 && `${c.paths} file${c.paths === 1 ? "" : "s"}`}
          {c.checks > 0 && `${c.paths > 0 ? " · " : ""}${c.checks} check${c.checks === 1 ? "" : "s"}`}
          {c.pushed && <span className="text-diff-add-fg"> · pushed {c.pushed}</span>}
        </span>
      </button>
      {open && (
        // The originals, unchanged — including the message box, which is the
        // whole of the review left once a commit has happened and so is shown in
        // full HERE rather than trimmed. Closed, it costs one line; open, it is
        // exactly what it always was.
        <div className="border-t border-line px-2 py-1">
          {line.rows.map((r) => renderLine(r))}
        </div>
      )}
    </div>
  )
}

function StepsRow({ line }: { line: StepsLine }) {
  const [open, setOpen] = useState(false)
  // Summed rather than measured end-to-end: calls in one message run
  // concurrently, so the span would report wall-clock the turn did not spend
  // waiting on these. The same distinction the dashboard draws between its
  // `agent time` tile and its share bar.
  const ms = line.steps.reduce((n, s) => n + (s.ms ?? 0), 0)
  /**
   * The grid charts the main loop only. A subagent's calls interleave with it
   * in real time, so drawing them on the same message axis would split one
   * round trip into several — the `Agent` call itself is the dot, and the
   * subagent's work stays behind the fold, nested where it always was. What
   * the closed row used to spell out — which tools, what was written, what
   * failed — the grid now shows persistently: edited files always keep their
   * own row, and a failure is a red dot you cannot scroll past.
   */
  const gridCalls: TimelineCall[] = line.steps
    .filter((s) => !s.nested)
    .map((s) => ({
      id: s.toolUseId,
      message: s.message,
      tool: s.name,
      // A live row's input is null until its event lands; the target its
      // delta named is what puts the dot on the right file row NOW rather
      // than on a placeholder for the length of the call.
      target: s.input !== null ? toolTarget(s.name, s.input) : (s.liveTarget ?? ""),
      status: s.ok === null ? "busy" : s.ok ? "ok" : "err",
      failTag: s.ok === false ? classifyFailure(s.name, s.summary) : null,
      retry: s.retry,
    }))

  /**
   * A dot was clicked: the flat list is the detail view, so open it and put
   * that call's row mid-pane. Two frames, because the rows do not exist in the
   * document until the open has rendered and painted.
   */
  const openCall = (id: string) => {
    setOpen(true)
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-callid="${CSS.escape(id)}"]`)
        if (!(el instanceof HTMLElement)) return
        el.scrollIntoView({ block: "center", behavior: "smooth" })
        el.animate(
          [{ backgroundColor: "rgba(240, 210, 122, 0.18)" }, { backgroundColor: "transparent" }],
          { duration: 900 },
        )
      }),
    )
  }

  return (
    <div>
      {gridCalls.length > 0 && (
        <ToolTimeline calls={gridCalls} live={line.live ?? false} onOpenCall={openCall} />
      )}
      {/* 11px, the same as the rows it stands for — a fold that shouted louder
          than its own contents would be the derivation getting MORE weight for
          being collapsed. A fold can hold no calls at all — a turn that
          reasons at length and then answers — so the label names whichever it
          actually contains rather than reporting "0 steps" over a page of
          hidden thinking. */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 items-baseline gap-2 rounded px-1 py-0.5 text-left text-[11px] text-fg-dim hover:bg-hover hover:text-fg-muted"
      >
        {open ? <Minus className={MARK} /> : <CaretRight className={`${MARK} text-fg-dim`} />}
        <span className="shrink-0">
          {open ? "hide" : "show"}{" "}
          {line.steps.length > 0
            ? `${line.steps.length} step${line.steps.length === 1 ? "" : "s"}`
            : "thinking"}
        </span>
        {/* Named, not just counted: the grid draws calls and not reasoning, so
            the thinking is the one thing this line still has to admit to. */}
        {!open && line.thought > 0 && (
          <span className="min-w-0 truncate">
            thought {line.thought > 1 ? `${line.thought}×` : ""}
          </span>
        )}
        {!open && ms >= SLOW_TOOL_MS && <span className="shrink-0">{took(ms)}</span>}
      </button>
      {/* The originals, in the order they happened — not a rendering of the
          summary. This is the whole claim that nothing is lost by folding, and
          `rows` rather than steps-then-asides is what keeps it true: joining
          the two lists put every remark after every call, so an opened fold
          said "Clean." about work that had not run yet. */}
      {open && line.rows.map((r) => renderLine(r))}
    </div>
  )
}

function ToolRow({ line }: { line: ToolLine }) {
  const running = line.ok === null
  const mark = running ? (
    <Spinner />
  ) : line.ok ? (
    <Check className={`${MARK} text-ok`} />
  ) : (
    <X className={`${MARK} text-err`} />
  )
  const [open, setOpen] = useState(false)
  /**
   * A row drawn from a `tool` delta has a name and nothing else — the arguments
   * are still streaming as partial JSON. Left expandable it would open onto
   * "null", which reads as a call that was made with no arguments rather than as
   * one whose arguments have not arrived.
   */
  const detailed = line.input !== null

  return (
    // `data-callid` is how a clicked timeline dot finds this row to scroll to.
    <div data-callid={line.toolUseId} className={line.nested ? "ml-4 border-l border-line pl-3" : ""}>
      <div
        onClick={() => detailed && toggleUnlessSelecting(setOpen)}
        className={`flex min-w-0 items-baseline gap-2 rounded px-1 py-0.5 hover:bg-hover ${detailed ? "cursor-pointer" : ""}`}
      >
        {mark}
        {/* 11px, matching the argument beside it rather than inheriting the
            container's 12px. Two sizes on one row read as two separate things,
            and the louder half was the tool NAME — the least informative token
            on the line. Mono also carries more weight than sans at the same
            nominal size, so a 12px `Bash` shouted over the 13px sentence
            explaining what it found; the derivation has to sit under the prose,
            not over it. */}
        <span className="shrink-0 text-[11px] text-syn-func">{line.name}</span>
        {/* min-w-0 is what makes `truncate` real: a flex child defaults to
            min-width:auto and refuses to shrink below its content, so without it
            the row grows to fit the command and drags the whole pane sideways. */}
        <span className="min-w-0 truncate text-[11px] text-syn-string">
          {line.input !== null
            ? describeInput(line.name, line.input)
            : // The delta-named target, until the event brings the arguments.
              line.liveTarget
              ? shortTarget(line.name, line.liveTarget)
              : ""}
        </span>
        {/* The same counter a running check gets, for the same reason: without it
            a Bash that hangs for a minute and a Read that returns instantly were
            the same picture, and the only thing on screen that was going
            anywhere was the one bar at the bottom of the pane naming the tool.
            It counts from when the model OPENED the call rather than from when
            the event was appended — see the `tool` delta — because the event is
            written once the whole assistant message is done, which for a call
            announced mid-reply is after the call has already run. */}
        {running
          ? line.startedAt > 0 && <RunningFor since={line.startedAt} />
          : line.ms !== null &&
            line.ms >= SLOW_TOOL_MS && <span className="shrink-0 text-fg-dim">{took(line.ms)}</span>}
      </div>
      {open && detailed && (
        <pre className="mt-1 mb-2 max-h-64 overflow-auto rounded-sm bg-chrome p-2 text-[11px] leading-relaxed whitespace-pre-wrap text-fg-muted">
          {JSON.stringify(line.input, null, 2)}
          {line.summary ? `\n\n--- result ---\n${line.summary}` : ""}
        </pre>
      )}
    </div>
  )
}

/**
 * The question, in the place it was asked.
 *
 * Never the thing that gets pinned, even though it is what the pin shows. This
 * row used to be `position: sticky` itself, and that is what was ripped out: a
 * pinned block is an opaque overlay sitting on top of the answer, so a drag that
 * crossed it hit-tested into the question and the highlight leapt to a line the
 * reader could not see. A transcript is text to be read and copied first, and a
 * header second — so the row stays in the flow, whole and selectable, and
 * `StickyQuestion` draws a second clipped copy that answers no pointer at all.
 *
 * `data-question` is how that copy finds it: which question you are under is
 * decided by where this row actually is on screen, not by counting events.
 */
function UserRow({ line }: { line: UserLine }) {
  const [zoom, setZoom] = useState(false)

  // Partitioned by what the bytes ARE, never by which field carried them. The
  // `images` field is trusted nowhere: logs written by a daemon from before the
  // image/file split filed every attachment under it, and those logs are
  // permanent — an <img> over an HTML file's bytes draws a broken icon
  // captioned by its own alt text, which reads as the app lying about what was
  // attached. A misfiled entry has no name to show, so its chip says the media
  // type, which is everything the log kept.
  const pictures = line.images.filter(isImageAttachment)
  const chips = [
    ...line.images.filter((i) => !isImageAttachment(i)).map((i) => i.mediaType),
    ...line.files.map((f) => f.name),
  ]

  return (
    <div
      data-question=""
      className="my-2 border-b-line border-l-syn-var border-b border-l-2 bg-chrome px-3 py-1.5"
    >
      <div className="mb-0.5 font-sans text-[10px] tracking-wide text-syn-var uppercase">you</div>
      {pictures.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {pictures.map((img, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setZoom((v) => !v)}
              title={zoom ? "Shrink it" : "Show it full size"}
              className={zoom ? "cursor-zoom-out" : "cursor-zoom-in"}
            >
              <img
                src={`data:${img.mediaType};base64,${img.data}`}
                alt="attached image"
                className={`w-auto rounded-sm border border-line ${zoom ? "max-h-80" : "h-12"}`}
              />
            </button>
          ))}
        </div>
      )}
      {/* Files show as named chips, not pictures: their bytes went to a folder
          on the agent's machine, and which file it was is the whole answer a
          reader needs here. */}
      {chips.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {chips.map((label, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1 rounded border border-line bg-input px-1.5 py-0.5 font-sans text-[11px] text-fg-muted"
            >
              {label}
            </span>
          ))}
        </div>
      )}
      <Markdown text={line.text} />
    </div>
  )
}

/**
 * The question you are reading the answer to, pinned to the top of the pane.
 *
 * A second, clipped copy of the row rather than the row itself, and that is the
 * whole of the design: taking no pointer events means a selection dragged across
 * it lands in the answer underneath, which is where the reader was aiming,
 * instead of jumping into a question whose remaining lines are not even on
 * screen. The price is a bar you cannot select — the right price, because the
 * question is still down there in the flow, and that is the copy worth copying.
 */
function StickyQuestion({ text }: { text: string }) {
  return (
    // Zero height, so a bar that comes and goes as you scroll never reflows the
    // transcript under it. Full-bleed, because the pane's own padding would
    // otherwise leave a gutter down each side for the transcript to slide
    // through, and text moving beside a bar that is standing still reads as a
    // rendering fault rather than as a header.
    <div className="sticky top-0 z-10 -mx-3 h-0">
      <div className="pointer-events-none absolute inset-x-0 top-0 border-b-line border-l-syn-var border-b border-l-2 bg-chrome px-3 py-1.5 shadow-md">
        <div className="mb-0.5 font-sans text-[10px] tracking-wide text-syn-var uppercase">you</div>
        {/* Clipped, and plain. A long question would otherwise eat the pane it
            is meant to be a header for, and markdown with its middle cut off is
            not the question either. Trimmed because three lines is a small
            budget, and a message that opens with a blank line spends one. */}
        <p className="line-clamp-3 break-words whitespace-pre-wrap text-fg-muted">{text.trim()}</p>
      </div>
    </div>
  )
}

/**
 * Which question the reader is under: the last one whose row has left the top of
 * the pane completely.
 *
 * Measured off the rows themselves rather than carried as an offset, because a
 * transcript's rows change height under you constantly — a tool row opens, the
 * reply grows a paragraph, the pane is dragged narrower — and an offset worked
 * out once is wrong a moment later.
 *
 * -1 for as long as the newest question is still on screen, and then nothing is
 * drawn: the same question in two places at once is worse than no pin at all,
 * and that is exactly what a copy would be the whole time you are reading the
 * original.
 */
function useStuckQuestion(
  root: HTMLElement | null,
  scroller: RefObject<HTMLElement | null> | undefined,
): number {
  const [at, setAt] = useState(-1)

  useEffect(() => {
    const port = scroller?.current
    if (!root || !port) return

    let frame = 0
    const measure = () => {
      frame = 0
      // The fold is the top edge of the scrollport, not the top of the
      // transcript: the pane has a header above it and padding inside it, and
      // measuring against either puts the handover a few pixels out — which is
      // one flicker of the wrong question at every question.
      const fold = port.getBoundingClientRect().top
      const rows = Array.from(root.querySelectorAll<HTMLElement>("[data-question]"))
      // The first row still showing something; everything before it is past the
      // fold. findIndex stops there, so this reads one rectangle more than it
      // has to and no more.
      const showing = rows.findIndex((row) => row.getBoundingClientRect().bottom > fold)
      setAt(showing === -1 ? rows.length - 1 : showing - 1)
    }
    // One measurement per frame. Scroll fires far faster than the screen
    // redraws, and each measurement reads layout back out of the browser.
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }

    measure()
    port.addEventListener("scroll", schedule, { passive: true })
    // Not on scroll alone: a reply streaming in, a tool row opened above, or the
    // window resized all move a question across the fold without one.
    const resize = new ResizeObserver(schedule)
    resize.observe(root)
    resize.observe(port)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      port.removeEventListener("scroll", schedule)
      resize.disconnect()
    }
  }, [root, scroller])

  return at
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
      <div
        onClick={() => toggleUnlessSelecting(setOpen)}
        className="flex min-w-0 cursor-pointer items-baseline gap-2 rounded px-1 py-0.5 hover:bg-hover"
      >
        <Check className={`${MARK} text-ok`} />
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
      </div>
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

function CommitMessageRow({ message, model }: { message: string; model: string }) {
  return <CommitMessageBox message={message} note={<span>drafted by {model}</span>} />
}

/**
 * This turn changed the daemon, so the daemon you are talking to is behind.
 *
 * Written as what happens NEXT, not as what is true now, and the distinction is
 * the whole row: a supervised daemon restarts within a couple of seconds of the
 * turn ending, which is precisely when this is being read. "The daemon is
 * running older code" would be a sentence that is false by the time it is
 * finished, and the reader would be left doing the thing it was trying to spare
 * them — restarting something by hand that had already restarted itself.
 *
 * Not an error colour. Needing a restart is the ordinary outcome of editing a
 * long-lived process, and the supervised case needs nothing from anybody.
 */
function StaleRow({ supervised }: { supervised: boolean }) {
  return (
    <p className="flex min-w-0 items-baseline gap-2 px-1 py-0.5">
      <ArrowClockwise className={`${MARK} text-warn`} />
      <span className="min-w-0 font-sans text-[11px] leading-relaxed text-fg-muted">
        {supervised
          ? "This turn changed the daemon, so it is restarting now that the turn is done. Give it a second and the change is live — you do not have to do anything."
          : "This turn changed the daemon, and this one was started by hand — nothing here will restart it. Until you do, aide keeps serving the code it booted with."}
      </span>
    </p>
  )
}

/**
 * A check aide ran, and what it printed.
 *
 * Open by default when it FAILED, closed when it passed. The two are not the
 * same kind of row: a green check is a fact you want counted and not read, and a
 * failing one is the only thing on screen worth reading — making that one click
 * away would be hiding the answer to the question the whole gate exists to ask.
 */
/**
 * Seconds since a call or a check started, ticking.
 *
 * A number that moves is the cheapest possible proof the run has not wedged —
 * the same job `WorkingBar` does for a turn, needed again per row because the
 * bar names only the one call in flight, and a transcript is read by scrolling
 * back through the rows above it. Its own component so the interval exists only
 * while something is actually running, and unmounts with the row that settles.
 */
function RunningFor({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [])
  // Clamped, because a row replayed from a log written moments ago can briefly
  // compute a negative age, and "-1s" reads as a bug rather than as a start.
  return <span className="shrink-0 text-fg-dim">{Math.max(0, Math.round((now - since) / 1000))}s</span>
}

function VerifyRow({ line }: { line: VerifyLine }) {
  const running = line.ok === null
  /**
   * Derived rather than stored, with a click as an override.
   *
   * `useState(!line.ok)` was right when a row arrived already finished. It is
   * wrong now that a row starts life running: `!null` is true, so every check
   * would spring open the moment it passed, having initialised from a state it
   * was only passing through.
   */
  const [override, setOverride] = useState<boolean | null>(null)
  const open = override ?? line.ok === false
  const seconds = line.ms === null ? "" : took(line.ms)
  // The row is 11px, matching a tool row: a check and a call sit next to each
  // other in a commit, and one of the two rendering larger reads as a difference
  // in kind rather than in typography.
  return (
    <div>
      <div
        // Through the same guard every collapsible row uses, so dragging a
        // selection across a check's output does not fold it away mid-drag.
        onClick={() => toggleUnlessSelecting((flip) => setOverride(flip(open)))}
        className="flex min-w-0 cursor-pointer items-baseline gap-2 rounded px-1 py-0.5 text-[11px] hover:bg-hover"
      >
        {/* A spinner while it runs, the same marker a tool call and a commit
            step in flight use, so "this one is happening now" reads the same
            everywhere. */}
        {running ? (
          <Spinner />
        ) : line.ok ? (
          <Check className={`${MARK} text-ok`} />
        ) : (
          <X className={`${MARK} text-err`} />
        )}
        <span className="min-w-0 truncate text-syn-string">{line.command}</span>
        {running ? (
          line.startedAt > 0 && <RunningFor since={line.startedAt} />
        ) : (
          <span className="shrink-0 text-fg-dim">{seconds}</span>
        )}
        {/* Only when it failed. "exit 0" on every green row is noise, and the
            code is the thing you want when it is anything else. */}
        {line.ok === false && (
          <span className="shrink-0 text-err">
            {line.exitCode === null ? "stopped" : `exit ${line.exitCode}`}
          </span>
        )}
      </div>
      {open && !!line.output && (
        <pre className="mt-1 mb-2 max-h-80 overflow-auto rounded-sm bg-chrome p-2 text-[11px] leading-relaxed whitespace-pre-wrap text-fg-muted">
          {line.output}
        </pre>
      )}
    </div>
  )
}

/** Mirrors CheckpointRow: one line, click for exactly what was staged. */
function CommitLandedRow({ line }: { line: CommitLandedLine }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <div
        onClick={() => toggleUnlessSelecting(setOpen)}
        className="flex min-w-0 cursor-pointer items-baseline gap-2 rounded px-1 py-0.5 hover:bg-hover"
      >
        <GitCommit className={`${MARK} text-diff-add-fg`} />
        <span className="shrink-0 text-diff-add-fg">committed {line.sha.slice(0, 7)}</span>
        <span className="shrink-0 text-fg-dim">
          {line.paths.length} file{line.paths.length === 1 ? "" : "s"}
        </span>
      </div>
      {open && (
        <pre className="mt-1 mb-2 max-h-64 overflow-auto rounded-sm bg-chrome p-2 text-[11px] leading-relaxed whitespace-pre-wrap text-fg-muted">
          {line.paths.join("\n")}
        </pre>
      )}
    </div>
  )
}

/**
 * The moment work left the machine.
 *
 * One line, not expandable: unlike a commit there is no list of paths to open —
 * what was sent is exactly the commits the previous rows already describe.
 */
function PushLandedRow({ line }: { line: PushLandedLine }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2 px-1 py-0.5">
      <ArrowUp className={`${MARK} text-diff-add-fg`} />
      <span className="shrink-0 text-diff-add-fg">pushed {line.branch}</span>
      <span className="shrink-0 text-fg-dim">
        {line.pushed} commit{line.pushed === 1 ? "" : "s"}
      </span>
    </div>
  )
}

function renderLine(
  line: Line,
  onPermission?: (requestId: string, allowed: boolean) => void,
): ReactNode {
  if (line.kind === "tool") return <ToolRow key={line.key} line={line} />
  if (line.kind === "steps")
    return line.commit ? (
      <CommitFold key={line.key} line={{ ...line, commit: line.commit }} />
    ) : (
      <StepsRow key={line.key} line={line} />
    )
  if (line.kind === "push-landed") return <PushLandedRow key={line.key} line={line} />
  if (line.kind === "commit-step")
    return (
      <p key={line.key} className="flex min-w-0 items-baseline gap-2 px-1 text-[11px]">
        {line.done ? <Check className={`${MARK} text-ok`} /> : <Spinner />}
        <span className="min-w-0 text-fg-muted">{line.label}</span>
      </p>
    )
  if (line.kind === "commit-message")
    return (
      <CommitMessageRow
        key={line.key}
        message={line.message}
        model={line.model}
      />
    )
  if (line.kind === "commit-landed") return <CommitLandedRow key={line.key} line={line} />
  if (line.kind === "stale") return <StaleRow key={line.key} supervised={line.supervised} />
  if (line.kind === "verify") return <VerifyRow key={line.key} line={line} />
  if (line.kind === "verify-skipped")
    return (
      // Dimmed whole, including the command, so it reads as a row that is not
      // going to happen rather than one still waiting its turn.
      <p key={line.key} className="flex min-w-0 items-baseline gap-2 px-1 text-[11px] text-fg-dim">
        <Minus className={MARK} />
        <span className="min-w-0 truncate">{line.command}</span>
        <span className="shrink-0">skipped · {line.reason}</span>
      </p>
    )
  if (line.kind === "checkpoint") return <CheckpointRow key={line.key} line={line} />
  if (line.kind === "thinking")
    return (
      <p key={line.key} className="px-1 break-words whitespace-pre-wrap text-syn-comment italic">
        {line.text}
      </p>
    )
  if (line.kind === "user") return <UserRow key={line.key} line={line} />
  if (line.kind === "permission")
    return <PermissionRow key={line.key} line={line} onAnswer={onPermission} />
  if (line.kind === "denied")
    return (
      <p key={line.key} className="px-1 break-words text-warn">
        <X className={INLINE_MARK} />
        denied {line.name} — {line.reason}
      </p>
    )
  if (line.kind === "retry")
    return (
      <p key={line.key} className="px-1 break-words text-warn">
        <ArrowClockwise className={INLINE_MARK} />
        {line.text}
      </p>
    )
  if (line.kind === "error")
    return (
      <p key={line.key} className="px-1 break-words text-err" title={line.text}>
        <Warning className={INLINE_MARK} />
        {humanizeError(line.text)}
      </p>
    )
  if (line.kind === "outcome") {
    const outcome = describeOutcome(line)
    return (
      <div key={line.key} className="mt-3 border-t border-line px-1 pt-2">
        <p title={`SDK result subtype: ${line.subtype}`} className={outcome.className}>
          <Circle className={INLINE_MARK} />
          {outcome.label}
          <span className="text-fg-dim">
            {" — "}
            {/* A commit run has no SDK steps to count, and "0 turns" on the end of
                one reads as a failure rather than as a category difference. */}
            {line.turns > 0 && `${line.turns} turns · `}
            {(line.ms / 1000).toFixed(1)}s · ~{money(line.cost)} est.
          </span>
        </p>
        {/* What the SDK said, under the line that says it failed. The subtype
            names the wall that was hit and is already in the label; these are
            the only place the actual reason appears.

            Humanized, like the `error` rows above — and this is where it
            actually matters. An SDK diagnostic reaches the screen through
            `run.finished.errors[]` far more often than through `run.error`, so
            translating only the latter left the raw string as the LAST thing in
            a conversation that never got a reply: a turn interrupted a second
            in read as `[ede_diagnostic] result_type=user last_content_type=n/a
            stop_reason=null`, which is indistinguishable from the model having
            answered with nonsense. The raw text stays on `title` for anyone
            debugging. */}
        {line.errors.map((text, i) => (
          <p key={i} className="mt-1 break-words text-err" title={text}>
            {humanizeError(text)}
          </p>
        ))}
      </div>
    )
  }
  return (
    <div
      key={line.key}
      className={`px-1 ${line.nested ? "ml-4 border-l border-line pl-3" : ""}`}
    >
      <Markdown text={line.text} />
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
  live,
  busy,
  tail,
  scroller,
  children,
}: {
  events: RunEvent[]
  /** Present only for a live chat turn; a replayed transcript cannot be answered. */
  onPermission?: (requestId: string, allowed: boolean) => void
  /** The reply being typed right now, if there is one. See `LiveText`. */
  live?: LiveText | null
  /**
   * The last turn is still running, so it has no answer yet.
   *
   * Separate from `live` and NOT derivable from it, which is the bug this exists
   * to fix. `live` is the reply being TYPED, and it goes null in every gap
   * between one block finishing and the next beginning — many times a turn. Read
   * as "the turn is over" that made the transcript shake: whichever paragraph had
   * landed last was promoted to the answer and lifted out of the fold, then
   * swallowed back the moment another tool call arrived. Every new block surfaced
   * as the final one in turn.
   *
   * A turn's own busy flag changes once at each end of a turn, which is what the
   * fold boundary has to follow.
   */
  busy?: boolean
  /**
   * Render at most this many lines, counting back from the end.
   *
   * Cut here rather than by the caller, and on lines rather than on events, so
   * that a block's key is decided by the whole log — see `blockKey`.
   */
  tail?: number
  /**
   * The element this transcript scrolls inside, when it scrolls in one.
   *
   * Only the pinned question needs it, and it is the one thing here that has to
   * know where the fold is. A surface that leaves it out gets the same
   * transcript without the pin, rather than a pin measured against the window.
   */
  scroller?: RefObject<HTMLElement | null>
  /** Anything that belongs after the last line: the commit message being written. */
  children?: ReactNode
}) {
  // Folded BEFORE the tail is taken, so `tail` counts the rows that will be
  // drawn. Slicing first would cut the unfolded list and then collapse what
  // survived, and a column asking for 60 lines would get however many a fold
  // happened to leave — the number would mean something different on every turn.
  // `busy`, NOT `!!live`. See the prop: `live` empties between blocks, so using
  // it here made the fold boundary jump on every one of those gaps.
  const lines = useMemo(
    () => foldSteps(toLines(events, live, timelineMeta(events)), busy ?? false),
    [events, live, busy],
  )
  const shown = tail !== undefined && lines.length > tail ? lines.slice(-tail) : lines
  /**
   * The transcript's own element, held as state rather than in a ref: it is not
   * rendered at all while the log is empty, and an effect that found a null ref
   * at mount would never learn that the rows had arrived.
   */
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  // In the same order the rows are in the document, which is what lets the
  // measured position of the Nth row name the Nth question.
  const questions = shown.filter((l): l is UserLine => l.kind === "user")
  const under = useStuckQuestion(root, scroller)
  const pinned = questions[under]

  if (shown.length === 0) {
    if (!children) return <Empty>Nothing in this transcript.</Empty>
    return <div className="space-y-1">{children}</div>
  }
  return (
    <div ref={setRoot}>
      {pinned && <StickyQuestion text={pinned.text} />}
      <div className="space-y-1">
        {shown.map((line) => renderLine(line, onPermission))}
        {children}
      </div>
    </div>
  )
}
