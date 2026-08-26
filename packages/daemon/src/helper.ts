/**
 * Short, single-shot model calls that are not runs.
 *
 * This and `agent.ts` are the only two files that import the Agent SDK. The
 * split is by shape, not by model: `agent.ts` drives a long tool-using session
 * that streams events; everything here is one prompt in, one string out, with
 * `tools: []` so there is no filesystem access and nothing to permit.
 *
 * It goes through the Agent SDK rather than the Messages API for one reason:
 * aide has no login of its own. The Agent SDK inherits whatever credentials the
 * machine already has, which for most people is a Claude subscription and not an
 * API key. Reaching for `@anthropic-ai/sdk` here would make commit messages the
 * one feature that silently requires ANTHROPIC_API_KEY.
 */
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
}

/** Models sometimes wrap the answer in a fence despite being told not to. */
function stripFence(text: string): string {
  const fenced = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/)
  return (fenced?.[1] ?? text).trim()
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
 * Draft a commit message for a finished task. The caller shows it to the human
 * to edit before anything is committed, which is why this returns a string
 * rather than committing anything itself.
 */
export async function draftCommitMessage(opts: DraftCommitMessageOptions): Promise<string> {
  const chunks: string[] = []

  const q = query({
    prompt: buildPrompt(opts),
    options: {
      model: opts.model,
      systemPrompt: SYSTEM,
      // No tools at all. This is text generation, not a session: nothing to
      // execute, nothing to permit, no working directory to reach.
      tools: [],
      allowedTools: [],
      // SDK isolation mode. The project's CLAUDE.md would arrive as instructions
      // to an agent, and this is not one — house style comes from the log above,
      // which is evidence rather than instruction.
      settingSources: [],
      maxTurns: 1,
      maxBudgetUsd: HELPER_BUDGET_USD,
    },
  })

  for await (const message of q) {
    if (message.type !== "assistant") continue
    const content = (message as unknown as Record<string, unknown>)["message"] as {
      content?: unknown[]
    }
    for (const b of content?.content ?? []) {
      const block = b as Record<string, unknown>
      if (block["type"] === "text") chunks.push(String(block["text"] ?? ""))
    }
  }

  const message = stripFence(chunks.join("").trim())
  if (!message) throw new Error("the model returned an empty commit message")
  return message
}
