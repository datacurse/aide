import { useEffect, useState } from "react"
import { api, type Receipt as ReceiptDoc } from "./api.js"
import { Markdown } from "./Markdown.js"
import { Button } from "./ui.js"

/**
 * What the conversation cost and where its time went, on demand.
 *
 * The daemon has derived this since the commit run landed — `receipt.ts`, 500-odd
 * lines of arithmetic over the event log, smoke-tested — and until now nothing
 * called it. The cost of that was not theoretical: this repository's own logs
 * hold three separate conversations in which the human asked an agent to read
 * the timings by hand and say where the time went, at about five dollars and a
 * quarter-hour apiece, to get a worse answer than the endpoint already returns
 * for free. A derived artifact nobody can reach is the same as one nobody wrote.
 *
 * An overlay rather than a fifth pane. The four panes are the product's whole
 * surface and a receipt does not earn one — it is read once, after the fact,
 * about a conversation that is already on screen behind it. `Confirm` in `ui.tsx`
 * established the shape for exactly this: something transient, owned by whatever
 * knows what it is about.
 *
 * Fetched on open and never polled. It reduces every run log the conversation
 * has, and it describes turns that have already ended — so re-reading it on the
 * app's 1.5s beat would burn the work to redraw an identical document.
 */
export function ReceiptOverlay({
  projectId,
  sessionId,
  onClose,
}: {
  projectId: string
  sessionId: string
  onClose: () => void
}) {
  const [doc, setDoc] = useState<ReceiptDoc | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let live = true
    setDoc(null)
    setError(null)
    api
      .receipt(projectId, sessionId)
      // `live` guards both: closing the overlay mid-request, and switching
      // conversations underneath one, which would otherwise land the previous
      // chat's receipt in the new chat's overlay.
      .then((r) => live && setDoc(r))
      .catch((err) => live && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      live = false
    }
  }, [projectId, sessionId])

  const copy = () => {
    if (!doc) return
    // The markdown, not the rendered text. This document exists to be pasted
    // back into a chat as a question about the run it describes, and a paste of
    // the DOM's textContent loses the tables that carry the numbers.
    void navigator.clipboard.writeText(doc.markdown).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      },
      () => setError("could not reach the clipboard"),
    )
  }

  return (
    // Escape and the backdrop both close, for the reason `Confirm` gives: the
    // safe answer has to be the easy one to reach.
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-8"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose()
      }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="conversation receipt"
        autoFocus
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-full w-[52rem] max-w-full flex-col rounded border border-line bg-editor shadow-lg outline-none"
      >
        <div className="flex h-9 shrink-0 items-center justify-between border-b border-line px-3">
          <h2 className="font-sans text-[11px] font-semibold tracking-wide text-fg-muted uppercase">
            receipt
          </h2>
          <div className="flex items-center gap-1.5">
            <Button onClick={copy} disabled={!doc} title="Copy the markdown, to paste into a chat">
              {copied ? "copied" : "copy"}
            </Button>
            <Button onClick={onClose}>close</Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {error ? (
            <p className="font-sans text-[11px] text-err">{error}</p>
          ) : doc === null ? (
            <p className="font-sans text-xs text-fg-dim">Reading the log…</p>
          ) : doc.runs === 0 ? (
            // Not an error, and worth saying in words rather than showing an
            // empty document: a conversation held in the CLI or the VS Code
            // extension appears in the same list and has no event log here.
            <p className="font-sans text-xs leading-relaxed text-fg-dim">
              aide has no run log for this conversation, so there is nothing to bill. Chats held in
              the CLI or the VS Code extension show up in this list, and only the turns aide itself
              ran are recorded.
            </p>
          ) : (
            <Markdown text={doc.markdown} />
          )}
        </div>
      </div>
    </div>
  )
}
