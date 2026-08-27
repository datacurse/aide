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
  /** The task title. Composed into the user turn — it is part of the request. */
  title: string
  /** The task body. May be empty; the title alone is then the request. */
  prompt: string
  /**
   * Prose from `.aide/project.md`. Appended to the SYSTEM prompt, not the user
   * turn: it is a durable constraint on every task in this project, not part of
   * what is being asked this time.
   */
  projectDoc: string
  /** Absolute path to the worktree the agent runs inside. */
  cwd: string
  /** Worktree path relative to the project root, for display. */
  worktree: string
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
}

const truncate = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n)}...` : s)

/** tool_result content is either a string or an array of blocks. Render either. */
function summarizeToolResult(content: unknown): string {
  if (typeof content === "string") return truncate(content.trim())
  if (Array.isArray(content)) {
    const text = content
      .map((b) => {
        const block = b as Record<string, unknown>
        return block["type"] === "text" ? String(block["text"] ?? "") : `[${block["type"]}]`
      })
      .join("\n")
    return truncate(text.trim())
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
 * rest — block starts and stops, message_start — carry nothing a reader needs
 * that the finished message will not say better.
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
  worktree: string
  /** Used when the message does not name a model of its own. */
  fallbackModel: string
}

/**
 * One SDK message in, zero or more `RunEventBody` out. THE mapping.
 *
 * Kept as a pure function rather than inlined in the streaming loop because a
 * session read back from `~/.claude/projects/*.jsonl` carries the same message
 * shapes as the live stream. Sharing this means a replayed conversation renders
 * identically to a live run — same tool rows, same outcome line — and it keeps
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
        worktree: ctx.worktree,
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
    for (const b of content) {
      const block = b as Record<string, unknown>
      if (block["type"] === "tool_result") {
        out.push({
          type: "tool.end",
          toolUseId: String(block["tool_use_id"] ?? ""),
          ok: block["is_error"] !== true,
          summary: summarizeToolResult(block["content"]),
        })
      } else if (block["type"] === "text") {
        const text = String(block["text"] ?? "")
        if (text.trim()) out.push({ type: "user.message", text })
      }
    }
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

/** Cap the project doc so a runaway project.md cannot crowd out the task. */
const MAX_PROJECT_DOC_CHARS = 8_000

/**
 * The request, as the agent sees it.
 *
 * The title used to be thrown away — only the body was sent — which discarded
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
  const content =
    opts.attachments?.length
      ? [
          ...opts.attachments.map((a) => ({
            type: "image" as const,
            source: { type: "base64" as const, media_type: a.mediaType, data: a.data },
          })),
          { type: "text" as const, text: request },
        ]
      : request

  // Streaming input mode. `prompt` must be an AsyncIterable for control requests
  // (interrupt) to be available at all. We yield one message and close the
  // stream, so the run ends after its turn instead of waiting for more input.
  async function* input(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: "",
    } as SDKUserMessage
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

  const q = query({
    prompt: input(),
    options: {
      model: opts.model,
      cwd: opts.cwd,
      allowedTools: opts.allowedTools,
      // A task run fails closed — print mode starts in Manual on every plan, so
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
          [
            "You are running as an autonomous task in a git worktree. No human will",
            "answer you during this run, so do not end your turn with a question or",
            "ask for confirmation before making a change the task clearly implies.",
            "Carry the task to completion. If something genuinely blocks you, say what",
            "blocked you and what decision is needed, then stop.",
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
              ].join("\n")
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
      },
      // Without `display: "summarized"` the reasoning arrives as thinking blocks
      // with EMPTY text — "omitted" is the default on Opus 5 and its siblings —
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

      // Ask how full the context is while the query is still alive — this is a
      // control request, so it stops being available the moment the turn ends.
      // Guarded: an experimental control request must not be able to fail a turn
      // that has already produced its result.
      // Partial messages are the live typing. They are handed to onDelta and
      // then dropped: `normalizeSdkMessage` ignores `stream_event`, so nothing
      // token-sized ever reaches the durable event log.
      if (opts.onDelta && (message as { type?: string }).type === "stream_event") {
        for (const delta of toDeltas(message)) opts.onDelta(delta)
        continue
      }

      // Sampled on each assistant message, NOT at the result. `getContextUsage`
      // is a control request, and by the time the result arrives the channel is
      // already closing — it fails with "Query closed before response received",
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
      // exactly one terminal event — an invariant four consumers depend on.
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
        worktree: opts.worktree,
        fallbackModel: opts.model,
      })) {
        if (event.type === "run.finished") finished = true
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
