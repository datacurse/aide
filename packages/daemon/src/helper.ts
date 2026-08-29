/**
 * Short, single-shot model calls that are not runs.
 *
 * One of three files that import the Agent SDK, split by shape rather than by
 * model: `agent.ts` drives a long tool-using session that streams events,
 * `usage.ts` opens one and sends no prompt at all, and everything here is one
 * prompt in, one string out, with `tools: []` so there is no filesystem access
 * and nothing to permit.
 *
 * It goes through the Agent SDK rather than the Messages API for one reason:
 * aide has no login of its own. The Agent SDK inherits whatever credentials the
 * machine already has, which for most people is a Claude subscription and not an
 * API key. Reaching for `@anthropic-ai/sdk` here would make commit messages the
 * one feature that silently requires ANTHROPIC_API_KEY.
 */
import type { ModelSpend } from "@aide/protocol"
import { query } from "@anthropic-ai/claude-agent-sdk"

/**
 * A diff large enough to matter still fits — Sonnet's context is 1M tokens — but
 * an unbounded slice of a generated-file blowout is worth neither the tokens nor
 * the wait. When this trips, the model is told, and `--stat` still lists every
 * file, so the summary stays complete even when the hunks are not.
 */
const MAX_DIFF_CHARS = 200_000

/** A commit message is a few hundred tokens. This only catches a runaway. */
const HELPER_BUDGET_USD = 0.5

/**
 * How much of a parked chat the namer is shown.
 *
 * A name comes from what the request is about, and that is in its opening lines
 * — a pasted stack trace after them changes nothing about the label and costs
 * tokens on every park. The model is not told about this cut, unlike the diff
 * above: a title written from the first 2000 characters of a longer request is
 * the right title anyway.
 */
const MAX_NAME_INPUT_CHARS = 2_000

/** Room for a few words in a 320px column, which is the whole of what this is for. */
const MAX_NAME_CHARS = 48

/** A title is a dozen tokens. This only catches a runaway. */
const NAME_BUDGET_USD = 0.05

const NAME_SYSTEM = [
  "You name pieces of work. You are given something somebody wants done, and you",
  "answer with a short label for it — the line they will scan a list for later.",
  "",
  "Output the label and nothing else: no preamble, no explanation, no quotes, no",
  "markdown, no trailing period. At most six words and 48 characters. Name what",
  "the work is about, in the requester's own vocabulary; do not invent detail",
  "they did not give you, and do not restate the whole request.",
].join("\n")

const SYSTEM = [
  "You write git commit messages. Output the message and nothing else: no",
  "preamble, no explanation, no markdown code fences.",
  "",
  "Format: a subject line in the imperative mood, at most 72 characters, with no",
  "trailing period. Then a blank line. Then a body, wrapped at 72 columns, that",
  "says why the change was made and anything a reviewer would not guess from the",
  "diff. Omit the body entirely for a change whose subject already says it all.",
  "",
  "Match the style of the recent commit subjects you are shown — prefix",
  "conventions, capitalization, and tense are the project's to set, not yours.",
  "Describe what the diff actually does. Do not repeat the task description back",
  "if the diff diverged from it, and never claim a change the diff does not show.",
].join("\n")

export interface DraftCommitMessageOptions {
  model: string
  /** Task title. */
  title: string
  /** Task body — what the agent was asked to do. */
  prompt: string
  /** `git diff --stat`: the complete file list, never truncated. */
  diffStat: string
  /** `git diff`: the hunks, truncated at MAX_DIFF_CHARS. */
  diff: string
  /** Recent subjects from the project's own log, newest first. */
  recentSubjects: string[]
  /**
   * Text as it arrives, for a caller that has somewhere to put it.
   *
   * Absent by default, and its absence turns partial messages off at the SDK
   * rather than just ignoring them: a helper call nobody is watching should not
   * be paying to stream.
   */
  onText?: (text: string) => void
}

/** Models sometimes wrap the answer in a fence despite being told not to. */
function stripFence(text: string): string {
  const fenced = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/)
  return (fenced?.[1] ?? text).trim()
}

/**
 * What one helper call produced, and what it cost.
 *
 * The spend used to be dropped on the floor, which was defensible while these
 * calls happened inside an HTTP request nobody was accounting for. Committing is
 * a run of its own now, and a run log ends in a `run.finished` carrying what the
 * run spent — so a commit reporting $0 over the call that wrote its message
 * would quietly under-report every profile that adds those up.
 */
export interface Drafted {
  text: string
  costUsd: number
  modelUsage: Record<string, ModelSpend>
}

/**
 * Read a single-shot query to the end: the text it produced, and the accounting
 * on its result message.
 *
 * The spend mapping is deliberately a copy of `toModelSpend` in agent.ts rather
 * than an import of it. That file is the worker's half of the SDK and the daemon
 * process has so far only ever needed its types; loading the whole run machinery
 * to normalize five numbers would be a strange trade for a duplicate this size.
 */
