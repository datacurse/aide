/**
 * Where runs meet the Agent SDK.
 *
 * Everything above this line speaks `RunEventBody`; everything below speaks SDK
 * messages. Keeping the boundary here means the SDK's ~30-member message union
 * has exactly one place to be updated when it grows.
 *
 * `helper.ts` and `usage.ts` are the other two files that import the SDK, and
 * deliberately touch none of this: one makes one-shot text calls with no tools
 * and returns a string, the other sends no prompt at all and asks the session a
 * single control request, so neither ever sees a message union to normalize.
 */
import { query, type SDKUserMessage, type Settings } from "@anthropic-ai/claude-agent-sdk"
import {
  SUMMARY_FENCE,
  parseTurnSummary,
  type Attachment,
  type ChatMode,
  type EffortLevel,
  type MessageImage,
  type ModelSpend,
  type RunDelta,
  type RunEventBody,
  type RunStatus,
} from "@aide/protocol"
import { FILE_TOOL_COMMANDS, HUMAN_ONLY_COMMANDS, checkBashCommand } from "./policy.js"

export interface RunAgentOptions {
  runId: string
  projectId: string
  /** The task title. Composed into the user turn â it is part of the request. */
  title: string
  /** The task body. May be empty; the title alone is then the request. */
  prompt: string
  /**
   * Prose from `.aide/project.md`. Appended to the SYSTEM prompt, not the user
   * turn: it is a durable constraint on every task in this project, not part of
   * what is being asked this time.
   */
  projectDoc: string
  /**
   * The commands the commit gate will run, from the same `verify:` block.
   *
   * Told to the agent so it stops re-running them speculatively. Across the
   * eight most recently archived conversations the checks were 334 separate
   * runs and 101.6 minutes — 67% of ALL time those runs spent in a shell, and
   * 81-89% of it on four of the eight. The cause is not that checking is wrong;
   * it is that a run which cannot see the gate re-proves the whole tree after
   * every edit, because it has no way to know what will be re-proved for it.
   *
   * Empty for a project that declares none, which reads as "there is no gate" —
   * the honest thing to say, and different from saying nothing at all.
   */
  verifyCommands: string[]
  /** Absolute path the agent runs in — always the project root. */
  cwd: string
  model: string
  allowedTools: string[]
  /** Bash prefixes the run may use. Enforced by `policy.ts`, not by the SDK. */
  allowedBash: string[]
  deniedBash: string[]
  /** Merged over `process.env` for the run. */
  env: Record<string, string>
  /** Omit for no cap. See CONFIG.chatMaxBudgetUsd for why a chat has none. */
  maxBudgetUsd?: number
  maxTurns?: number

  // -------------------------------------------------------------------------
  // Chat turns. A task run leaves all of these unset and behaves exactly as
  // before; a chat sets them and gets a conversational, human-supervised turn.
  // -------------------------------------------------------------------------

  /**
   * Continue an existing session instead of starting one.
   *
   * Deliberately WITHOUT `forkSession`. A task follow-up would fork, so an older
   * run stays resumable at its own point; a chat appends, so the conversation
   * keeps one stable id the way it does in the CLI and the VS Code extension.
   * Forking a chat would fracture it into a chain of ids after every message.
   */
  resume?: string
  /** Omitted for task runs, which stay on the fail-closed `dontAsk`. */
  chatMode?: ChatMode
  effort?: EffortLevel
  /**
   * Whether the model may think before it answers. Omitted means yes.
   *
   * Separate from `effort`, which only says how HARD to think, and never says
   * not to. Off is a real answer to a small ask — rename this, add that line —
   * where the thinking is most of the wall clock and none of the work.
   */
  thinking?: boolean
  /** Images pasted into the composer, sent as content blocks alongside the text. */
  attachments?: Attachment[]
  /**
   * Asks the human to approve a tool call. Present only for chat turns; when it
   * is absent, anything not already permitted is denied, which is the right
   * answer when nobody is listening.
   */
  onPermission?: (req: { requestId: string; name: string; input: unknown }) => Promise<boolean>
  /** Emit a `context.usage` event at the end of the turn. Chat only. */
  trackContext?: boolean
  /**
   * Receives token-by-token output while the turn is producing it. Setting this
   * turns on the SDK's partial-message stream; leaving it unset keeps a run to
   * whole messages, which is all a headless task needs.
   */
  onDelta?: (delta: RunDelta) => void

  /**
   * Receives a handle to interrupt the run. This is a control message over the
   * SDK's stdin channel, NOT a signal, which is why it behaves identically on
   * Windows, where child.kill("SIGINT") is TerminateProcess wearing a signal's
   * name. Available only because of streaming input mode below: the SDK's
   * control requests do not exist when `prompt` is a plain string.
   */
  onControl?: (control: { interrupt: () => Promise<void> }) => void

  /**
   * Follow-up turns for a conversation that stays open.
   *
   * When this is present the input stream does not close after the first
   * message, so the CLI subprocess and the whole conversation stay in memory and
   * a follow-up costs one message instead of a fork, a process spawn and a
   * replay of the transcript from disk. Measured on Windows, the old
   * fork-per-turn path paid ~540ms forking the worker and ~850ms booting the CLI
   * before the model saw a single token, on every turn.
   *
   * A task run leaves this unset and behaves exactly as it did.
   */
  followUps?: AsyncIterable<FollowUpTurn>

  /**
   * Called with the runId of each turn as its message goes in, so the caller can
   * attribute the events that follow it. The first turn is `opts.runId`.
   */
  onTurnStart?: (runId: string) => void
}

/**
 * A message pushed into a conversation that is already open.
 *
 * `mode`, `effort`, `thinking` and `model` are per-turn choices in the composer
 * but per-query options in the SDK, so a session that outlives a turn has to
 * apply them as control requests before the message goes in. All of them have one:
 * `setPermissionMode`, `applyFlagSettings`, `setMaxThinkingTokens` and
 * `setModel` â which is what makes
 * keeping the session open possible without freezing the toolbar.
 *
 * Each is present only when it CHANGED — see `#followUp` in chat.ts — which is
 * why `thinking` is optional rather than a plain boolean: undefined means "leave
 * the session as it is", not "on".
 */
export interface FollowUpTurn {
  runId: string
  text: string
  attachments?: Attachment[]
  mode?: ChatMode
  effort?: EffortLevel
  thinking?: boolean
  model?: string
}

