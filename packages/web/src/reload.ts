import { alarmRinging } from "./chime.js"

/**
 * The page reload the dev server took off the browser, and when to take it.
 *
 * `vite-daemon.ts` applies nothing to this page while a chat turn is answering
 * — an agent working in this repo rewrites the modules the page is running, and
 * a module Fast Refresh cannot swap in reloads the whole browser. See the
 * `hotUpdate` hook there for why that is worth stopping.
 *
 * The other half is here, because the dev server can see that nothing is
 * running and cannot see whether anybody is looking. Those are different
 * questions at exactly the wrong moment: a turn ending is when the tab starts
 * ringing, and a reload one second later would silence the alarm that was
 * fetching you to a run that is now over.
 */

/** Also in `vite-daemon.ts`, which sends it. */
const HELD = "aide:reload-held"

/** How often to reconsider taking it. */
const CHECK_MS = 1000

export function takeHeldReloads(): void {
  // Dev only. `import.meta.hot` is undefined in a built bundle, where there is
  // no dev server holding anything back and this whole function folds away.
  if (!import.meta.hot) return

  let timer: number | undefined

  const take = () => {
    // Focus AND a quiet alarm. Focus alone is not being here — this window can
    // hold focus behind another one on a second monitor — and the alarm going
    // quiet is the one signal that means a person moved something.
    if (alarmRinging() || !document.hasFocus()) return
    window.clearInterval(timer)
    location.reload()
  }

  import.meta.hot.on(HELD, () => {
    if (timer !== undefined) return
    console.info("[aide] this page is behind the code — reloading once you are back")
    // Polled rather than driven off `focus` and the alarm's own state. The
    // alarm stops inside a React commit, and a listener racing that ordering
    // would fire either a beat early or never; a second's delay on a reload you
    // are about to watch happen costs nothing.
    timer = window.setInterval(take, CHECK_MS)
    take()
  })
}
