/**
 * The ONLY file in aide that imports the Agent SDK.
 *
 * Everything above this line speaks `RunEventBody`; everything below speaks SDK
 * messages. Keeping the boundary in one file means the SDK's ~30-member message
 * union has exactly one place to be updated when it grows.
 */
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type { ModelSpend, RunEventBody, RunStatus } from "@aide/protocol"

export interface RunAgentOptions {
  runId: string
  taskId: string
  projectId: string
  /** The task body. This is the prompt. */
  prompt: string
  /** Absolute path to the worktree the agent runs inside. */
  cwd: string
  /** Worktree path relative to the project root, for display. */
  worktree: string
  model: string
  allowedTools: string[]
  maxBudgetUsd: number
  maxTurns?: number
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

export async function* runAgent(opts: RunAgentOptions): AsyncGenerator<RunEventBody> {
  // Streaming input mode. `prompt` must be an AsyncIterable for control requests
  // (interrupt) to be available at all. We yield one message and close the
  // stream, so the run ends after its turn instead of waiting for more input.
  async function* input(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: "user",
      message: { role: "user", content: opts.prompt },
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

  const q = query({
    prompt: input(),
    options: {
      model: opts.model,
      cwd: opts.cwd,
      allowedTools: opts.allowedTools,
      // Fail closed. Print mode starts in Manual on every plan, so an allowlist
      // alone is not a baseline: dontAsk denies anything not explicitly allowed
      // or in the read-only command set.
      permissionMode: "dontAsk",
      // Without this, runs end by asking a question nobody is there to answer
      // ("want me to fix it?"), which reads as done but leaves the task undone.
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: [
          "You are running as an autonomous task in a git worktree. No human will",
          "answer you during this run, so do not end your turn with a question or",
          "ask for confirmation before making a change the task clearly implies.",
          "Carry the task to completion. If something genuinely blocks you, say what",
          "blocked you and what decision is needed, then stop.",
        ].join(" "),
      },
      maxBudgetUsd: opts.maxBudgetUsd,
      ...(opts.maxTurns ? { maxTurns: opts.maxTurns } : {}),
      // Load the target project's .claude/ but not the host's ~/.claude, so a run
      // behaves the same on anyone's machine. Measured: the host's global config
      // is only ~700 tokens, so this is for reproducibility, not for savings.
      settingSources: ["project"],
      canUseTool: async (name, toolInput) => {
        pending.push({
          type: "tool.denied",
          name,
          input: toolInput,
          reason: "not in this run's allowlist",
        })
        return { behavior: "deny", message: `${name} is not permitted in this run.` }
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

      const m = message as unknown as Record<string, unknown>

      if (message.type === "system" && m["subtype"] === "init") {
        yield {
          type: "run.started",
          taskId: opts.taskId,
          projectId: opts.projectId,
          model: String(m["model"] ?? opts.model),
          cwd: opts.cwd,
          worktree: opts.worktree,
          sessionId: (m["session_id"] as string) ?? null,
        }
        continue
      }

      if (message.type === "system" && m["subtype"] === "api_retry") {
        yield {
          type: "run.retry",
          attempt: Number(m["attempt"] ?? 0),
          maxRetries: Number(m["max_retries"] ?? 0),
          retryDelayMs: Number(m["retry_delay_ms"] ?? 0),
          error: String(m["error"] ?? "unknown"),
        }
        continue
      }

      if (message.type === "assistant") {
        const parent = (m["parent_tool_use_id"] as string | null) ?? null
        const content = (m["message"] as { content?: unknown[] })?.content ?? []
        for (const b of content) {
          const block = b as Record<string, unknown>
          if (block["type"] === "text") {
            const text = String(block["text"] ?? "")
            if (text.trim()) yield { type: "assistant.text", text, parentToolUseId: parent }
          } else if (block["type"] === "thinking") {
            const text = String(block["thinking"] ?? "")
            if (text.trim()) yield { type: "assistant.thinking", text, parentToolUseId: parent }
          } else if (block["type"] === "tool_use") {
            yield {
              type: "tool.start",
              toolUseId: String(block["id"] ?? ""),
              name: String(block["name"] ?? "?"),
              input: block["input"],
              parentToolUseId: parent,
            }
          }
        }
        continue
      }

      if (message.type === "user") {
        const content = (m["message"] as { content?: unknown[] })?.content ?? []
        if (!Array.isArray(content)) continue
        for (const b of content) {
          const block = b as Record<string, unknown>
          if (block["type"] !== "tool_result") continue
          yield {
            type: "tool.end",
            toolUseId: String(block["tool_use_id"] ?? ""),
            ok: block["is_error"] !== true,
            summary: summarizeToolResult(block["content"]),
          }
        }
        continue
      }

      if (message.type === "result") {
        finished = true
        const subtype = String(m["subtype"] ?? "unknown")
        const denials = (m["permission_denials"] as Array<Record<string, unknown>>) ?? []
        yield {
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
        }
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
