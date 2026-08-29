import { useEffect, useReducer, useRef } from "react"
import { api } from "./api.js"
import { idFromKey, nameDraft, type Draft } from "./drafts.js"

/**
 * Naming a chat before it has run.
 *
 * The SDK names a session a second or two into its first turn, so every chat
 * aide has spent money on has a name and the ones you have only written down do
 * not. That is the wrong way round for a list you navigate: a chat that has run
 * is one you remember having, and a parked idea from Tuesday is the row you are
 * actually hunting for — and all it could show was the first line of whatever
 * you typed, which for a request of any length is the run-up rather than the
 * point.
 *
 * So a parked chat is named when it is parked, from its own words, by one small
 * model call. What is bought is a legible backlog; what is paid is a few hundred
 * tokens per thing you write down, on the helper model. The rules below exist to
 * make that "per thing you write down" true rather than aspirational — a namer
 * that fires on a keystroke, or retries a failure, is a loop that spends money
 * while you watch.
 */

/**
 * Short enough that the row already shows the whole request.
 *
 * A name is a summary, and there is nothing to summarize about "fix the graph
 * lanes" — the model would hand back a paraphrase of a line already on screen,
 * for the price of a call. Roughly what fits in the list's 320px column, so the
 * rule is the honest one: pay only when the row would otherwise cut something
 * off.
 */
const READS_WHOLE_CHARS = 40

/** A parked chat's name, or null when the row should show its own first line. */
export function draftName(draft: Draft): string | null {
  // Compared against the exact text, not merely present. A name written from a
  // request you have since rewritten describes work you are no longer about to
  // send, and a wrong label on a row is worse than no label — it is the failure
  // this whole feature exists to prevent, wearing the feature's clothes.
  return draft.titledFrom === draft.text ? (draft.title ?? null) : null
}

/** Whether this row is worth a call right now. */
function wantsName(draft: Draft): boolean {
  const text = draft.text.trim()
  if (!text) return false
  // Sent, and a second or two from having the SDK's own name. Nothing to buy.
  if (draft.startedRunId) return false
  if (draftName(draft) !== null) return false
  return text.length > READS_WHOLE_CHARS || text.includes("\n")
}

/**
 * Keep every parked chat in this project named, one call at a time.
 *
 * The open chat is deliberately exempt, and that exemption is what keeps this
 * from naming things nobody parked. A chat you are looking at is a chat you are
 * typing into — press "new", write three paragraphs, send — and naming that one
 * would be a model call per composing pause, for a row that is about to get the
 * SDK's name anyway. A chat becomes worth naming at the moment you leave it
 * unsent: parked from the capture box, which never opens what it makes, or
 * abandoned by clicking something else. Both are the same fact — nobody is
 * typing in it — so both are the same rule.
 *
 * It is also why there is no debounce here. "Not open" already means "not being
 * typed into", and a timer would have to be restarted whenever anything in the
 * list changed — which is on every keystroke in the chat you ARE typing in, so
 * the row waiting to be named would never reach the end of its wait.
 */
export function useAutoNames(drafts: readonly Draft[], openDraftId: string | null): void {
  /**
   * The text each row has already been sent away to be named from.
   *
   * Set before the call rather than after it, so a failure is remembered as an
   * attempt. A namer that retried would be a model call every render against a
   * request it has already shown it cannot name — and the row it is failing over
   * still reads fine, because the fallback is the first line it always showed.
   * Editing the text is what asks again, which is also the only thing that makes
   * asking again worth anything.
   */
  const attempted = useRef(new Map<string, string>())
  /** One call in flight at a time; a burst of parked ideas is a queue, not a fan-out. */
  const inFlight = useRef(false)
  /**
   * Bumped when a call settles, and in the dependencies below because of what
   * happens when one fails: nothing in the store changed, so without a dependency
   * that DID change this effect never runs again and the queue stops at the first
   * row that could not be named.
   */
  const [settlements, settled] = useReducer((n: number) => n + 1, 0)

  useEffect(() => {
    if (inFlight.current) return
    const next = drafts.find(
      (d) =>
        idFromKey(d.key) !== openDraftId &&
        wantsName(d) &&
        attempted.current.get(d.key) !== d.text,
    )
    if (!next) return

    const { key, text } = next
    attempted.current.set(key, text)
    inFlight.current = true
    void api
      .nameChat(text)
      .then(({ title }) => {
        if (title) nameDraft(key, text, title)
      })
      .catch(() => {
        // The daemon is down, or the model call failed. The row keeps its first
        // line, which is what it showed before any of this existed.
      })
      .finally(() => {
        inFlight.current = false
        settled()
      })
  }, [drafts, openDraftId, settlements])
}
