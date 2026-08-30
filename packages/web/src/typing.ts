import { useEffect, useRef, useState } from "react"

/**
 * The reply, revealed at a steady pace rather than in the bursts it arrives in.
 *
 * The stream is not slow — it is *lumpy*. The SDK hands the daemon a chunk, the
 * daemon forwards it, and a paragraph lands in one frame; then nothing for most
 * of a second while the next one is generated. Rendered directly that reads as a
 * page stuttering, not as something being written.
 *
 * So this holds the arrived text and reveals a prefix of it, advancing every
 * frame. It only ever LAGS the truth, never invents it — what is on screen is
 * always a prefix of what the daemon actually sent, so no character appears
 * before it exists and none is dropped.
 *
 * It paces the reveal and nothing else. A block that finishes while the reveal
 * is still behind is shown in full immediately, rather than being held back
 * until the animation agrees: the finished `assistant.text` event replaces the
 * draft, and this hook has no say over an event. That is the right way round —
 * a turn is over when the daemon says so, and an animation that could delay the
 * end of one would be an animation lying about the state of the run.
 */

/**
 * Where the preference lives, and its default.
 *
 * Off. An animation between you and the answer is a taste, and the one thing
 * every reader of a transcript has in common is wanting to read it — so this is
 * something you go and switch on, not something aide decides you wanted.
 */
export const TYPING_KEY = "aide.typing"

/**
 * How far behind the stream the reveal aims to sit, in milliseconds.
 *
 * This is the whole design, and it is the thing the first attempt got wrong.
 * That version drained a share of the BACKLOG per frame, which sounds
 * self-correcting and is: it corrects to empty. Emptying the buffer is exactly
 * what must not happen, because a buffer at zero has nothing to reveal until the
 * next chunk lands — so it sprinted through each chunk, stalled, then sprinted
 * through the next. It inherited the lumpiness it was built to hide.
 *
 * Targeting a lag instead means the buffer is a duration, not a leftover: a gap
 * between chunks is precisely what a second of held-back text is FOR. A little
 * over a second covers the gaps a model actually leaves without putting the
 * reveal noticeably behind the run.
 */
const LAG_MS = 1100

/**
 * How hard the speed is corrected toward that lag, per second of error.
 *
 * A spring constant. Too low and the reveal drifts away from its target and
 * takes whole sentences to come back; too high and it fights every chunk,
 * lurching once per arrival — which is the stutter again, at a smaller
 * amplitude. Measured against a recorded stream, 1.0 was the floor of the
 * stall-free range and had the steadiest speed in it.
 */
const CORRECTION = 1.0

/**
 * How quickly the estimate of the arrival rate moves, as a time constant in
 * seconds.
 *
 * The base speed is "however fast text is actually arriving", averaged since the
 * block started. Smoothed over a couple of seconds so that one large chunk
 * raises it a little rather than all at once — an unsmoothed estimate makes the
 * reveal jump on arrival, which is the artefact being removed.
 */
const RATE_TAU = 2.0

/**
 * How long a silence means the stream has stopped rather than paused.
 *
 * Below this the reveal keeps holding its buffer, because more is probably
 * coming. Above it the buffer stops being insurance and becomes plain delay, so
 * the reveal switches to settling: target zero, and close.
 */
const QUIET_MS = 450

/**
 * The slowest the settle may crawl, in characters per second.
 *
 * Without a floor the correction term alone approaches the end asymptotically —
 * the last few characters take longer than the whole rest of the message. The
 * settle is over in about a second with this, which is what makes the finished
 * block land on a reveal that has already caught up.
 */
const SETTLE_MIN_CHARS_PER_SECOND = 180

/** A ceiling, so a pathological burst cannot produce a frame that reveals everything. */
const MAX_CHARS_PER_SECOND = 1200

/**
 * How far behind it may fall regardless, in characters.
 *
 * A backstop for the case the rate estimate cannot cover: thousands of
 * characters arriving at once, where holding a lag would mean minutes of
 * animation for a reply that is already complete.
 */
const MAX_BEHIND = 600

/**
 * Reveal `text` progressively while `on`, or return it whole.
 *
 * Returns a prefix of `text`, growing toward it. Three properties this has to
 * keep, each one a bug that was easy to write instead:
 *
 * - **It never runs backwards.** Not by comparing lengths, but by checking that
 *   what is on screen is still a prefix of the source. The daemon clears the
 *   draft the moment the finished `assistant.text` event lands and the NEXT
 *   block starts filling the same string — length alone cannot tell a longer
 *   continuation from a different, shorter message, and a stale prefix of the
 *   old one would be text the run never wrote.
 * - **Switching it off is instant.** The whole point is to compare, so the
 *   toggle cannot leave the animation to finish first.
 * - **It costs nothing when idle.** The loop stops once the reveal has caught up
 *   and the stream has gone quiet, and only restarts when more text arrives — a
 *   transcript sitting finished must not hold a frame callback open for the life
 *   of the page.
 */
