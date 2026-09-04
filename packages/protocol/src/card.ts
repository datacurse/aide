/**
 * A turn reduced to the handful of facts you decide on.
 *
 * ## Three layers, and only one of them is written by a model
 *
 * The card is the simplified view of a conversation: one row per turn, read in
 * about two seconds, with the transcript one keystroke behind it. What makes it
 * trustworthy is where each field comes from.
 *
 * - DETERMINISTIC, and most of the card. `verify.result` carries each check's
 *   command and exit code, `commit.landed` its sha and paths, `run.finished` the
 *   outcome and the spend, `permission.request` whether something is blocked on
 *   you. All of it off exit codes and git. No model is consulted and none can
 *   contradict it.
 * - MODEL-WRITTEN, and deliberately narrow: `turn.summary`'s four fields, which
 *   are the things only the turn knows — what it meant to do, what should happen
 *   next, what it is unsure of. See `summary.ts` for why that block may never
 *   carry a pass/fail.
 * - RAW, which is the transcript this replaces on screen and does not replace on
 *   disk.
 *
 * The rule that keeps the layers from collapsing: a field is deterministic
 * unless it is impossible for it to be. `checks` and `changed` are counted here,
 * from events, precisely so nobody is ever tempted to read them off a sentence.
 *
 * ## Why this is a reducer and not a component
 *
 * Same reason `reduceActivity` is: the arithmetic is where this can be wrong in
 * ways nobody notices — a check counted twice, a blocked turn drawn as running,
 * a cancelled turn wearing a green tick. `pnpm smoke` asserts it against events
 * built by hand, which a React component cannot be.
 */
import type { RunEvent } from "./events.js"
import type { TurnSummary } from "./summary.js"

/**
 * What the card leads with, and the only thing on it that is a judgement.
 *
 * Ordered by what it costs you to miss one. `blocked` first because it is the
 * only state that is stopped ON you and will stay stopped until you look;
 * `failed` next because it is finished and wrong. `working` and `done` are the
 * quiet ones. This ordering is the list's grouping — needs-you, working, done —
 * and it exists as a number so the sort cannot drift from the vocabulary.
 */
export type CardState = "blocked" | "failed" | "working" | "done"

export const CARD_STATE_ORDER: Record<CardState, number> = {
  blocked: 0,
  failed: 1,
  working: 2,
  done: 3,
}

/** One check, as the card draws it. Straight off `verify.result`. */
export interface CardCheck {
  command: string
  ok: boolean
  /** True for a check the diff could not break. Drawn, never omitted. */
  skipped: boolean
}

export interface TurnCard {
  runId: string
  /** What the human asked, verbatim, for the row's own label. */
  prompt: string
  state: CardState
  /**
   * The model's own four fields, or null when the turn wrote no block.
   *
   * Null is drawn as degraded rather than filled in from the first line of the
   * reply. Falling back would be friendlier and would hide the parse rate, and
   * this is being built to change behaviour — so for now a turn that does not
   * comply should look like one that did not comply.
   */
  summary: TurnSummary | null
  /**
   * Every check the gate ran or skipped, in order.
   *
   * From `verify.result` and `verify.skipped` only. A skipped check is IN this
   * list, because a gate that quietly shrinks is indistinguishable from one that
   * broke — the same reason the transcript shows them.
   */
  checks: CardCheck[]
  /** Files the commit took. Empty for a turn that did not commit. */
  changed: number
  /** The commit, if one landed. */
  sha: string | null
  /** Estimated, like every cost figure here. Detail tier, not the card face. */
  costUsd: number
  turns: number
  wallMs: number
  startedAt: number
  /**
   * What the turn is doing RIGHT NOW, and since when. Null once it is over.
   *
   * The card of a running turn was a spinner and a total elapsed time, which
   * answers "is it still going" and not the question actually being asked, which
   * is "is it still going SOMEWHERE". A number that only counts up looks
   * identical whether the agent is working through a file or wedged on a call
   * that will never return.
   *
   * So the label names the current step and `since` is when THAT step began, not
   * when the turn did. A step whose clock resets every few seconds is visible
   * progress; one sitting at 4m is the thing worth interrupting, and the two are
   * now different pictures rather than the same one.
   */
  activity: { label: string; since: number } | null
}

/**
 * One run's events into one card.
 *
 * Pure, and exported for it. Handed an unfinished run it reports `working`,
 * which is what a turn in flight is — asking for a card mid-turn is the normal
 * case for the live view, not an edge one.
 */
