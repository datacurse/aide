/**
 * How much of the plan is left, straight from the subscription.
 *
 * This is the third file that touches the Agent SDK, and it is neither of the
 * other two shapes: no prompt is ever sent and no model is called. A session is
 * opened, one control request is asked of it — the same `/usage` the CLI's own
 * dialog renders — and it is closed again. It costs a subprocess and about a
 * second and a half, and it spends no tokens.
 *
 * It is asked for rather than watched. The SDK does emit `rate_limit_event`
 * during a run, which would be free, but only while a run is happening and only
 * for the one window that is binding — a rail whose whole job is to answer "how
 * much have I got left right now" cannot be a number last seen during a turn
 * that ended an hour ago.
 *
 * Every figure is the account's, not aide's. A plan window is measured across
 * every client on it at once, so this moves when you use the CLI, the extension
 * or claude.ai, and it is unrelated to the per-conversation costs in `spend.ts`.
 */
import { query, type SDKControlGetUsageResponse, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type { PlanUsage, UsageWindow } from "@aide/protocol"

/**
 * How long a reading stands.
 *
 * The browser polls the rail on its own beat and there may be more than one tab;
 * this is what stops each of those becoming a subprocess. A window that takes
 * five hours to fill does not move perceptibly in a minute, and a turn that has
 * just spent a chunk of one still shows up within a minute of finishing.
 */
const FRESH_MS = 60_000

/**
 * A failed reading is cached too, and for longer.
 *
 * The failures are things that stay broken — no credentials, no network, an SDK
 * that renamed the experimental request — so retrying every minute would spawn a
 * subprocess a minute forever on a machine that is never going to answer.
 */
const STALE_FRESH_MS = 10 * 60_000

/**
 * Long enough for a cold CLI start plus the round trip to the usage endpoint,
 * short enough that the rail is not the thing keeping a wedged subprocess alive.
 */
const TIMEOUT_MS = 20_000

let cached: { at: number; usage: PlanUsage } | null = null
let inFlight: Promise<PlanUsage> | null = null

/** The current reading, from cache when it is fresh enough. */
export async function planUsage(): Promise<PlanUsage> {
  const fresh = cached?.usage.available ? FRESH_MS : STALE_FRESH_MS
  if (cached && Date.now() - cached.at < fresh) return cached.usage
  // One reading at a time. Two tabs polling half a second apart would otherwise
  // each start a session, and neither would be the faster for it.
  if (inFlight) return inFlight
  const reading = read().then((usage) => {
    cached = { at: Date.now(), usage }
    return usage
  })
  inFlight = reading
  reading.catch(() => {}).finally(() => {
    if (inFlight === reading) inFlight = null
  })
  return reading
}

async function read(): Promise<PlanUsage> {
  const abortController = new AbortController()

  // A prompt that yields nothing and does not end. Streaming-input mode is what
  // keeps the session open with no turn in it; a string prompt would start work
  // immediately, and a generator that returned would close stdin and take the
  // session down before the control request could be answered.
  let stop = () => {}
  const held = new Promise<void>((resolve) => {
    stop = resolve
  })
  async function* idle(): AsyncGenerator<SDKUserMessage> {
    await held
  }

  const timer = setTimeout(() => abortController.abort(), TIMEOUT_MS)
  // Started inside the try, so that a session which cannot even be constructed
  // — no CLI on the machine, a spawn the OS refuses — comes back as a rail with
  // one fewer line rather than as a 500 on a route the page polls forever.
  let drained: Promise<void> | null = null

  try {
    const q = query({
      prompt: idle(),
      options: {
        // No tools, no project settings, no working directory: nothing here reads
        // a repository, and a session that loaded a CLAUDE.md would be paying to
        // build a context it is never going to use.
        tools: [],
        allowedTools: [],
        settingSources: [],
        maxTurns: 1,
        abortController,
      },
    })

    // Control responses arrive on the message stream, so somebody has to be
    // reading it or the request below waits forever. Nothing here wants the
    // messages themselves.
    drained = (async () => {
      try {
        for await (const _ of q) {
          /* discarded */
        }
      } catch {
        /* the abort below is the normal way this ends */
      }
    })()

    // Experimental, and named to say so. Guarded rather than trusted: this is a
    // decoration on a status rail, and an SDK that renames it must degrade to a
    // rail with one fewer line rather than to a 500.
    const answer = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()
    return toPlanUsage(answer)
  } catch (err) {
    return {
      plan: null,
      available: false,
      windows: [],
      reason: err instanceof Error ? err.message : String(err),
      readAt: Date.now(),
    }
  } finally {
    clearTimeout(timer)
    stop()
    // Both, in this order: ending the input stream is the cooperative exit, and
    // the abort is what guarantees the subprocess is gone if it does not take
    // it. Not awaited — `drained` swallows its own errors, and the caller is an
    // HTTP request that has an answer already.
    abortController.abort()
    void drained
  }
}

/** The endpoint's key for a window, and what a 16rem rail can call it. */
const LABELS: Record<string, string> = {
  five_hour: "5h",
  seven_day: "week",
  seven_day_opus: "opus",
  seven_day_sonnet: "sonnet",
  seven_day_oauth_apps: "apps",
}

/** The sentence behind each label, since none of the labels say their period. */
const PERIODS: Record<string, string> = {
  five_hour: "The 5-hour window",
  seven_day: "The weekly window, across every model",
  seven_day_opus: "The weekly window for Opus",
  seven_day_sonnet: "The weekly window for Sonnet",
  seven_day_oauth_apps: "The weekly window for apps using your account",
}

const MEASURED_ACROSS =
  "Measured across everything on your account — the CLI, the extension and " +
  "claude.ai as well as aide."

function toPlanUsage(answer: SDKControlGetUsageResponse): PlanUsage {
  if (!answer.rate_limits_available || !answer.rate_limits) {
    return {
      plan: answer.subscription_type,
      available: false,
      windows: [],
      // The ordinary case, not a failure: an API key is billed rather than
      // metered, so there is no window to be near the end of.
      reason: "this machine is not authenticated with a Claude plan, so there are no windows",
      readAt: Date.now(),
    }
  }

  const limits = answer.rate_limits
  const windows: UsageWindow[] = []

  for (const id of Object.keys(LABELS)) {
    const window = limits[id as keyof typeof limits] as
      | { utilization: number | null; resets_at: string | null }
      | null
      | undefined
    // Absent and null both mean this account has no such window. Zero does not,
    // which is why the check is on the window and not on the number.
    if (!window || window.utilization === null) continue
    windows.push(makeWindow(id, LABELS[id] ?? id, PERIODS[id] ?? "This window", window))
  }

  // Per-model weekly windows the server sends by name rather than by key. Their
  // display name IS the label — `Fable`, not `week · Fable` — because the rail
  // has room for one word and the period is in the hover.
  for (const scoped of limits.model_scoped ?? []) {
    if (scoped.utilization === null) continue
    // A model window at zero with no reset named is one this account has never
    // opened. The server sends it for completeness; a rail four inches wide has
    // no room for a limit nobody is approaching, and it appears the moment it
    // means something.
    if (scoped.utilization === 0 && scoped.resets_at === null) continue
    const label = scoped.display_name.toLowerCase()
    windows.push(
      makeWindow(
        `model:${scoped.display_name}`,
        label,
        `The weekly window for ${scoped.display_name}`,
        scoped,
      ),
    )
  }

  return {
    plan: answer.subscription_type,
    available: true,
    windows,
    reason: null,
    readAt: Date.now(),
  }
}

function makeWindow(
  id: string,
  label: string,
  period: string,
  window: { utilization: number | null; resets_at: string | null },
): UsageWindow {
  const used = Math.max(0, Math.min(100, Math.round(window.utilization ?? 0)))
  const parsed = window.resets_at ? Date.parse(window.resets_at) : Number.NaN
  const resetsAt = Number.isFinite(parsed) ? parsed : null
  return {
    id,
    label,
    used,
    resetsAt,
    detail: `${period}: ${used}% used, ${100 - used}% left. ${MEASURED_ACROSS}`,
  }
}
