/**
 * What is left of the plan, and when it comes back.
 *
 * Not the same kind of number as `ChatSpend`, and the difference is the whole
 * reason this is its own type. A conversation's cost is aide's own arithmetic
 * over its own run logs, in dollars, and an estimate. These come from the
 * subscription's usage endpoint, in percent, and are measured across every
 * client on the account at once — the CLI, the extension, claude.ai and aide
 * together. So a window here can be half gone with aide having run nothing all
 * day, and that is correct rather than a bug.
 */

/** One plan window: a share consumed, and the moment it goes back to zero. */
export interface UsageWindow {
  /** Stable key from the usage endpoint, e.g. `five_hour`. Used to key a list. */
  id: string
  /** Short enough for a 16rem rail: `5h`, `week`, `opus`. */
  label: string
  /** Percent of the window consumed, 0–100. */
  used: number
  /** epoch ms, or null when the endpoint named no reset — a window not in use. */
  resetsAt: number | null
  /** The sentence the rail shows on hover. Written where the shape is known. */
  detail: string
}

export interface PlanUsage {
  /** `pro`, `max`, `team`, `enterprise` — or null when there is no subscription. */
  plan: string | null
  /**
   * Whether plan windows apply at all.
   *
   * False for an API key, Bedrock and Vertex, where there is no plan to be out
   * of. `windows` is then empty and `reason` says which case it was, because
   * "no limits" and "could not ask" must not render as the same blank space.
   */
  available: boolean
  windows: UsageWindow[]
  /** Why there is nothing to show. Null when there is. */
  reason: string | null
  /** epoch ms this reading was taken — it is a cached snapshot, not a live wire. */
  readAt: number
}