export function reduceCard(
  runId: string,
  events: readonly RunEvent[],
  opts: {
    /**
     * This turn is over, whatever its events say.
     *
     * A turn replayed from the SDK's session store has no `run.finished` —
     * that event is aide's own, written to its own run log — so a reduction
     * that trusts the events alone reports every past turn of every
     * conversation as still working. A chat drawn as thirty spinning rows is
     * worse than useless: the one row that IS running stops being findable.
     *
     * Passed by the caller rather than inferred from a missing event, because
     * "no outcome" genuinely means two different things — a turn in flight, and
     * a turn from a source that never records outcomes — and only the caller
     * knows which source it is reading.
     */
    settled?: boolean
  } = {},
): TurnCard {
  const card: TurnCard = {
    runId,
    prompt: "",
    state: "working",
    summary: null,
    checks: [],
    changed: 0,
    sha: null,
    costUsd: 0,
    turns: 0,
    wallMs: 0,
    startedAt: events[0]?.ts ?? 0,
    activity: null,
  }

  const asked = new Set<string>()
  const answered = new Set<string>()
  let finished = false
  let failed = false

  for (const e of events) {
    switch (e.type) {
      case "user.message":
        // The FIRST one. A live run's log can hold a second — the SDK echoing
        // back the prompt aide already wrote down — and taking the last would
        // relabel the row with aide's own copy of the question.
        if (!card.prompt) card.prompt = e.text
        break
      case "turn.summary":
        // Last one wins. A turn that wrote a block, ran another tool and wrote a
        // second one has changed its mind, and the later answer is the one that
        // saw the whole turn.
        card.summary = {
          headline: e.headline,
          ...(e.next ? { next: e.next } : {}),
          ...(e.intent ? { intent: e.intent } : {}),
          ...(e.risk ? { risk: e.risk } : {}),
        }
        break
      case "verify.result":
        card.checks.push({ command: e.command, ok: e.ok, skipped: false })
        break
      case "verify.skipped":
        // `ok: true` is not a claim that anything passed — a skipped check is
        // drawn in its own style and never as a tick. It is here so the field is
        // never read as a failure by something that only branches on `ok`.
        card.checks.push({ command: e.command, ok: true, skipped: true })
        break
      case "commit.landed":
        card.sha = e.sha
        card.changed = e.paths.length
        break
      case "permission.request":
        asked.add(e.requestId)
        break
      case "permission.resolved":
        answered.add(e.requestId)
        break
      // The FIRST terminal event wins, which is why both arms are guarded.
      //
      // A log is supposed to end in exactly one, and `EventLog.append` enforces
      // that now — but it did not always, and the logs that got away are still
      // on disk: three runs on this machine carry a `success` followed by a
      // `cancelled` from `#retire` writing over an outcome the turn had already
      // reported, and others carry a redundant `run.error` after their result.
      // Taking the last one reports those as failures. The transcript already
      // drops the trailing `run.error` for the same reason, so a card that read
      // the other end would disagree with the transcript beside it about a run
      // both are drawing from one file.
      case "run.finished":
        if (finished) break
        finished = true
        failed = e.status === "failed" || e.status === "cancelled"
        card.costUsd = e.totalCostUsd
        card.turns = e.numTurns
        card.wallMs = Math.max(0, e.ts - card.startedAt)
        break
      case "run.error":
        if (finished) break
        finished = true
        failed = true
        card.wallMs = Math.max(0, e.ts - card.startedAt)
        break
      default:
        break
    }
  }

  // Blocked means STILL WAITING, which is why it is ANDed with the run being
  // live rather than allowed to outrank everything.
  //
  // The first version said an outstanding request wins outright, on the
  // reasoning that a run which ended with one ended because of it. Run against
  // this machine's real logs that put two runs at the top of the worklist as
  // "needs you" — with wall times of 44 hours, both killed by a daemon restart
  // with a question still open. Nobody can answer a request whose run is gone:
  // the `resolve` it would call lives in a process that no longer exists. A
  // permanent needs-you row that no action can clear is the worklist teaching
  // you to ignore it, which costs more than the row is worth.
  //
  // So a dead run holding a question is `failed`, which is what it is, and
  // `blocked` is reserved for the one state a person can actually act on.
  const waiting = [...asked].some((id) => !answered.has(id))
  // A replayed turn is over even though nothing in it says so — see `settled`.
  // It is folded in HERE rather than by setting `finished` in the loop, because
  // `finished` also guards which terminal event wins and the spend it carries,
  // and a replayed turn has neither to protect.
  const over = finished || opts.settled === true
  card.state = waiting && !over
    ? "blocked"
    : !over
      ? "working"
      : failed || waiting
        ? "failed"
        : "done"

  // An unfinished run has no duration of its own yet; measuring to the last
  // event would report a turn that has been thinking for a minute as 0s, since
  // nothing has been appended since it started. Skipped for a turn with no
  // stamps at all — a replayed one is all `ts: 0`, so this would be 0 anyway and
  // computing it invites reading the result as a measurement.
  if (!finished && card.startedAt > 0) {
    card.wallMs = Math.max(0, (events.at(-1)?.ts ?? card.startedAt) - card.startedAt)
  }

  // Only while it is running. A finished turn has an outcome, a summary and a
  // diffstat to show; "what it is doing now" is the answer to a question nobody
  // is asking about it any more, and leaving it on would put a stale "Running
  // pnpm smoke" under every completed card in the list.
  if (card.state === "working" || card.state === "blocked") {
    card.activity = currentActivity(events)
  }

  return card
}

