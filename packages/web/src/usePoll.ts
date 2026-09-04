import { useEffect, useRef } from "react"

/**
 * Run something now, then on a beat, and never twice at once.
 *
 * The last clause is the whole reason this is a hook rather than four
 * `setInterval`s. `setInterval` fires on the clock whether or not the previous
 * call answered, and against a REMOTE project a poll does not: `gitPending` is
 * one ssh round trip at about 1.75s on a 1500ms interval, so every beat started
 * before the one before it finished and the overlap grew without bound. Each is
 * a fresh ssh process — Windows OpenSSH cannot multiplex — so what it grows into
 * is dozens of concurrent connections against a host whose sshd refuses them
 * past `MaxStartups` (10, on the machine this was found on) and a Windows spawn
 * table that answers `ENOMEM` before that. Measured: 12 at once already loses
 * one to `kex_exchange_identification`, 30 loses two thirds.
 *
 * The visible symptom was a commit dying on `did not answer \`git diff\` within
 * 90s` while the rail beside it, polling happily, drew the same repo as
 * perfectly reachable — the commit's connections were the ones being dropped.
 *
 * A skipped beat costs nothing: the next one reads the same state, and being one
 * beat behind is strictly better than being the reason the answer never arrives.
 *
 * That fix lived in `App.tsx` alone for a while, which is the other half of why
 * this exists. `Pending.tsx` polls `gitHistory` — also git, also possibly over
 * ssh — on a bare interval, so the same failure was one slow host away from
 * happening again in a second place. A guard that only one of two identical
 * callers has is a guard that has not been applied.
 *
 * `fn` is held in a ref, so a caller may pass an inline closure without
 * restarting the timer on every render. The EFFECT still keys on `intervalMs`
 * and whatever the caller lists in `deps` — those are the things that should
 * genuinely start a new beat.
 */
export function usePoll(
  fn: () => void | Promise<void>,
  intervalMs: number,
  deps: readonly unknown[] = [],
  /**
   * Whether to beat at all. False stops the timer AND skips the leading call.
   *
   * A parameter rather than the caller wrapping the hook in a condition, because
   * hooks cannot be called conditionally — and the alternative, an early return
   * inside `fn`, still pays for a timer and a wakeup per beat per caller. The
   * wall has one of these per project and turns off the ones scrolled off screen;
   * see `useOnScreen` for why that is a budget rather than a nicety.
   */
  enabled = true,
): void {
  const latest = useRef(fn)
  latest.current = fn

  const inFlight = useRef(false)

  useEffect(() => {
    if (!enabled) return
    let live = true
    const beat = async () => {
      if (inFlight.current) return
      inFlight.current = true
      try {
        await latest.current()
      } finally {
        inFlight.current = false
      }
    }
    void beat()
    const timer = setInterval(() => {
      // Unmounted between the tick and here is not worth a fetch nobody will
      // read — and for a remote project that fetch is a connection.
      if (live) void beat()
    }, intervalMs)
    return () => {
      live = false
      clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, enabled, ...deps])
}
