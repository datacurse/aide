/**
 * Where runs meet the Agent SDK.
 *
 * Everything above this line speaks `RunEventBody`; everything below speaks SDK
 * messages. Keeping the boundary here means the SDK's ~30-member message union
 * has exactly one place to be updated when it grows.
 *
 * `helper.ts` is the only other file that imports the SDK, and deliberately
 * touches none of this: it makes one-shot text calls with no tools and returns a
 * string, so it never sees a message union to normalize.
 */
import { randomUUID } from "node:crypto"
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type {
  Attachment,
  ChatMode,
  EffortLevel,
  MessageImage,
  ModelSpend,
  RunDelta,
  RunEventBody,
  RunStatus,
} from "@aide/protocol"
import { checkBashCommand } from "./policy.js"

export interface RunAgentOptions {
  runId: string
  taskId: string
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
 * `mode`, `effort` and `model` are per-turn choices in the composer but
 * per-query options in the SDK, so a session that outlives a turn has to apply
 * them as control requests before the message goes in. All three have one:
 * `setPermissionMode`, `applyFlagSettings` and `setModel` â which is what makes
 * keeping the session open possible without freezing the toolbar.
 */
export interface FollowUpTurn {
  runId: string
  text: string
  attachments?: Attachment[]
  mode?: ChatMode
  effort?: EffortLevel
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

const statusFor = (subtype: string): RunStatus => (subtype === "success" ? "success" : "failed")

/**
 * aide's mode names to the SDK's. Kept as a table rather than reusing the SDK's
 * strings directly so the UI vocabulary matches the Claude Code UI ("Manual")
 * rather than the transport ("default").
 */
const CHAT_TO_SDK_MODE: Record<ChatMode, "default" | "acceptEdits" | "plan" | "auto"> = {
  manual: "default",
  acceptEdits: "acceptEdits",
  plan: "plan",
  auto: "auto",
}

/**
 * One `stream_event` into zero or more deltas.
 *
 * The payload is a raw Messages API streaming event, so the shapes worth
 * handling are `content_block_delta` (text and thinking, arriving in pieces) and
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
  taskId: string
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
        taskId: ctx.taskId,
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
    const denials = (m["permission_denials"] as Array<Record<string, unknown>>) ?? []
    return [
      {
        type: "run.finished",
        subtype,
        status: statusFor(subtype),
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
 * empty body being handed an empty user message. Composed in one place so the
 * two cannot drift.
 */
export function composeRequest(title: string, prompt: string): string {
  const body = prompt.trim()
  return body ? `# ${title}\n\n${body}` : title
}

export async function* runAgent(opts: RunAgentOptions): AsyncGenerator<RunEventBody> {
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

  // Streaming input mode. `prompt` must be an AsyncIterable for control requests
  // (interrupt) to be available at all.
  //
  // Without `followUps` we yield one message and close the stream, so the run
  // ends after its turn instead of waiting for more input. With it, the stream
  // stays open and the session survives between turns â see the field's comment.
  async function* input(): AsyncGenerator<SDKUserMessage> {
    opts.onTurnStart?.(opts.runId)
    yield userMessage(request, opts.attachments)
    if (!opts.followUps) return

    for await (const turn of opts.followUps) {
      // Applied BEFORE the message goes in, or the turn runs under the previous
      // turn's settings â switching to Plan and sending would have planned
      // nothing and edited everything.
      if (turn.mode) await q.setPermissionMode(CHAT_TO_SDK_MODE[turn.mode])
      if (turn.model) await q.setModel(turn.model)
      if (turn.effort) await q.applyFlagSettings({ effortLevel: turn.effort })
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

  const q = query({
    prompt: input(),
    options: {
      model: opts.model,
      cwd: opts.cwd,
      allowedTools: opts.allowedTools,
      // A task run fails closed â print mode starts in Manual on every plan, so
      // an allowlist alone is not a baseline, and `dontAsk` denies anything not
      // explicitly allowed or in the read-only command set.
      //
      // A chat does not, because someone is watching. `manual` maps to the SDK's
      // `default`, which routes an ask to canUseTool below.
      permissionMode: opts.chatMode ? CHAT_TO_SDK_MODE[opts.chatMode] : "dontAsk",
      // A chat gets the whole Claude Code toolset AVAILABLE, while auto-approving
      // only the read-only ones (see `chatAutoAllowTools`). `tools` decides what
      // exists; `allowedTools` decides what skips the question. A task run leaves
      // this alone and keeps the narrow set it was given.
      ...(opts.chatMode ? { tools: { type: "preset" as const, preset: "claude_code" as const } } : {}),
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
      thinking: { type: "adaptive", display: "summarized" },
      // Only when someone is watching. Partial messages are thousands of events
      // per turn, and a headless task has nobody to show them to.
      ...(opts.onDelta ? { includePartialMessages: true } : {}),
      ...(opts.maxBudgetUsd ? { maxBudgetUsd: opts.maxBudgetUsd } : {}),
      ...(opts.maxTurns ? { maxTurns: opts.maxTurns } : {}),
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
        // A chat asks. This is the whole difference between the two kinds of
        // run: a human is present, so a call the SDK could not resolve becomes a
        // question rather than a refusal. The turn blocks here until the answer
        // comes back through the browser.
        if (opts.onPermission) {
          const requestId = randomUUID()
          const allowed = await opts.onPermission({ requestId, name, input: toolInput })
          if (allowed) return { behavior: "allow", updatedInput: toolInput }
          return { behavior: "deny", message: "You declined this." }
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
        // without it those two are the same number and a receipt cannot say
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
        taskId: opts.taskId,
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