/**
 * A tool call as one short phrase: the tool, and what it is pointed at.
 *
 * The file fields are reduced to a BASENAME — this renders on one line in a
 * pane a few hundred pixels wide, and a full absolute path pushes the tool's own
 * name off the front, which is the half that says what is happening. A Bash
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
 * Shared by the card and the working bar rather than written twice, because two
 * implementations of "what is happening" drift and the drift shows up as the bar
 * and the card above it disagreeing about the same live turn.
 *
 * `since` is the stamp of the event that OPENED the current step, which is the
 * whole point: an elapsed time measured from the start of the turn cannot tell
 * steady progress from a wedge, because both count up at the same rate.
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

/**
 * The card's one-line verdict on its checks.
 *
 * Null when the turn ran none, which is most turns — a chat that answered a
 * question has no gate to report, and drawing an empty badge on every row would
 * spend the most valuable pixel on the card saying nothing.
 */
export function checkVerdict(
  checks: readonly CardCheck[],
): { ok: boolean; ran: number; failed: number; skipped: number } | null {
  if (!checks.length) return null
  const ran = checks.filter((c) => !c.skipped)
  const failed = ran.filter((c) => !c.ok)
  return {
    ok: failed.length === 0,
    ran: ran.length,
    failed: failed.length,
    skipped: checks.length - ran.length,
  }
}

/**
 * A conversation's events into one card per turn, oldest first.
 *
 * Split on `user.message`, and NOT grouped by `runId`. The obvious version
 * groups by run id and it draws ONE card for an entire conversation: only the
 * live turn comes from a run log, and `sessions.ts` stamps everything it
 * replays out of the SDK's session store with `runId: sessionId`, so hundreds
 * of replayed messages share a single id. Watched doing exactly that — a
 * 587-message chat reduced to one row.
 *
 * A human message opens a turn in every source there is, which makes it the one
 * boundary both halves agree on. Events arriving before the first one open an
 * implicit turn rather than being dropped, because a card missing its opening
 * row reads as lost history rather than as a boundary problem.
 *
 * `settled` is decided per turn from whether any of its events carry a real
 * stamp: a run log writes `ts`, the session store does not, and only a run log
 * records outcomes. Here rather than in the caller so the rule has one home and
 * `pnpm smoke` can reach it — a React component cannot be asserted.
 */
export function cardsForConversation(events: readonly RunEvent[]): TurnCard[] {
  const turns: RunEvent[][] = []
  for (const e of events) {
    // A harness line does NOT open a turn, and that is not cosmetic. The CLI
    // writes `[Image: original 2560x1259…]` as its own user message directly
    // AFTER the question a screenshot was pasted with — so treating it as a
    // boundary cuts your prompt away from the reply that answers it, leaving one
    // card holding a question with no answer and the next holding an answer
    // captioned with image dimensions. Both are wrong, and the second is the one
    // that looks like the model ignored you.
    const opens = e.type === "user.message" && !isHarnessPrompt(e.text)
    if (opens || turns.length === 0) turns.push([])
    turns[turns.length - 1]?.push(e)
  }
  return turns
    .filter((list) => list.length > 0)
    .map((list, i) => {
      const fromLog = list.find((e) => e.runId && e.ts > 0)
      return reduceCard(fromLog?.runId ?? `turn-${i}`, list, { settled: !fromLog })
    })
    // What is left of the rule above: a turn opened by nothing but harness
    // bookkeeping, that then produced nothing either. A conversation resumed
    // with "Continue from where you left off." and no work done is one of these
    // — a row saying only that the harness spoke.
    //
    // Filtered on having NOTHING TO SHOW rather than on the text, so a resumed
    // turn that really did work keeps its card: it still has its checks, its
    // diffstat and its summary, and only the genuinely empty ones fall out.
    .filter(
      (card) =>
        card.summary !== null ||
        card.checks.length > 0 ||
        card.sha !== null ||
        card.state !== "done" ||
        !isHarnessPrompt(card.prompt),
    )
}

/**
 * A line the harness wrote, not the human.
 *
 * Deliberately a short, exact list. Anything looser risks swallowing a real
 * question, which is the one thing this view must never do — a missing card is
 * indistinguishable from a turn that never happened.
 */
function isHarnessPrompt(prompt: string): boolean {
  const text = prompt.trim()
  if (!text) return true
  // The caption written beside a pasted screenshot.
  if (/^\[Image: original \d+x\d+/.test(text)) return true
  return text === "Continue from where you left off."
}

/** Cards for a list, most urgent first, then newest. See `CARD_STATE_ORDER`. */
export function sortCards(cards: readonly TurnCard[]): TurnCard[] {
  return [...cards].sort(
    (a, b) =>
      CARD_STATE_ORDER[a.state] - CARD_STATE_ORDER[b.state] || b.startedAt - a.startedAt,
  )
}
