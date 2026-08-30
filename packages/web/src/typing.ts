import { useEffect, useRef, useState } from "react"

/**
 * The reply, revealed at a readable pace rather than in the bursts it arrives in.
 *
 * The stream is not slow — it is *lumpy*. The SDK hands the daemon a chunk, the
 * daemon forwards it, and a paragraph lands in one frame; then nothing for most
 * of a second while the next one is generated. Rendered directly that reads as a
 * page stuttering, not as something being written, and the eye has nowhere to
 * rest: the line you were reading is already three paragraphs up.
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
 * end of one would be an animation lying about the state of the run. `MAX_BEHIND`
 * is what keeps the resulting jump small enough to read as a settle.
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
 * How fast the backlog drains, as a fraction of it per second.
 *
 * Proportional rather than a fixed characters-per-second, and that is the whole
 * of the feel. A fixed rate has to be picked for the worst case: set it to a
 * comfortable reading speed and a fast model outruns it within a sentence, so
 * the reveal falls further behind every second and finishes minutes after the
 * turn does. Draining a share of whatever is waiting is self-correcting — a
 * small backlog trickles, a large one sprints, and the distance behind converges
 * instead of growing.
 */
const DRAIN_PER_SECOND = 6

/**
 * The slowest it will go, in characters per second.
 *
 * The proportional rule alone stalls at the end: the last few characters are a
 * tiny share of a tiny backlog, so the tail of every message crawls. A floor
 * means the reveal always closes, and closes soon.
 */
const MIN_CHARS_PER_SECOND = 40

/**
 * How far behind it is allowed to fall, in characters.
 *
 * A cap, because a long reply generated fast can queue thousands of characters,
 * and a typewriter that is a paragraph behind at the moment the turn ends is a
 * typewriter that then snaps. Beyond this the reveal simply jumps forward: being
 * briefly abrupt where nobody is reading yet beats being late where they are.
 */
const MAX_BEHIND = 400

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
 * - **It costs nothing when idle.** The loop stops when the reveal catches up,
 *   and only restarts when more text arrives — a transcript sitting finished
 *   must not hold a frame callback open for the life of the page.
 */
export function useTyped(text: string, on: boolean): string {
  const [shown, setShown] = useState(text)
  /**
   * The reveal's own position, as a float.
   *
   * Kept beside the state rather than derived from it because a frame at 60Hz
   * advances a fraction of a character at the floor rate, and rounding that to
   * state every frame would round it away — the reveal would sit still forever
   * a few characters from the end.
   */
  const at = useRef(text.length)
  const frame = useRef(0)

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
      setShown(text)
      return
    }
    if (at.current >= text.length) return

    let last = performance.now()
    const step = (now: number) => {
      frame.current = 0
      // Clamped: a tab restored from the background delivers one frame with a
      // gap of minutes behind it, and an unclamped delta would reveal the whole
      // message in a single jump — which is the animation not happening at all
      // on precisely the reply you left it running for.
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now

      const behind = text.length - at.current
      const speed = Math.max(MIN_CHARS_PER_SECOND, behind * DRAIN_PER_SECOND)
      // The floor is applied first and the cap second, so the cap wins when
      // both apply. `Math.max` against the value just advanced to, never
      // against the one before it — the cap may only ever pull the reveal
      // FORWARD, and computing it from the stale position could step it back.
      at.current = Math.min(text.length, at.current + speed * dt)
      at.current = Math.max(at.current, text.length - MAX_BEHIND)

      setShown(text.slice(0, Math.floor(at.current)))
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
