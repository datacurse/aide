import { useEffect, useRef, useState } from "react"

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

/**
 * The shared context, started if the browser will let it start.
 *
 * Rebuilt when it is `closed`, which is not a state this page ever asks for: a
 * context outlives the machine sleeping and its output device going away, and
 * what comes back is a context that reports itself fine and plays nothing. An
 * aide tab left open across a lunch break went silent for the rest of the day,
 * which is the worst failure available to the one thing whose job is to fetch
 * you.
 */
function audio(): AudioContext | null {
  try {
    if (shared?.state === "closed") shared = null
    const ctx = (shared ??= new AudioContext())
    // Suspended means the browser is waiting for somebody to touch this
    // document. Ask anyway — the ask is what starts it once they have.
    if (ctx.state === "suspended") void ctx.resume()
    return ctx
  } catch {
    // No Web Audio. A notification that does not sound is not worth taking down
    // the pane that asked for it.
    return null
  }
}

/**
 * Start the audio on the first thing anybody does to the page.
 *
 * Calling `resume()` at ring time is not enough on its own: `currentTime` is
 * frozen while a context is suspended, so the notes below get scheduled against
 * a clock that is not moving and land in the past the moment it starts — which
 * arrives as a click rather than as a chime. Arming on the first gesture means
 * the context has been running for minutes by the time anything wants it.
 */
function arm(): void {
  audio()
  window.removeEventListener("pointerdown", arm)
  window.removeEventListener("keydown", arm)
}
window.addEventListener("pointerdown", arm, { passive: true })
window.addEventListener("keydown", arm, { passive: true })

/** A two-note ping — the agent stopped, it is your move. */
export function chime(): void {
  if (!chimeEnabled()) return

  const ctx = audio()
  // Anything but `running` is the browser holding this document silent because
  // nobody has touched it since it loaded, and there is no permission to ask
  // for. That is not the rare case it reads as: an agent editing packages/web
  // hands Vite an update Fast Refresh cannot swap in, the page reloads under
  // the turn, the pane adopts the run again — and the finish rings into a
  // document with no gesture behind it. `useDoneChime` has the title for that.
  if (!ctx || ctx.state !== "running") return

  try {
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
    // A context that died between the check above and the note below. Nothing
    // to do about it here, and a notification that does not sound is not worth
    // taking down the pane that asked for it — the next ring rebuilds it.
  }
}

/** How long the alarm waits between rings. */
const ALARM_MS = 2000

/**
 * How far the pointer has to travel, in CSS pixels, before the alarm believes
 * you are back. One mousemove is not evidence of anybody: a desk bump, a
 * scrollbar under a still cursor, a window animation sliding the page — each
 * produces one. An alarm you can silence by accident is one you stop trusting
 * to fetch you, which is the only job it has.
 */
const ROUSED_PX = 80

/**
 * Ring until you come back, when a turn this page watched go from running to
 * stopped, stops.
 *
 * Edge-triggered and keyed, both deliberately. Opening a conversation that
 * finished an hour ago replays its whole event log, terminal event included, so
 * anything that chimed on `run.finished` itself would make browsing history
 * sound like work arriving. And `key` — the run id — is what keeps clicking from
 * a running task to a finished one silent: that is a different run ending, which
 * this page never saw start.
 *
 * Repeating rather than once, and unbounded: a single ping is over before you
 * have finished the thought it interrupted, and a run that finishes while you
 * are three windows away then went unnoticed for an hour. The alarm keeps its
 * own promise instead — it stops when somebody is there, and not before.
 */
export function useDoneChime(active: boolean, key: string | null): void {
  const watching = useRef<string | null>(null)
  const [ringing, setRinging] = useState(false)

  useEffect(() => {
    if (active) {
      watching.current = key
      // A turn starting is the least ambiguous acknowledgement there is: you
      // are plainly here, and the thing the alarm was fetching you for is done.
      setRinging(false)
      return
    }
    const was = watching.current
    watching.current = null
    if (was !== null && was === key) setRinging(true)
  }, [active, key])

  useEffect(() => {
    if (!ringing) return
    if (!chimeEnabled()) {
      setRinging(false)
      return
    }

    // The half of the alarm that does not need permission to happen.
    //
    // A page nobody has touched cannot make a sound, and after one of the dev
    // server's full reloads that is the page every finish rings into — so the
    // alarm went off silently, and the mouse you moved on your way back to the
    // window was the thing that stopped it. The title is the channel left, and
    // it is the one you can read from the taskbar, which is where you are
    // standing when the alarm is for you.
    //
    // Steady rather than blinking: a hidden page's timers get throttled to once
    // a minute, and a title that toggles on that clock is a title that is
    // saying nothing for half of every two minutes.
    const title = document.title
    document.title = `● done · ${title}`

    chime()
    const timer = window.setInterval(() => {
      // Where turning the chime off mid-alarm lands: the header toggle writes
      // localStorage and broadcasts nothing. In practice the click has already
      // stopped the alarm through `roused` below, so this is the backstop for
      // the other tab and for a hand-edited value.
      if (!chimeEnabled()) {
        setRinging(false)
        return
      }
      chime()
      // Chrome throttles a hidden page's timers to once a minute after five
      // minutes — unless it has played audio in the last thirty seconds, which
      // ringing every two keeps true. The alarm is what stops the alarm being
      // throttled, so the first ring has to happen before the interval starts.
    }, ALARM_MS)

    // Acknowledgement is deliberately not "any mousemove". A mousemove fires
    // while this window is in the background — the cursor only has to cross the
    // page on its way somewhere else — so movement alone is no evidence anyone
    // looked. What counts is the pointer covering real ground while this window
    // holds focus, or a key or a click, neither of which happens without you.
    let travelled = 0
    let last: { x: number; y: number } | null = null
    const onMove = (e: MouseEvent) => {
      if (!document.hasFocus()) {
        // Reset rather than merely ignore, so a cursor that crosses the page
        // repeatedly on its way elsewhere never adds up to a person.
        travelled = 0
        last = null
        return
      }
      if (last) travelled += Math.hypot(e.clientX - last.x, e.clientY - last.y)
      last = { x: e.clientX, y: e.clientY }
      if (travelled >= ROUSED_PX) setRinging(false)
    }
    const roused = () => setRinging(false)

    window.addEventListener("mousemove", onMove, { passive: true })
    window.addEventListener("keydown", roused)
    window.addEventListener("pointerdown", roused)
    return () => {
      window.clearInterval(timer)
      document.title = title
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("keydown", roused)
      window.removeEventListener("pointerdown", roused)
    }
  }, [ringing])
}