async function drain(
  q: AsyncIterable<unknown>,
  onText?: (text: string) => void,
): Promise<Drafted> {
  const chunks: string[] = []
  let costUsd = 0
  const modelUsage: Record<string, ModelSpend> = {}

  for await (const raw of q) {
    const message = raw as Record<string, unknown>
    // The same characters as the finished `assistant` message below, arriving
    // early. `chunks` is still built from that message and not from these, so a
    // dropped delta costs the animation and nothing else.
    if (message["type"] === "stream_event") {
      if (onText) {
        const event = message["event"] as Record<string, unknown> | undefined
        if (event?.["type"] === "content_block_delta") {
          const d = event["delta"] as Record<string, unknown> | undefined
          if (d?.["type"] === "text_delta") {
            const text = String(d["text"] ?? "")
            if (text) onText(text)
          }
        }
      }
      continue
    }
    if (message["type"] === "result") {
      costUsd = Number(message["total_cost_usd"] ?? 0)
      const entries = Object.entries(
        (message["modelUsage"] ?? {}) as Record<string, Record<string, unknown>>,
      )
      for (const [model, u] of entries) {
        modelUsage[model] = {
          inputTokens: Number(u["inputTokens"] ?? 0),
          outputTokens: Number(u["outputTokens"] ?? 0),
          cacheReadInputTokens: Number(u["cacheReadInputTokens"] ?? 0),
          cacheCreationInputTokens: Number(u["cacheCreationInputTokens"] ?? 0),
          costUSD: Number(u["costUSD"] ?? 0),
        }
      }
      continue
    }
    if (message["type"] !== "assistant") continue
    const content = message["message"] as { content?: unknown[] }
    for (const b of content?.content ?? []) {
      const block = b as Record<string, unknown>
      if (block["type"] === "text") chunks.push(String(block["text"] ?? ""))
    }
  }

  return { text: stripFence(chunks.join("").trim()), costUsd, modelUsage }
}

function buildPrompt(opts: DraftCommitMessageOptions): string {
  const truncated = opts.diff.length > MAX_DIFF_CHARS
  const diff = truncated ? opts.diff.slice(0, MAX_DIFF_CHARS) : opts.diff

  const sections = [
    `Task: ${opts.title}`,
    "",
    "What the agent was asked to do:",
    opts.prompt || "(no description)",
    "",
    "Files changed:",
    opts.diffStat.trim() || "(none reported)",
  ]

  if (opts.recentSubjects.length) {
    sections.push(
      "",
      "Recent commit subjects in this project, newest first — match this style:",
      ...opts.recentSubjects.map((s) => `  ${s}`),
    )
  }

  sections.push(
    "",
    truncated
      ? `Diff (truncated at ${MAX_DIFF_CHARS} characters — the file list above is complete, the hunks below are not; do not describe what you cannot see):`
      : "Diff:",
    diff,
  )

  return sections.join("\n")
}

/**
 * Draft a commit message for a finished piece of work.
 *
 * Returns the text rather than committing anything: the caller is the commit
 * run, which puts this on the transcript before it stages a single path.
 */
export async function draftCommitMessage(opts: DraftCommitMessageOptions): Promise<Drafted> {
  const drafted = await drain(
    query({
      prompt: buildPrompt(opts),
      options: {
        model: opts.model,
        systemPrompt: SYSTEM,
        // Only when somebody asked for the text as it is written.
        ...(opts.onText ? { includePartialMessages: true } : {}),
        // No tools at all. This is text generation, not a session: nothing to
        // execute, nothing to permit, no working directory to reach.
        tools: [],
        allowedTools: [],
        // SDK isolation mode. The project's CLAUDE.md would arrive as
        // instructions to an agent, and this is not one — house style comes from
        // the log above, which is evidence rather than instruction.
        settingSources: [],
        maxTurns: 1,
        maxBudgetUsd: HELPER_BUDGET_USD,
      },
    }),
    opts.onText,
  )

  if (!drafted.text) throw new Error("the model returned an empty commit message")
  return drafted
}

/**
 * A label out of whatever the model actually said.
 *
 * Everything here is a way the answer arrives right in substance and wrong in
 * shape — a quoted phrase, a sentence with a full stop, six words that turn out
 * to be sixty characters. None of them is worth a retry that costs another call,
 * and a row that has to be scanned cannot afford any of them either.
 */
function tidyName(raw: string): string {
  const line = raw.split("\n").map((s) => s.trim()).find(Boolean) ?? ""
  const label = line.replace(/^["'`]+|["'`]+$/g, "").replace(/[.\s]+$/, "").trim()
  if (label.length <= MAX_NAME_CHARS) return label
  const cut = label.slice(0, MAX_NAME_CHARS)
  const space = cut.lastIndexOf(" ")
  return `${(space > MAX_NAME_CHARS / 2 ? cut.slice(0, space) : cut).trim()}…`
}

/**
 * Name a chat that has not started, from what it says.
 *
 * The SDK names a session a second or two into its first turn, which is the
 * wrong end of a backlog: a chat you parked and left is exactly the one you have
 * to find again later, and until it runs the only thing the row can show is the
 * first line of what you typed. This is that name, at the moment the request is
 * written rather than at the moment it is spent.
 *
 * Its cost is not attributed to anything, unlike `draftCommitMessage`'s, and
 * that is a real gap rather than an oversight: a parked chat is not a run, so
 * there is no log for it to end in. It is a few hundred tokens on the helper
 * model, once per parked request — the caller is what decides that "once", and
 * `naming.ts` in the web package is where that decision lives.
 */
export async function nameChat(opts: { model: string; text: string }): Promise<string> {
  const drafted = await drain(
    query({
      prompt: opts.text.slice(0, MAX_NAME_INPUT_CHARS),
      options: {
        model: opts.model,
        systemPrompt: NAME_SYSTEM,
        // Same isolation as the drafter above, for the same reasons: no tools to
        // permit, and the project's CLAUDE.md is instructions to an agent, which
        // this is not.
        tools: [],
        allowedTools: [],
        settingSources: [],
        maxTurns: 1,
        maxBudgetUsd: NAME_BUDGET_USD,
      },
    }),
  )

  const name = tidyName(drafted.text)
  if (!name) throw new Error("the model returned an empty name")
  return name
}
