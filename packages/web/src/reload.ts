import { alarmRinging } from "./chime.js"
import { flushDrafts } from "./drafts.js"

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
 *
 * And "looking" is not "free", which is the third question and the one that
 * cost a real message. What you do when the alarm fetches you is read the reply
 * and start typing the next thing — so the moment this page is most certain
 * somebody is here is the moment they are least able to be interrupted. See
 * `take`.
 */

/** Also in `vite-daemon.ts`, which sends it. */
const HELD = "aide:reload-held"

/** How often to reconsider taking it. */
const CHECK_MS = 1000

/**
 * How long after a keystroke this page still counts as one somebody is writing
 * in.
 *
 * Generous, because the cost of being wrong is wildly lopsided. Too long and
 * the page shows the code it loaded with for another half minute, which is the
 * trade this whole file already makes. Too short and a reload lands in the
 * middle of a sentence — and a paragraph you were composing when the tab blinked
 * is not something anyone can be talked into forgiving, whatever came back into
 * the box afterwards.
 */
const COMPOSING_MS = 30_000

/** How long to wait for the last keystrokes to reach disk before going anyway. */
const FLUSH_MS = 1000

/**
 * A keystroke into something you write in, not into a control you drive with
 * the arrow keys — the effort slider is an `<input>` and its keydowns are not
 * anybody composing. A deny list rather than an allow list, so a box added
 * later is mid-sentence by default: over-waiting costs a delayed reload, and
 * under-waiting costs the message.
 */
function intoABox(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement) return true
  if (target instanceof HTMLElement && target.isContentEditable) return true
  return (
    target instanceof HTMLInputElement &&
    target.type !== "range" &&
    target.type !== "checkbox" &&
    target.type !== "radio"
  )
}

export function takeHeldReloads(): void {
  // Dev only. `import.meta.hot` is undefined in a built bundle, where there is
  // no dev server holding anything back and this whole function folds away.
  if (!import.meta.hot) return

  let timer: number | undefined
  let lastTypedAt = 0

  // Listening from the start rather than from the moment a reload is held: the
  // held one very often arrives seconds after a turn finished, which is exactly
  // when the next message is being typed, and a listener attached at that point
  // has no idea it walked in on one.
  window.addEventListener(
    "keydown",
    (e) => {
      if (intoABox(e.target)) lastTypedAt = Date.now()
    },
    { passive: true, capture: true },
  )

  const take = () => {
    // Three questions, and the third is the one this used to be missing.
    //
    // Focus and a quiet alarm say a person is HERE — focus alone does not, since
    // this window can hold it behind another one on a second monitor, and the
    // alarm going quiet is the one signal that means somebody moved something.
    // Neither says the person is FREE, and those came apart in the worst
    // possible place: the alarm is silenced by any keydown, so the first
    // character of the next prompt was itself the signal that released the
    // reload, and the reload then ate the rest of the sentence.
    if (alarmRinging() || !document.hasFocus()) return
    if (Date.now() - lastTypedAt < COMPOSING_MS) return
    window.clearInterval(timer)
    // On disk before the page goes. `saveDraft` batches for 400ms and the
    // `pagehide` backstop's transaction may never commit, so without this the
    // last words typed are the ones at risk — and they are the words the reload
    // interrupted. Raced against a timeout because a write that has not landed
    // in a second is not going to, and a reload that never happens would be a
    // page permanently behind the code with nothing on screen saying so.
    void Promise.race([flushDrafts(), new Promise((r) => setTimeout(r, FLUSH_MS))]).then(() => {
      location.reload()
    })
  }

  import.meta.hot.on(HELD, () => {
    if (timer !== undefined) return
    console.info("[aide] this page is behind the code — reloading once you are back and not typing")
    // Polled rather than driven off `focus` and the alarm's own state. The
    // alarm stops inside a React commit, and a listener racing that ordering
    // would fire either a beat early or never; a second's delay on a reload you
    // are about to watch happen costs nothing.
    timer = window.setInterval(take, CHECK_MS)
    take()
  })
}