const truncate = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n)}...` : s)

/**
 * Keep BOTH ends of a long tool result, not just the front.
 *
 * Head-only truncation is fine for `tsc`, which prints its errors first, and
 * quietly useless for everything that prints them last: a failing test run, a
 * failing install, a script that logs its progress and then dies. Those put the
 * reason in the final lines, so 300 characters from the front is the banner and
 * the summary says nothing about why the call failed — on exactly the calls
 * anyone reads a log to understand.
 *
 * Both ends cost the same budget as one, and the elision says how much went
 * missing so a reader knows they are looking at a cut rather than at output that
 * jumps.
 */
function clip(s: string, n = 300): string {
  if (s.length <= n) return s
  const half = Math.floor((n - 1) / 2)
  const dropped = s.length - half * 2
  return `${s.slice(0, half)}\n…${dropped} chars…\n${s.slice(-half)}`
}

/** tool_result content is either a string or an array of blocks. Render either. */
function summarizeToolResult(content: unknown): string {
  if (typeof content === "string") return clip(content.trim())
  if (Array.isArray(content)) {
    const text = content
      .map((b) => {
        const block = b as Record<string, unknown>
        return block["type"] === "text" ? String(block["text"] ?? "") : `[${block["type"]}]`
      })
      .join("\n")
    return clip(text.trim())
  }
  return ""
}

/**
 * The tool a model calls to hand a finished plan back for approval.
 *
 * Named rather than inlined because the whole of Plan-then-Auto turns on
 * recognising it: if a future release renames it, aide keeps asking about every
 * edit instead of carrying the plan out. That is the safe direction to fail in,
 * and this is where someone would come looking when it does.
 */
const PLAN_HANDOFF_TOOL = "ExitPlanMode"

/**
 * The tool that asks the human a multiple-choice question mid-turn, and the one
 * tool aide always refuses.
 *
 * Neither mode may stop for permission mid-turn — see the brief. `ExitPlanMode`
 * is the single exception, and it is an exception because it ENDS the turn: the
 * plan is handed over and nothing is holding the checkout waiting on a click.
 * `AskUserQuestion` is the opposite shape. It blocks with the run still live,
 * still holding the project's lock, and aide sends turns nobody typed — the
 * commit gate's repair attempt is one — so a question raised by one of those has
 * nobody to answer it and wedges the project until someone finds the stop button.
 *
 * Observed doing exactly that: a turn on Auto sat on `AskUserQuestion` for 937
 * seconds asking which chess variant to migrate, holding a remote project, with
 * `allow`/`decline` buttons whose only honest answer was to kill the run.
 *
 * The refusal names the alternative rather than just saying no, because the model
 * has a real decision to communicate and a good way to do it: say the options in
 * the reply and stop. The turn ends, the lock is released, and the human answers
 * in the next message — which is the same conversation, one turn later, with
 * nothing held in the meantime.
 */
export const QUESTION_TOOL = "AskUserQuestion"

export const QUESTION_REFUSAL = [
  "aide does not allow AskUserQuestion: it blocks the turn while holding the",
  "project's checkout, and aide sends turns that nobody is watching.",
  "Put the question and the options in your reply and end the turn instead —",
  "the human answers in the next message.",
].join(" ")

/**
 * What a Plan turn is told when it reaches for a tool it may not use yet.
 *
 * The same shape as `QUESTION_REFUSAL` and for the same reason: a refusal an
 * agent cannot act on becomes a retry loop, so it has to name the way forward.
 * Here that way is the one Plan already has — `ExitPlanMode`, which aide approves
 * without asking so the turn can finish and the plan can be read in the
 * transcript. See the handoff branch in `canUseTool` for why it is granted there
 * rather than put to the human, which is not the obvious answer.
 */
export const PLAN_REFUSAL = [
  "aide's Plan mode does not act: describe the change instead, and call",
  "ExitPlanMode to hand the plan over and end the turn. The human approves it",
  "and the same conversation carries it out with this tool available.",
].join(" ")

/**
 * What a chat in Auto mode may do with a shell, decided by aide instead of by a
 * model that guards it.
 *
 * Auto mode classifies every Bash command before it runs. That classification is
 * a model call and costs what one costs: over 942 Bash calls in this machine's
 * run logs, a trivial command took a median of 3.3s and one that ran a program
 * with a pipe in it took 6.0s — against 140ms for the shell spawn itself, and
 * 0-1ms for the very same tool on runs where nothing classified it. A turn that
 * shells out sixty times pays minutes of wall clock for it.
 *
 * And it buys less than it appears to. Across sixty run logs the classifier
 * escalated to asking the human exactly zero times: it either allows, slowly, or
 * refuses outright — and a refusal lands on an agent with no way to ask.
 *
 * So `Bash(*)` goes into the flag-settings layer, which is resolved before the
 * classifier is reached, and what follows is what is left of the gate.
 *
 * What that gate is worth was read out of the CLI the SDK spawns rather than
 * guessed at — it is a Bun binary, so its JavaScript is still text inside it:
 *
 * - `Bash(*)` is normalized to the bare tool name. The rule parser returns no
 *   rule content for `""` or `"*"`, so this really is the whole tool, and it is
 *   the same widening a `.claude/settings.json` would do. That file is still a
 *   red flag; this is the one use of the layer that has a home in code.
 * - A denied command is not string-matched. The CLI parses it into a syntax
 *   tree, walks env-var prefixes and options, and evaluates each subcommand of a
 *   compound line separately — there is a `subcommandResults` denial reason for
 *   exactly that case. So `git commit` in the list is not trivially dodged by
 *   writing `true; git commit`.
 *
 * It is still a list of command prefixes rather than a security boundary. The
 * boundary is the one the brief describes: your own machine, behind loopback,
 * one agent at a time, over a checkpoint taken before the turn began.
 */
export function fastBashSettings(deniedBash: readonly string[]): Settings {
  // Two shapes per prefix. The rule validator in that same binary accepts both
  // `Bash(pnpm dev *)` and `Bash(pnpm dev:*)` and labels the second "(legacy)",
  // and the matcher strips either two-character suffix and prefix-matches what
  // is left — so they are one rule wearing two spellings, and the bare form is
  // the exact match. Emitting both costs nothing and survives whichever spelling
  // a later release retires.
  // The file-tool prefixes ride in this list too, and leaving them out is the
  // mistake that makes the rule look enforced while doing nothing. `Bash(*)` is
  // resolved in this layer, BEFORE `canUseTool` — so on Auto, which is the mode
  // most turns run in, a `grep` refused by `checkBashCommand` never reaches it.
  // The gate and its widening have to name the same commands or the gate is
  // decoration. `pnpm smoke` pins that they do.
  const deny = [
    ...deniedBash,
    ...HUMAN_ONLY_COMMANDS,
    ...FILE_TOOL_COMMANDS.map((f) => f.prefix),
  ].flatMap((prefix) => [`Bash(${prefix})`, `Bash(${prefix} *)`])
  return { permissions: { allow: ["Bash(*)"], deny } }
}

const SHADOW_WARNING_CODE = "CLAUDE_SDK_CAN_USE_TOOL_SHADOWED"

/** The names out of `canUseTool will not be invoked for: A, B. Bare …`. */
function toolsNamedInShadowWarning(message: string): string[] {
  const listed = /^canUseTool will not be invoked for: ([^.]+)\./.exec(message)?.[1]
  if (!listed) return []
  return listed
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
}

/** Tool names this process has told the SDK to approve without asking. */
const shadowedOnPurpose = new Set<string>()
let shadowWarningFiltered = false

/**
 * Stop the SDK saying, once per worker, that `canUseTool` will not be consulted
 * for the tools we asked it not to consult it for.
 *
 * A bare name in `allowedTools` approves its whole tool before the callback is
 * reached. Both of aide's lists are bare on purpose — `CONFIG.allowedTools` is a
 * headless run's entire permission, and fails closed because what is not on it
 * is denied; `chatAutoAllowTools` is the short read-only set a chat is never
 * asked about. The warning's own remedy, a PreToolUse hook, would put a callback
 * in front of every Read in order to answer yes, which is the round trip the
 * list exists to skip. So it is two lines of stderr per worker, on every chat,
 * restating a decision taken in `config.ts` where both lists are commented.
 *
 * Swallowed only for tools this process actually passed, and only when the
 * message parses. The SDK's own text ends "Allow rules from settings files can
 * also shadow the callback but are not visible here" — and aide writes such a
 * layer itself in `fastBashSettings` — so a shadow naming something nobody here
 * asked for is news and still prints. What the lists themselves contain is not
 * this filter's job to police: that is read in a diff, which is where an Edit
 * added to the auto-allow set — quietly letting Plan act before it has planned —
 * gets caught.
 */
function expectShadowedTools(allowedTools: readonly string[]): void {
  for (const tool of allowedTools) shadowedOnPurpose.add(tool)
  if (shadowWarningFiltered) return
  shadowWarningFiltered = true

  // Node prints warnings from a listener on this event like any other, so
  // filtering one means taking that listener off and calling it for everything
  // kept. Handing warnings back to the listeners that were there — rather than
  // formatting them here — keeps the prefix, the code and the `--trace-warnings`
  // hint identical, and keeps whatever tsx registered for its own warnings.
  const printers = process.listeners("warning") as Array<(warning: Error) => void>
  process.removeAllListeners("warning")
  process.on("warning", (warning) => {
    if ((warning as NodeJS.ErrnoException).code === SHADOW_WARNING_CODE) {
      const named = toolsNamedInShadowWarning(warning.message)
      if (named.length && named.every((tool) => shadowedOnPurpose.has(tool))) return
    }
    for (const print of printers) print(warning)
  })
}

function toModelSpend(raw: unknown): Record<string, ModelSpend> {
  const out: Record<string, ModelSpend> = {}
  const entries = Object.entries((raw ?? {}) as Record<string, Record<string, unknown>>)
  for (const [model, u] of entries) {
    out[model] = {
      inputTokens: Number(u["inputTokens"] ?? 0),
      outputTokens: Number(u["outputTokens"] ?? 0),
      cacheReadInputTokens: Number(u["cacheReadInputTokens"] ?? 0),
      cacheCreationInputTokens: Number(u["cacheCreationInputTokens"] ?? 0),
      costUSD: Number(u["costUSD"] ?? 0),
    }
  }
  return out
}

/**
 * How a turn ended, from the SDK's result message.
 *
 * `isError` is read as well as the subtype, and it is not belt-and-braces. The
 * SDK's own type says a `success` result carries the final assistant text in
 * `result` — "or, with is_error true, the error text when the turn ended on an
 * API error". Reading the subtype alone therefore filed a turn that died on an
 * API error as done, with the error message rendered in the transcript as the
 * model's closing remark.
 */
const statusFor = (subtype: string, isError: boolean): RunStatus =>
  subtype === "success" && !isError ? "success" : "failed"

/**
 * What the SDK said went wrong, out of the two places it puts it.
 *
 * An error subtype carries `errors`; a `success` that is really a failure has
 * the text in `result`, where a reply would otherwise be. Neither is read
 * anywhere else, so this is the only chance to keep it.
 */
function errorsFrom(m: Record<string, unknown>, subtype: string, isError: boolean): string[] {
  const listed = Array.isArray(m["errors"]) ? m["errors"].map((e) => String(e)) : []
  const inResult =
    subtype === "success" && isError && typeof m["result"] === "string" ? [m["result"]] : []
  return [...listed, ...inResult].map((s) => s.trim()).filter(Boolean)
}

/**
 * aide's mode names to the SDK's. A table rather than a cast, because the two
 * vocabularies are only the same by coincidence today — they were not when
 * "Manual" mapped to `default`, and the next mode either end adds will not be
 * either.
 */
const CHAT_TO_SDK_MODE: Record<ChatMode, "plan" | "auto"> = {
  plan: "plan",
  auto: "auto",
}

/**
 * One `stream_event` into zero or more deltas.
 *
 * The payload is a raw Messages API streaming event, so the shapes worth
 * handling are `content_block_delta` (text and thinking, arriving in pieces),
 * `content_block_start` for a tool call, and
 * `message_delta` (cumulative output tokens for the message in flight). The
 * rest â block starts and stops â carries nothing a reader needs that
 * the finished message will not say better.
 *
 * `message_start` is the exception, and it is deliberately not handled here: it
 * carries no content, only the fact that the API has begun, which is a timestamp
 * rather than something to draw. The streaming loop turns it into an
 * `assistant.start` EVENT instead, so it survives in the log.
 */
function toDeltas(message: unknown): RunDelta[] {
  const event = (message as { event?: Record<string, unknown> }).event
  if (!event) return []

  // The one place a delta beats its own event to the browser rather than
  // duplicating it early. A `tool.start` is read off the COMPLETED assistant
  // message, so a call the model announces mid-reply stays invisible until it
  // has finished writing that reply — which is after the tool has run. This
  // fires when the model opens the block, so the row and its clock start with
  // the call. See `RunDelta`.
  if (event["type"] === "content_block_start") {
    const block = event["content_block"] as Record<string, unknown> | undefined
    if (block?.["type"] !== "tool_use") return []
    const toolUseId = String(block["id"] ?? "")
    const name = String(block["name"] ?? "")
    // Both, or the row cannot be named now nor retired by the event later.
    return toolUseId && name ? [{ kind: "tool", toolUseId, name }] : []
  }

  if (event["type"] === "content_block_delta") {
    const d = event["delta"] as Record<string, unknown> | undefined
    if (d?.["type"] === "text_delta") {
      const text = String(d["text"] ?? "")
      return text ? [{ kind: "text", text }] : []
    }
    if (d?.["type"] === "thinking_delta") {
      const text = String(d["thinking"] ?? "")
      return text ? [{ kind: "thinking", text }] : []
    }
    return []
  }

  if (event["type"] === "message_delta") {
    const usage = event["usage"] as Record<string, unknown> | undefined
    const out = Number(usage?.["output_tokens"] ?? 0)
    return out > 0 ? [{ kind: "usage", outputTokens: out }] : []
  }

  return []
}

export interface NormalizeContext {
  projectId: string
  cwd: string
  /** Used when the message does not name a model of its own. */
  fallbackModel: string
}

/**
 * An image block's payload, if it is one aide can draw.
 *
 * Only base64 sources: the API also accepts a URL source, and rendering one
 * would mean the browser fetching from wherever a transcript points, which is
 * not something a local review tool should do on your behalf.
 */
function toMessageImage(source: unknown): MessageImage | null {
  const s = (source ?? {}) as Record<string, unknown>
  if (s["type"] !== "base64") return null
  const mediaType = String(s["media_type"] ?? "")
  const data = String(s["data"] ?? "")
  return mediaType.startsWith("image/") && data ? { mediaType, data } : null
}

/**
 * One SDK message in, zero or more `RunEventBody` out. THE mapping.
 *
 * Kept as a pure function rather than inlined in the streaming loop because a
 * session read back from `~/.claude/projects/*.jsonl` carries the same message
 * shapes as the live stream. Sharing this means a replayed conversation renders
 * identically to a live run â same tool rows, same outcome line â and it keeps
 * the invariant this file exists for: the SDK's ~30-member message union is
 * interpreted in exactly one place, so there is one thing to update when it
 * grows.
 */
