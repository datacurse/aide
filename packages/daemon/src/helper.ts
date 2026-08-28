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

// ---------------------------------------------------------------------------
// The spec
// ---------------------------------------------------------------------------

const SPEC_SYSTEM = [
  "You maintain a project's capability list: a markdown file saying what the app",
  "can and cannot do. Output the complete updated file and nothing else: no",
  "preamble, no explanation, no markdown code fences around the whole thing.",
  "",
  "You are shown the current file and a diff that is about to be committed.",
  "Change only what the diff earns. Add a line for a capability the diff adds,",
  "update a line the diff changes, and move a line out of a 'cannot' list only",
  "when the diff actually implements it. Everything the diff does not touch must",
  "come back BYTE FOR BYTE — headings, ordering, wording, blank lines.",
  "",
  "One line per capability, present tense, terse. This file goes into the context",
  "of every conversation in the project, so length is a real cost.",
  "",
  "Never claim something the diff does not show. A change that adds no capability",
  "and removes no limitation should come back completely unchanged — that is a",
  "normal and correct outcome, not a failure.",
].join("\n")

export interface DraftSpecOptions {
  model: string
  /** The current `.aide/spec.md`, or empty when the project has none yet. */
  spec: string
  /** What the human asked for, so the model can tell intent from incident. */
  request: string
  diffStat: string
  diff: string
}

/**
 * Propose the spec as it should read after this change.
 *
 * Returns the WHOLE file rather than a patch, for the same reason the commit
 * message is a whole message: the human edits it in a textarea before anything
 * is written, and reviewing a proposed document is easier than reviewing a
 * proposed edit script.
 *
 * Drafted here, at the commit gate, rather than by the agent while it worked —
 * an agent never knows when it is finished, because that is the human's call, so
 * there is no turn during a conversation on which it should write "the app can
 * now do X". Anchoring it to the commit means the claim and the code that earns
 * it land in one reviewable change.
 */
export async function draftSpecUpdate(opts: DraftSpecOptions): Promise<string> {
  const truncated = opts.diff.length > MAX_DIFF_CHARS
  const diff = truncated ? opts.diff.slice(0, MAX_DIFF_CHARS) : opts.diff

  const prompt = [
    "Current .aide/spec.md:",
    opts.spec.trim() || "(the project has no spec yet — write one from this change)",
    "",
    "What was asked for:",
    opts.request || "(not recorded)",
    "",
    "Files changed:",
    opts.diffStat.trim() || "(none reported)",
    "",
    truncated
      ? `Diff (truncated at ${MAX_DIFF_CHARS} characters — the file list above is complete, the hunks below are not; do not describe what you cannot see):`
      : "Diff:",
    diff,
  ].join("\n")

  const chunks: string[] = []
  const q = query({
    prompt,
    options: {
      model: opts.model,
      systemPrompt: SPEC_SYSTEM,
      tools: [],
      allowedTools: [],
      settingSources: [],
      maxTurns: 1,
      // Larger than the commit-message budget because the whole file comes back,
      // and a spec that grows past the cap would silently return truncated.
      maxBudgetUsd: HELPER_BUDGET_USD * 4,
    },
  })

  for await (const message of q) {
    if (message.type !== "assistant") continue
    const content = (message as unknown as Record<string, unknown>)["message"] as {
      content?: unknown[]
    }
    for (const block of content?.content ?? []) {
      const b = block as Record<string, unknown>
      if (b["type"] === "text") chunks.push(String(b["text"] ?? ""))
    }
  }

  return stripFence(chunks.join("").trim())
}
