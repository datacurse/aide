/**
 * What a turn is doing right now, in one line.
 *
 * This is what is left of `card.ts`. There was a card view — one row per turn,
 * a strip of facts off exit codes and git with the model's own four fields under
 * it — and it was removed: compressing a turn to a fixed handful of lines lost
 * more than it saved, so the transcript is the only reading again. What survived
 * is this, because it was never really part of that view: the working bar has
 * always drawn its line from here.
 *
 * Pure, and in `protocol` rather than in the web package, so `pnpm smoke` can
 * assert it — a React component cannot be. The vocabulary is the thing worth
 * pinning: a new event type silently narrated as "Thinking" forever is the
 * failure `assertNarrationIsExhaustive` in `Working.tsx` exists to catch.
 */
import type { RunEvent } from "./events.js"

/**
 * A tool call as one short phrase: the tool, and what it is pointed at.
 *
 * The file fields are reduced to a BASENAME — this renders on one line in a
 * strip a few hundred pixels wide, and a full absolute path pushes the tool's
 * own name off the front, which is the half that says what is happening. A Bash
 * command keeps its HEAD rather than its tail, because a command says what it is
 * in its first two words and its arguments are usually longer than the line.
 *
 * Anything with no recognisable target degrades to the bare tool name, which is
 * what every line said before this existed.
 */
function describeTarget(name: string, input: unknown): string {
  const args = (input ?? {}) as Record<string, unknown>
  const str = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : "")
  const path = str("file_path") || str("path") || str("notebook_path")
  if (path) return `${name} ${path.split(/[/\\]/).pop() ?? path}`
  const command = str("command")
  if (command) {
    // The leading `cd <root>;` and any `VAR=value` prefixes come off first.
    // Nearly every command in this project's logs starts `cd C:/Users/loki/code/
    // aide; CI=true pnpm …`, which is 34 characters of boilerplate identical on
    // every line — so the truncated label read the same for a typecheck, a build
    // and a smoke run, which is precisely the distinction the line exists to
    // draw. What is left is the verb.
    const meat = command
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^cd\s+\S+\s*(?:&&|;)\s*/, "")
      .replace(/^(?:\w+=\S*\s+)+/, "")
    const head = meat.slice(0, 40)
    return `${name} ${head}${meat.length > 40 ? "…" : ""}`
  }
  const pattern = str("pattern")
  if (pattern) return `${name} ${pattern.slice(0, 30)}`
  return name
}

/**
 * What a turn is doing right now, and when that step started.
 *
 * `since` is the stamp of the event that OPENED the current step, which is the
 * whole point: an elapsed time measured from the start of the turn cannot tell
 * steady progress from a wedge, because both count up at the same rate. A clock
 * that keeps resetting is visible progress; one sitting at 4m is the thing worth
 * interrupting.
 *
 * Returns null for a run with no events yet — the caller decides what an
 * unstarted turn says, and "Sending" is a different statement from "Working".
 */
export function currentActivity(
  events: readonly RunEvent[],
): { label: string; since: number } | null {
  if (events.length === 0) return null

  // A tool call with no matching tool.end is the thing currently running, and a
  // check with no matching result is the same idea for a commit.
  const open = new Map<string, { label: string; at: number }>()
  let openCheck: { label: string; at: number } | null = null
  for (const e of events) {
    if (e.type === "tool.start") {
      open.set(e.toolUseId, { label: describeTarget(e.name, e.input), at: e.ts })
    } else if (e.type === "tool.end") {
      open.delete(e.toolUseId)
    } else if (e.type === "verify.started") {
      openCheck = { label: `Running ${e.command}`, at: e.ts }
    } else if (e.type === "verify.result") {
      openCheck = null
    }
  }

  // A pending permission outranks everything: nothing moves until it is answered.
  const answered = new Set(
    events.flatMap((e) => (e.type === "permission.resolved" ? [e.requestId] : [])),
  )
  const waiting = events.find(
    (e) => e.type === "permission.request" && !answered.has(e.requestId),
  )
  if (waiting?.type === "permission.request") {
    return { label: `Waiting for you · ${waiting.name}`, since: waiting.ts }
  }

  // The OLDEST open call, not the newest. One message can open several at once,
  // and the one that has been running longest is the one the turn is waiting on
  // — reporting the newest resets the clock every time a batch goes out and
  // hides exactly the stall this is for.
  const oldest = [...open.values()].sort((a, b) => a.at - b.at)[0]
  if (oldest) return { label: `Running ${oldest.label}`, since: oldest.at }
  if (openCheck) return { label: openCheck.label, since: openCheck.at }

  const last = events[events.length - 1]
  if (!last) return null
  // The commit narrates itself, and its own words beat anything derivable from
  // the shape of its log.
  const label =
    last.type === "commit.step"
      ? last.label
      : last.type === "commit.drafting"
        ? `Writing the message · ${last.model}`
        : last.type === "verify.result"
          ? "Checking"
          : last.type === "commit.drafted"
            ? "Committing"
            : last.type === "user.message"
              ? "Starting"
              : last.type === "assistant.thinking"
                ? "Thinking"
                : last.type === "assistant.text"
                  ? "Writing"
                  : last.type === "run.retry"
                    ? "Retrying"
                    : "Thinking"
  return { label, since: last.ts }
}