export function normalizeSdkMessage(
  message: unknown,
  ctx: NormalizeContext,
): RunEventBody[] {
  const m = (message ?? {}) as Record<string, unknown>
  const type = m["type"]

  if (type === "system" && m["subtype"] === "init") {
    return [
      {
        type: "run.started",
        projectId: ctx.projectId,
        model: String(m["model"] ?? ctx.fallbackModel),
        cwd: ctx.cwd,
        sessionId: (m["session_id"] as string) ?? null,
      },
    ]
  }

  if (type === "system" && m["subtype"] === "api_retry") {
    return [
      {
        type: "run.retry",
        attempt: Number(m["attempt"] ?? 0),
        maxRetries: Number(m["max_retries"] ?? 0),
        retryDelayMs: Number(m["retry_delay_ms"] ?? 0),
        error: String(m["error"] ?? "unknown"),
      },
    ]
  }

  if (type === "assistant") {
    const parent = (m["parent_tool_use_id"] as string | null) ?? null
    const content = (m["message"] as { content?: unknown[] })?.content ?? []
    if (!Array.isArray(content)) return []
    const out: RunEventBody[] = []
    for (const b of content) {
      const block = b as Record<string, unknown>
      if (block["type"] === "text") {
        const text = String(block["text"] ?? "")
        if (text.trim()) out.push({ type: "assistant.text", text, parentToolUseId: parent })
        // The closing block, if the turn wrote one. Emitted ALONGSIDE the text
        // rather than instead of it: the raw reply is the tier-3 record and goes
        // to disk exactly as the model wrote it, and the renderer is what hides
        // the block — see `stripTurnSummary`. Editing it on the way to the log
        // would leave `~/.aide/runs` disagreeing with what was actually said.
        //
        // Only for the main loop. A subagent writing one of these is describing
        // its own errand, and drawing that on the turn's card would report a
        // fragment of the work as the whole of it.
        if (parent === null) {
          const summary = parseTurnSummary(text)
          if (summary) out.push({ type: "turn.summary", ...summary })
        }
      } else if (block["type"] === "thinking") {
        const text = String(block["thinking"] ?? "")
        if (text.trim()) out.push({ type: "assistant.thinking", text, parentToolUseId: parent })
      } else if (block["type"] === "tool_use") {
        out.push({
          type: "tool.start",
          toolUseId: String(block["id"] ?? ""),
          name: String(block["name"] ?? "?"),
          input: block["input"],
          parentToolUseId: parent,
        })
      }
    }
    return out
  }

  if (type === "user") {
    // `unknown`, not `unknown[]`: a plain-text turn stores a string here, and
    // annotating it as an array narrows the string branch below to `never`.
    const content: unknown = (m["message"] as { content?: unknown })?.content ?? []
    // A plain-text user turn is a string, not blocks. In a live run that only
    // happens for the prompt we sent ourselves; in a replayed session it is
    // every message the human typed, which is most of what makes a chat a chat.
    if (typeof content === "string") {
      return content.trim() ? [{ type: "user.message", text: content }] : []
    }
    if (!Array.isArray(content)) return []
    const out: RunEventBody[] = []
    // A pasted screenshot is its own block, and it comes BEFORE the text block
    // it belongs to. Held here until the text arrives so the two land as one
    // message rather than as a picture followed by a caption.
    let images: MessageImage[] = []
    for (const b of content) {
      const block = b as Record<string, unknown>
      if (block["type"] === "tool_result") {
        out.push({
          type: "tool.end",
          toolUseId: String(block["tool_use_id"] ?? ""),
          ok: block["is_error"] !== true,
          summary: summarizeToolResult(block["content"]),
        })
      } else if (block["type"] === "image") {
        const image = toMessageImage(block["source"])
        if (image) images.push(image)
      } else if (block["type"] === "text") {
        const text = String(block["text"] ?? "")
        if (text.trim() || images.length) {
          out.push({ type: "user.message", text, ...(images.length ? { images } : {}) })
          images = []
        }
      }
    }
    // "look at this" with no words at all is a real message, and dropping it
    // left the reply hanging under nothing.
    if (images.length) out.push({ type: "user.message", text: "", images })
    return out
  }

  if (type === "result") {
    const subtype = String(m["subtype"] ?? "unknown")
    const isError = m["is_error"] === true
    const errors = errorsFrom(m, subtype, isError)
    const denials = (m["permission_denials"] as Array<Record<string, unknown>>) ?? []
    return [
      {
        type: "run.finished",
        subtype,
        status: statusFor(subtype, isError),
        // Omitted rather than empty, so an outcome with nothing to explain logs
        // the same line it always did.
        ...(errors.length ? { errors } : {}),
        // Includes subagent spend; `usage` would not. Both are estimates.
        totalCostUsd: Number(m["total_cost_usd"] ?? 0),
        modelUsage: toModelSpend(m["modelUsage"]),
        numTurns: Number(m["num_turns"] ?? 0),
        durationMs: Number(m["duration_ms"] ?? 0),
        permissionDenials: denials.map((d) => ({
          tool: String(d["tool_name"] ?? d["tool"] ?? "?"),
          reason: String(d["message"] ?? d["reason"] ?? ""),
        })),
      },
    ]
  }

  return []
}