export function useTyped(text: string, on: boolean): string {
  const [shown, setShown] = useState(text)
  /**
   * The reveal's own position, as a float.
   *
   * Kept beside the state rather than derived from it because a frame at 60Hz
   * advances a fraction of a character at low speeds, and rounding that into
   * state every frame would round it away — the reveal would sit still forever
   * a few characters from the end.
   */
  const at = useRef(text.length)
  const frame = useRef(0)
  /**
   * The smoothed arrival rate, and the clock it is measured against.
   *
   * Refs rather than state: they are read and written inside the frame loop,
   * which must not re-render to remember how fast text was showing up. They
   * survive across effect re-runs on purpose — a new chunk is a continuation of
   * the same stream, and an estimate that reset on each arrival would be an
   * estimate that never had more than one frame of history.
   */
  const rate = useRef(0)
  const startedAt = useRef(0)
  const lastArrival = useRef(0)

  useEffect(() => {
    if (!on) {
      at.current = text.length
      setShown(text)
      return
    }

    // Not `shown.length > text.length`. See the note above: what matters is
    // whether the visible text is still the beginning of the source, which is
    // false both when the draft is cleared and when a new block reuses it.
    if (!text.startsWith(shown)) {
      at.current = text.length
      rate.current = 0
      startedAt.current = 0
      setShown(text)
      return
    }

    const now = performance.now()
    // A fresh block: start the clock, and start the reveal from nothing so the
    // first words are typed rather than appearing whole.
    if (startedAt.current === 0 && text.length > 0) {
      startedAt.current = now
      lastArrival.current = now
    } else if (text.length > shown.length) {
      // Text grew, so this effect run IS an arrival. Recorded here rather than
      // in the loop because the loop cannot see the difference between a frame
      // where a chunk landed and one where it did not.
      lastArrival.current = now
    }
    if (at.current >= text.length && now - lastArrival.current > QUIET_MS) return

    let last = now
    const step = (frameNow: number) => {
      frame.current = 0
      // Clamped: a tab restored from the background delivers one frame with a
      // gap of minutes behind it, and an unclamped delta would reveal the whole
      // message in a single jump — which is the animation not happening at all
      // on precisely the reply you left it running for.
      const dt = Math.min(0.1, (frameNow - last) / 1000)
      last = frameNow

      const elapsed = Math.max(0.001, (frameNow - startedAt.current) / 1000)
      // The long-run truth: how fast this block has actually been arriving.
      const arriving = text.length / elapsed
      // Exponential smoothing written against dt rather than per frame, so the
      // estimate settles at the same speed on a 144Hz screen as on a 60Hz one.
      rate.current += (arriving - rate.current) * (1 - Math.exp(-dt / RATE_TAU))

      const behind = text.length - at.current
      const settling = frameNow - lastArrival.current > QUIET_MS
      // While text is flowing, hold a lag: run at the arrival rate, corrected
      // for how far the buffer is from the depth we want. Once it has stopped,
      // the target is zero and the correction alone drives it home — which
      // accelerates as it closes rather than trailing off.
      const want = settling ? 0 : rate.current * (LAG_MS / 1000)
      let speed = (settling ? 0 : rate.current) + (behind - want) * CORRECTION
      if (settling) speed = Math.max(speed, SETTLE_MIN_CHARS_PER_SECOND)
      speed = Math.max(0, Math.min(MAX_CHARS_PER_SECOND, speed))

      at.current = Math.min(text.length, at.current + speed * dt)
      // Only ever pulls the reveal FORWARD, and computed from the position just
      // advanced to rather than the stale one, which could step it backwards.
      at.current = Math.max(at.current, text.length - MAX_BEHIND)

      setShown(text.slice(0, Math.floor(at.current)))
      // Kept alive through the quiet period as well as while there is a backlog:
      // stopping the moment it catches up would mean nothing was running to
      // notice the stream had gone quiet, and the settle would never start.
      if (at.current < text.length) frame.current = requestAnimationFrame(step)
    }
    frame.current = requestAnimationFrame(step)

    return () => {
      if (frame.current) cancelAnimationFrame(frame.current)
      frame.current = 0
    }
    // `shown` is read above but deliberately not a dependency. It changes on
    // every frame, and listing it would tear the loop down and rebuild it each
    // time — resetting `last`, and turning a smooth reveal into one step per
    // re-render. The effect re-runs when new text arrives, which is the only
    // time the prefix check has anything new to decide.
  }, [text, on])

  return shown
}
