import { useEffect, useRef } from "react"

/**
 * The sound a finished turn makes.
 *
 * Synthesised rather than shipped as an audio file. Two oscillators and an
 * envelope are twenty lines of arithmetic; a .wav worth listening to is a binary
 * in the repo, and a library that plays one is a dependency — neither is a
 * trade this package makes for a notification sound.
 */

/**
 * Where the preference lives. Read here as a raw string and written through
 * `useRemembered` in the header, which stores JSON — `false` is the only value
 * either spelling produces that turns the chime off, so the two agree.
 */
export const CHIME_KEY = "aide.chime"

export function chimeEnabled(): boolean {
  try {
    return window.localStorage.getItem(CHIME_KEY) !== "false"
  } catch {
    // Private mode or storage disabled. Audible is the documented default.
    return true
  }
}

/** One context for the life of the page: browsers cap how many you may open. */
let shared: AudioContext | null = null

/** A two-note ping — the agent stopped, it is your move. */
export function chime(): void {
  if (!chimeEnabled()) return

  try {
    const ctx = (shared ??= new AudioContext())
    // Autoplay policy holds a context suspended until the page has been
    // interacted with. Sending a message is an interaction, so a turn you
    // started always rings; a run you only ever watched may not, and staying
    // silent is the only option — there is no permission to ask for.
    void ctx.resume()

    const now = ctx.currentTime
    for (const [after, hz] of [
      [0, 880],
      [0.13, 1318.5],
    ] as const) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = "sine"
      osc.frequency.value = hz
      // Ramped, not stepped: a gain that jumps to its value clicks, and the
      // click is louder than the note.
      gain.gain.setValueAtTime(0.0001, now + after)
      gain.gain.exponentialRampToValueAtTime(0.14, now + after + 0.012)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + after + 0.34)
      osc.connect(gain).connect(ctx.destination)
      osc.start(now + after)
      osc.stop(now + after + 0.35)
    }
  } catch {
    // No Web Audio, or the context refused to start. A notification that does
    // not sound is not worth taking down the pane that asked for it.
  }
}

/**
 * Ring once when a turn this page watched go from running to stopped, stops.
 *
 * Edge-triggered and keyed, both deliberately. Opening a conversation that
 * finished an hour ago replays its whole event log, terminal event included, so
 * anything that chimed on `run.finished` itself would make browsing history
 * sound like work arriving. And `key` — the run id — is what keeps clicking from
 * a running task to a finished one silent: that is a different run ending, which
 * this page never saw start.
 */
export function useDoneChime(active: boolean, key: string | null): void {
  const watching = useRef<string | null>(null)

  useEffect(() => {
    if (active) {
      watching.current = key
      return
    }
    const was = watching.current
    watching.current = null
    if (was !== null && was === key) chime()
  }, [active, key])
}