/**
 * Cap the project doc so a runaway project.md cannot crowd out the task.
 *
 * 32k characters is roughly 8k tokens, in a prompt that is resent on every turn
 * of every conversation. The old figure was 8k characters, set when this file
 * was the only project state there was; a brief that says what a project is for
 * has no business approaching either number.
 *
 * Exported because the board warns when a project is close to it. Silently
 * losing the second half of a document that says what NOT to do is worse than
 * having no document at all â the agent reads something confident and complete
 * with the constraints missing.
 */
export const MAX_PROJECT_DOC_CHARS = 32_000

/**
 * The request, as the agent sees it.
 *
 * The title used to be thrown away â only the body was sent â which discarded
 * the one line that most reliably says what the task is, and left a task with an
 * empty body being handed an empty user message.
 *
 * Named rather than inlined into its one caller below, because "what the model
 * is actually asked" is worth being able to point at. It used to say it was
 * composed in one place "so the two cannot drift" — there was a second call site
 * once, and there has not been for some time.
 */
function composeRequest(title: string, prompt: string): string {
  const body = prompt.trim()
  return body ? `# ${title}\n\n${body}` : title
}

export async function* runAgent(opts: RunAgentOptions): AsyncGenerator<RunEventBody> {
  expectShadowedTools(opts.allowedTools)
  const request = composeRequest(opts.title, opts.prompt)

  // Images first, then the text. The Messages API takes either a bare string or
  // an array of content blocks; a turn with no attachments keeps the string
  // form, which is also what a replayed transcript shows for older sessions.
  const userMessage = (text: string, attachments?: Attachment[]): SDKUserMessage => {
    const content = attachments?.length
      ? [
          ...attachments.map((a) => ({
            type: "image" as const,
            source: { type: "base64" as const, media_type: a.mediaType, data: a.data },
          })),
          { type: "text" as const, text },
        ]
      : text
    return {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: "",
    } as SDKUserMessage
  }

  /**
   * Thinking, on or off, for the turn that is about to go out.
   *
   * A control request rather than the flag-settings layer, because that layer is
   * not read for this key at all. The CLI's `apply_flag_settings` handler takes
   * `effortLevel` and `ultracode` and drops everything else on the floor, then
   * answers ok — so a follow-up asking for `alwaysThinkingEnabled: false` was
   * accepted and ignored. Spawn-time `settings` ARE read for it, but only as the
   * fallback under `--thinking`, which the `thinking` option below always sends,
   * so the first turn of a session ignored it too. The toggle was doing nothing,
   * in both halves, while the log beside it said "no thinking".
   *
   * 0 turns thinking off for the rest of the session; null puts it back to
   * whatever the query was opened with. That is why the `thinking` option stays
   * `adaptive` even for a chat whose first turn is sent with thinking off — it
   * is the thing "back on" aims at, and a query opened `disabled` could never be
   * talked out of it.
   *
   * Deprecated in the SDK in favour of that option, and used anyway: the option
   * is fixed for the life of the query and a warm session outlives many turns,
   * so it is this or nothing.
   *
   * The display is passed on every call rather than left to the session, because
   * omitting it keeps whichever display override the session last had — and
   * landing back on the default is thinking blocks with no text in them, which
   * is the whole reason the option names one.
   */
  async function setThinking(on: boolean): Promise<void> {
    await q.setMaxThinkingTokens(on ? null : 0, "summarized")
  }

  /**
   * Resolved once `q` exists, which is later than it looks.
   *
   * `query()` pulls the first value out of `input()` from inside its own call,
   * synchronously, so the generator's opening lines run BEFORE `const q` has
   * been assigned. Touching `q` there is a temporal-dead-zone throw, the SDK
   * turns a generator that threw into an abort of the whole query, and what
   * comes out the other end is a run that died two seconds in saying "Operation
   * aborted" with nothing else in its log — no `run.started`, no clue which line
   * did it. That is measured, not reasoned about: a probe against the real SDK
   * enters the body with `q` still undefined, and every turn sent with thinking
   * off failed exactly this way.
   *
   * So anything in `input()` that speaks to the query waits for this first. The
   * control request itself is fine that early — the same probe had the CLI
   * accept `set_max_thinking_tokens` before a single message had gone in.
   */
  let queryCreated!: () => void
  const queryReady = new Promise<void>((resolve) => {
    queryCreated = resolve
  })

  // Streaming input mode. `prompt` must be an AsyncIterable for control requests
  // (interrupt) to be available at all.
  //
  // Without `followUps` we yield one message and close the stream, so the run
  // ends after its turn instead of waiting for more input. With it, the stream
  // stays open and the session survives between turns â see the field's comment.
  async function* input(): AsyncGenerator<SDKUserMessage> {
    // The first line of the generator, and it has to stay the first line: see
    // `queryReady`. Everything below this point may talk to `q`.
    await queryReady
    // Before the first message goes in, for the same reason a follow-up's
    // settings are applied before its own: a turn sent first and configured
    // after is a turn that ran under the wrong setting.
    if (opts.thinking === false) await setThinking(false)
    opts.onTurnStart?.(opts.runId)
    yield userMessage(request, opts.attachments)
    if (!opts.followUps) return

    for await (const turn of opts.followUps) {
      // Applied BEFORE the message goes in, or the turn runs under the previous
      // turn's settings â switching to Plan and sending would have planned
      // nothing and edited everything.
      if (turn.mode) {
        await q.setPermissionMode(CHAT_TO_SDK_MODE[turn.mode])
        turnMode = turn.mode
      }
      if (turn.model) await q.setModel(turn.model)
      if (turn.effort) await q.applyFlagSettings({ effortLevel: turn.effort })
      // `!== undefined`, because the value being sent at all is what says it
      // changed, and the value that changed to is `false` half the time.
      if (turn.thinking !== undefined) await setThinking(turn.thinking)
      // Per turn. Each message re-enters plan mode, so an approval carried over
      // from the last one would hand this message a session that never planned
      // and never asks — a third mode, granted by accident.
      planApproved = false
      // A fresh turn has not produced a result yet, so a throw during it is its
      // own to report. Without this reset the first turn's result suppresses the
      // error for every turn after it, and the one that actually died ends with
      // no terminal event at all.
      finished = false
      opts.onTurnStart?.(turn.runId)
      yield userMessage(turn.text, turn.attachments)
    }
  }

  // canUseTool runs on a separate async path from this generator, so denials land
  // in a buffer that gets flushed between SDK messages. They are rare, and a few
  // ms of reordering does not matter: the authoritative record is the
  // permission_denials array on the result message.
  const pending: RunEventBody[] = []
  // query() throws AFTER yielding an error result, so without this the same
  // failure gets logged twice: once as the real outcome, once as a bare error.
  let finished = false
  /**
   * What mode THIS turn is running in.
   *
   * Tracked rather than read off the turn, because a follow-up only carries
   * `mode` when it CHANGED — so `turn.mode` alone cannot answer "what is this
   * session in", and the permission decision below is the last place that can
   * still get it wrong.
   */
  let turnMode = opts.chatMode
  /** Whether the human has said yes to a plan in this turn. See `canUseTool`. */
  let planApproved = false
  /** Latest context reading of the turn; emitted once, just before the result. */
  let lastUsage: { totalTokens: number; maxTokens: number; percentage: number } | null = null

  /**
   * Session totals already reported, so each turn can report its own spend.
   *
   * `total_cost_usd` and `modelUsage` are CUMULATIVE across turns in a
   * streaming-input session: every result carries the running total for the
   * whole session. Fork-per-turn hid that, because each turn was its own
   * `query()` starting from zero. Keep the session open and subtract nothing and
   * turn five reports the sum of turns one to five â a chat that appears to get
   * monotonically more expensive the longer you talk to it, on a number the
   * brief already says is only good enough for a dashboard.
   *
   * `num_turns` and `duration_ms` are left alone: the SDK does not document them
   * as cumulative, and subtracting on a guess would be worse than not.
   */
  const reported = { costUsd: 0, models: new Map<string, ModelSpend>() }

  /** Cumulative â this turn. Clamped, because a mid-session /clear resets the
   * running total and a negative cost is worse than a zero one. */
  function chargeThisTurn(event: Extract<RunEventBody, { type: "run.finished" }>): void {
    const totalCostUsd = Math.max(0, event.totalCostUsd - reported.costUsd)
    reported.costUsd = event.totalCostUsd

    const modelUsage: Record<string, ModelSpend> = {}
    for (const [model, total] of Object.entries(event.modelUsage)) {
      const before = reported.models.get(model)
      modelUsage[model] = before
        ? {
            inputTokens: Math.max(0, total.inputTokens - before.inputTokens),
            outputTokens: Math.max(0, total.outputTokens - before.outputTokens),
            cacheReadInputTokens: Math.max(
              0,
              total.cacheReadInputTokens - before.cacheReadInputTokens,
            ),
            cacheCreationInputTokens: Math.max(
              0,
              total.cacheCreationInputTokens - before.cacheCreationInputTokens,
            ),
            costUSD: Math.max(0, total.costUSD - before.costUSD),
          }
        : total
      reported.models.set(model, total)
    }

    event.totalCostUsd = totalCostUsd
    event.modelUsage = modelUsage
  }

  /**
   * The flag-settings layer this query opens under, or null for none.
   *
   * One key deep, and it used to be two: thinking rode here as
   * `alwaysThinkingEnabled` until it turned out nothing downstream read it. See
   * `setThinking`. Empty is null: passing `{}` would open the layer with nothing
   * in it, which is not the same as not opening it.
   */
  const layer: Settings = opts.chatMode === "auto" ? fastBashSettings(opts.deniedBash) : {}
  const chatSettings = Object.keys(layer).length ? layer : null

  const q = query({
    prompt: input(),
    options: {
      model: opts.model,
      cwd: opts.cwd,
      allowedTools: opts.allowedTools,
      // A task run has nobody to ask, so it fails closed: an allowlist alone is
      // not a baseline, and `dontAsk` denies anything not explicitly allowed or
      // in the read-only command set.
      //
      // A chat gets one of the two modes a person can pick. Both of them act;
      // the difference is that Plan asks once first, and that one question is
      // what reaches canUseTool below.
      permissionMode: opts.chatMode ? CHAT_TO_SDK_MODE[opts.chatMode] : "dontAsk",
      // A chat gets the whole Claude Code toolset AVAILABLE, while auto-approving
      // only the read-only ones (see `chatAutoAllowTools`). `tools` decides what
      // exists; `allowedTools` decides what skips the question. A task run leaves
      // this alone and keeps the narrow set it was given.
      ...(opts.chatMode ? { tools: { type: "preset" as const, preset: "claude_code" as const } } : {}),
      // Auto decides its own shell commands, in aide, at zero latency.
      //
      // See `fastBashSettings` for the measurement and for what is given up.
      // Deliberately scoped to `auto` alone: Plan promises not to act, and an
      // explicit allow rule outranks that refusal, so a Plan session carrying
      // this would plan nothing and edit everything. It is fixed for the life of
      // the query, which is exactly why an approved plan being carried out is
      // decided in `canUseTool` rather than here — the rule cannot be granted
      // late, and granting it early breaks the plan.
      ...(chatSettings ? { settings: chatSettings } : {}),
      ...(opts.effort ? { effort: opts.effort } : {}),
      // Append rather than fork: a chat keeps one stable session id, the way it
      // does in the CLI. See the field's comment for why forking is wrong here.
      ...(opts.resume ? { resume: opts.resume } : {}),
      // Without this, runs end by asking a question nobody is there to answer
      // ("want me to fix it?"), which reads as done but leaves the task undone.
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: [
          // What this says about WHERE the agent is matters as much as what it
          // says about finishing. It used to say "in a git worktree", which is
          // no longer true and was never harmless once it stopped being true: an
          // agent that believes it is in a scratch checkout of its own has no
          // reason to be careful, and this one is editing the human's working
          // tree while they watch it in a dev server.
          [
            "You are working directly in the project's own checkout, not a scratch copy.",
            "Uncommitted changes here may be someone else's work in progress, so leave",
            "anything you did not come to change exactly as you found it. Your changes",
            "are reviewed as a diff and committed by a human; do not commit them yourself.",
            "No human will answer you during this run, so do not end your turn with a",
            "question or ask for confirmation before making a change the task clearly",
            "implies. Carry the task to completion. If something genuinely blocks you,",
            "say what blocked you and what decision is needed, then stop.",
          ].join(" "),
          // A shell call is the most expensive thing a run does that nobody
          // budgets for.
          //
          // Measured over one 988-second run in this repository: 67 Bash calls,
          // not one of them under 3.1s and a median of 5.1s, against 0-1ms for
          // every Read, Grep, Edit and Write in the same run. Forty-two of those
          // Bash calls were reading or editing a file — 228 seconds, near enough
          // a quarter of the run, spent starting shells to do what the file
          // tools do instantly. The same log shows 62 assistant turns carrying
          // 75 tool calls, so almost every turn paid a round trip to make one
          // call.
          //
          // This belongs in the system prompt rather than in a project's
          // CLAUDE.md because the cost is the harness and the platform, not the
          // project — every run aide drives pays it. It is worth saying out loud
          // because the SDK's own auto mode says the OPPOSITE: it asks for cat,
          // grep and sed in place of the file tools, which is fair advice where
          // a shell is cheap and expensive advice on Windows, where it is not.
          [
            "Use Read, Grep, Glob, Edit and Write for anything to do with files — reading",
            "them, searching them, changing them. Keep Bash for what genuinely needs a",
            "shell: git, the package manager, running something. A Bash call costs several",
            "seconds on this machine where the file tools return in about a millisecond,",
            "so reaching for cat or sed in their place is time spent waiting and nothing",
            "else. cat, head, tail, sed, grep, awk, rg and find are REFUSED in a shell",
            "here for that reason — the refusal names the tool to use instead. When",
            "several calls do not depend on each other, make them in one message instead",
            "of one per turn.",
          ].join(" "),
          // The gate is invisible from inside a run, and what a run cannot see it
          // re-proves. See `verifyCommands` for the measurement: two thirds of all
          // shell time across eight conversations went on re-running checks that
          // the commit was going to run anyway, one at a time, after every edit.
          //
          // Naming them is most of the fix, because the expensive habit comes from
          // not knowing. The rest is saying who runs them last: the gate re-reads
          // the working tree after the turn ends, so a check the agent ran three
          // edits ago proves nothing about what it is about to hand over, and a
          // check it never ran is not a gap — it is the gate's job.
          opts.verifyCommands.length
            ? [
                "",
                `Before a commit, aide runs this project's own checks itself: ${opts.verifyCommands.join(", ")}.`,
                "It runs them over the working tree AFTER your turn ends, and hands you any",
                "failure to fix once. So do not re-run them after every edit to see where you",
                "are — that is the single most expensive habit measured in this project's run",
                "logs. Run them when you have finished a coherent piece of work and want to",
                "know it is sound, and when you do run several, send them as parallel calls in",
                "ONE message rather than one per message: they are independent, and serially",
                "they cost the sum of their runtimes instead of the longest.",
              ].join(" ")
            : "",
          // The closing report, which grew into a small essay per turn.
          //
          // Measured across the eight most recently archived conversations:
          // 599,737 characters of assistant text, roughly 150,000 words, most of
          // it in a 2,000-3,000 character markdown summary at the end of every
          // turn — headers, tables, bolded findings, restating work the reader is
          // about to see as a diff.
          //
          // Framed as "the diff is the record" rather than as a length limit,
          // because a limit gets treated as a target and because the actual point
          // is about ownership: aide already shows the human the diff, the
          // checkpoint and the transcript. What only the agent can add is what is
          // NOT visible in those — a decision that went the other way, a finding
          // withdrawn after measuring, something left undone. Those are worth
          // words; a table of files touched is not.
          [
            "End your turn with a short summary — a few sentences. The human reads your",
            "work as a diff against a checkpoint, so listing the files you touched or",
            "restating what the code now does duplicates what they are already looking at.",
            "Spend the words on what the diff does NOT show: a decision that could have",
            "gone the other way and why it went this way, something you tried and backed",
            "out, a claim you could not verify, anything left undone. If there is none of",
            "that, say you are done in one line and stop.",
          ].join(" "),
          // The card's own layer. aide renders the checks, the diffstat and the
          // outcome itself, off exit codes and git — so this block must not
          // restate them, and is asked for exactly the four things only the turn
          // knows. Saying "aide already knows" out loud is what stops `headline`
          // becoming "3 files changed, all checks pass", which is both true and
          // the one thing the card does not need a model for.
          //
          // Last line of the reply, because `parseTurnSummary` reads the LAST
          // block — a turn that quotes an earlier summary while answering "what
          // did you say last time" must not have that quote read as this turn's.
          [
            "",
            `Then close the reply with a \`\`\`${SUMMARY_FENCE} block, as the very last thing you write:`,
            "",
            "```" + SUMMARY_FENCE,
            "headline: one line, what happened, for someone who has not read the turn",
            "next: what the human should do now, or what is blocking you — omit if nothing",
            "intent: why you did it this way, if the diff does not make that obvious",
            "risk: what the diff does not show — a call that could have gone the other way,",
            "  something unverified, something backed out",
            "```",
            "",
            "One line per field; omit any that would be empty rather than writing 'none'.",
            "Do NOT put the checks, the file count or the cost in it — aide reads those",
            "from exit codes and git and draws them itself, and a second version written",
            "from memory is the one that will be wrong.",
          ].join("\n"),
          // The project brief goes in the SYSTEM prompt so it reads as a standing
          // constraint rather than as part of this request, and so it survives
          // compaction on a long run. Framed with its provenance, because an
          // agent should know whose rules these are.
          opts.projectDoc.trim()
            ? [
                "",
                "The following is this project's brief, from .aide/project.md, written by",
                "the human who owns it. Treat its constraints and non-goals as binding.",
                "",
                truncate(opts.projectDoc.trim(), MAX_PROJECT_DOC_CHARS),
                // Said out loud, because the alternative is an agent reading a
                // document that stops mid-sentence and has no way to know that
                // it did. A truncation it is told about is one it can undo with
                // a Read; a silent one just removes the constraints.
                opts.projectDoc.trim().length > MAX_PROJECT_DOC_CHARS
                  ? `\n[This brief was cut off at ${MAX_PROJECT_DOC_CHARS} characters. Read .aide/project.md for the rest before relying on it.]`
                  : "",
              ]
                .filter(Boolean)
                .join("\n")
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
      },
      // Without `display: "summarized"` the reasoning arrives as thinking blocks
      // with EMPTY text â "omitted" is the default on Opus 5 and its siblings â
      // so a UI that renders thinking shows nothing at all and the model looks
      // like it is stalling before it answers. Display costs nothing: the
      // thinking happens and is billed identically either way.
      //
      // The same on every query, including one whose first turn is sent with
      // thinking off. This is the session default, and turning thinking back on
      // is expressed as "back to the default" — see `setThinking`.
      thinking: { type: "adaptive", display: "summarized" },
      // Only when someone is watching. Partial messages are thousands of events
      // per turn, and a headless task has nobody to show them to.
      ...(opts.onDelta ? { includePartialMessages: true } : {}),
      ...(opts.maxBudgetUsd ? { maxBudgetUsd: opts.maxBudgetUsd } : {}),
      ...(opts.maxTurns ? { maxTurns: opts.maxTurns } : {}),
      // Taken away rather than only refused. `canUseTool` denies this too, but a
      // deny is a round trip the model can spend a turn arguing with — it sees
      // the tool, calls it, is refused, and may well try again. `disallowedTools`
      // removes it from the schema, so the question is never asked in the first
      // place and the model reaches for prose instead. The deny stays as the
      // backstop for the case this option stops covering. See `QUESTION_TOOL`.
      disallowedTools: [QUESTION_TOOL],
      // Load the target project's .claude/ but not the host's ~/.claude, so a run
      // behaves the same on anyone's machine. Measured: the host's global config
      // is only ~700 tokens, so this is for reproducibility, not for savings.
      settingSources: ["project"],
      // Options.env REPLACES the environment rather than merging into it, so the
      // spread is load-bearing: without it the run loses PATH and the OAuth
      // credentials it authenticates with, and fails in a way that looks like an
      // auth problem rather than a config one.
      env: { ...process.env, ...opts.env },
      canUseTool: async (name, toolInput) => {
        // Refused in EVERY mode, and before the branch below, because that
        // branch is what turns an unresolved call into a blocking question —
        // and this is the one call that must never become one. See
        // `QUESTION_TOOL`: it holds the lock waiting for a click that a turn
        // nobody typed will never get.
        if (name === QUESTION_TOOL) {
          pending.push({
            type: "tool.denied",
            name,
            input: toolInput,
            reason: QUESTION_REFUSAL,
          })
          return { behavior: "deny", message: QUESTION_REFUSAL }
        }

        // A chat, which is to say a run with a human somewhere near it. That buys
        // less than it used to and less than it looks: NOTHING here is asked any
        // more. A chat's turn is no more interruptible than a task's, because the
        // same turn may have been sent by the commit gate rather than typed, and
        // a prompt raised by one of those has nobody to answer it.
        //
        // What a chat gets instead is a different REFUSAL — one that names the
        // way forward, lands in a transcript somebody is already reading, and is
        // answered by the next message. A task run has no such reader, so it
        // falls through to the fail-closed path below.
        //
        // Still keyed on `onPermission` because that callback's presence is what
        // distinguishes the two kinds of run at this layer. It is no longer
        // CALLED — see the handoff branch — and if a later change removes the
        // last reason to carry it, this test becomes `opts.chatMode` and the
        // option goes with it.
        if (opts.onPermission) {
          // Everything after an approved plan runs unasked, which is the whole
          // point of Plan — the plan WAS the question. One approved plan in this
          // repository's own logs was followed by twelve Edits, seven Bash calls
          // and a Write; asking again for each of those is the same decision
          // taken twenty times.
          //
          // Answered here rather than by putting the session into the SDK's own
          // auto mode, because `settings` is fixed at query creation: a chat
          // that might end up carrying a plan out would have carried
          // `fastBashSettings`' `Bash(*)` rule through the PLANNING turn as
          // well, where an explicit allow rule outranks plan mode's refusal and
          // "Claude will not act" becomes false. Deciding it in this callback
          // costs nothing and cannot leak backwards into the planning turn.
          if (turnMode === "plan" && planApproved) {
            // The shell is still aide's own decision, and the same one the two
            // lists describe everywhere else: run anything that is not denied.
            // Blunter than the CLI's parser — a pipe is refused rather than
            // split and examined — but the refusal says what to do instead, and
            // a refusal an agent can act on beats a rule engine we cannot read.
            const verdict =
              name === "Bash"
                ? checkBashCommand((toolInput as { command?: unknown })?.command, null, [
                    ...opts.deniedBash,
                    ...HUMAN_ONLY_COMMANDS,
                  ])
                : { allow: true, reason: "" }
            if (verdict.allow) return { behavior: "allow", updatedInput: toolInput }
            // Logged, because nobody watched this one happen. A run that is
            // carrying out a plan unattended must still leave the refusal in the
            // transcript, or the reader is left with a gap where a tool call was.
            pending.push({ type: "tool.denied", name, input: toolInput, reason: verdict.reason })
            return { behavior: "deny", message: verdict.reason }
          }

          // Allowed WITHOUT asking, which is the opposite of how it reads.
          //
          // The obvious version of this branch sends the handoff to the browser,
          // on the reasoning that `ExitPlanMode` ends the turn so nothing is held
          // while the human reads. That reasoning is wrong, and it was wrong in
          // this file for exactly one commit: `canUseTool` is awaited BEFORE the
          // SDK runs the tool, so the run parks on this line with the project's
          // lock in hand and the turn very much alive. The tool ends the turn
          // only once it has ALREADY been approved. Watched doing it — a plan
          // handoff sat on `needs your approval` for seven minutes holding the
          // checkout, which is the same wedge `AskUserQuestion` was refused for.
          // What a tool does AFTERWARDS is not what decides whether waiting on it
          // blocks; where the `await` sits is.
          //
          // So the permission is granted here and the turn is allowed to END. The
          // plan lands in the transcript, the lock is released, and the human
          // approves it by replying — the same review, one message later, with
          // nothing held in the meantime. That reply is also the only approval
          // that was ever load-bearing: `planApproved` gates the REST of this
          // turn, and this call is the last thing in it.
          if (turnMode === "plan" && name === PLAN_HANDOFF_TOOL) {
            planApproved = true
            return { behavior: "allow", updatedInput: toolInput }
          }

          // Refused rather than asked, and this is the rule the brief states
          // rather than a policy of its own: no mode may stop for permission
          // mid-turn, because aide sends turns nobody typed — the commit gate's
          // repair attempt is one — and a prompt raised by one of those holds
          // the project's lock with nobody there to answer it.
          //
          // It was enforced for `AskUserQuestion` alone, which was the tool
          // whose PURPOSE is to block; the general path underneath it was left
          // routing every unresolved call to the browser. So a Plan turn that
          // reached for Edit — which is deliberately not on `chatAutoAllowTools`
          // (see `config.ts`), because a bare name there would approve it before
          // Plan could refuse it — became the same 937-second wait, on the mode
          // whose whole promise is that it does not act.
          //
          // Plan's answer is `ExitPlanMode`; Auto reaching here wanted something
          // outside both allowlists, which is aide's refusal to make and not a
          // question. Either way the turn ends and the human replies to a
          // transcript rather than to a modal.
          const reason = turnMode === "plan" ? PLAN_REFUSAL : "not in this run's allowlist"
          pending.push({ type: "tool.denied", name, input: toolInput, reason })
          return { behavior: "deny", message: reason }
        }

        // A task run refuses. Bash gets a real decision from aide's own policy;
        // everything else reaching here was not on the allowlist. Note this
        // callback only sees calls the SDK has not already resolved, so it is a
        // gate, not an audit log.
        const verdict =
          name === "Bash"
            ? checkBashCommand(
                (toolInput as { command?: unknown })?.command,
                opts.allowedBash,
                opts.deniedBash,
              )
            : { allow: false, reason: "not in this run's allowlist" }

        if (verdict.allow) return { behavior: "allow", updatedInput: toolInput }

        pending.push({ type: "tool.denied", name, input: toolInput, reason: verdict.reason })
        return { behavior: "deny", message: verdict.reason }
      },
    },
  })

  // The generator above has been running since the middle of that call and is
  // parked on this. See `queryReady`.
  queryCreated()

  opts.onControl?.({
    interrupt: async () => {
      await q.interrupt()
    },
  })

  try {
    for await (const message of q) {
      while (pending.length) yield pending.shift()!

      // Ask how full the context is while the query is still alive â this is a
      // control request, so it stops being available the moment the turn ends.
      // Guarded: an experimental control request must not be able to fail a turn
      // that has already produced its result.
      // Partial messages are the live typing. They are handed to onDelta and
      // then dropped: `normalizeSdkMessage` ignores `stream_event`, so nothing
      // token-sized ever reaches the durable event log.
      if (opts.onDelta && (message as { type?: string }).type === "stream_event") {
        // One partial message survives as a durable event: the one that says the
        // API has started answering. It is a single event per assistant message
        // rather than one per token, and it is the only stamp that exists
        // between "the tool result went back" and "the whole reply arrived" —
        // without it those two are the same number and a profile cannot say
        // whether a slow turn was thinking or queueing. See `assistant.start`.
        if ((message as { event?: { type?: string } }).event?.type === "message_start") {
          yield { type: "assistant.start" }
        }
        for (const delta of toDeltas(message)) opts.onDelta(delta)
        continue
      }

      // Sampled on each assistant message, NOT at the result. `getContextUsage`
      // is a control request, and by the time the result arrives the channel is
      // already closing â it fails with "Query closed before response received",
      // which is exactly what happened until the worker's stderr was being read.
      // These are local IPC round trips to a process already running, so
      // sampling a few times a turn is cheap.
      if (opts.trackContext && (message as { type?: string }).type === "assistant") {
        try {
          lastUsage = await q.getContextUsage()
        } catch {
          /* the meter is a nicety; never fail a turn for it */
        }
      }

      // Emitted just BEFORE the result is normalized, so the log still ends in
      // exactly one terminal event â an invariant four consumers depend on.
      if (lastUsage && (message as { type?: string }).type === "result") {
        yield {
          type: "context.usage",
          totalTokens: lastUsage.totalTokens,
          maxTokens: lastUsage.maxTokens,
          percentage: lastUsage.percentage,
        }
      }

      for (const event of normalizeSdkMessage(message, {
        projectId: opts.projectId,
        cwd: opts.cwd,
        fallbackModel: opts.model,
      })) {
        if (event.type === "run.finished") {
          finished = true
          if (opts.followUps) chargeThisTurn(event)
          // A context reading belongs to the turn it was sampled in; carried
          // over, it would be emitted again ahead of the next turn's result.
          lastUsage = null
        }
        yield event
      }
    }
    while (pending.length) yield pending.shift()!
  } catch (err) {
    // Only report a throw that produced no result of its own: spawn failure, bad
    // config, transport death. A throw following a result is the SDK restating
    // an outcome already recorded.
    if (!finished) {
      yield { type: "run.error", message: err instanceof Error ? err.message : String(err) }
    }
  }
}
