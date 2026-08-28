import { useState } from "react"
import { api, type DiffView, type ReviewDraft } from "../api.js"
import { Diff } from "../Diff.js"
import { Button } from "../ui.js"

/**
 * The commit gate.
 *
 * The diff shown here is measured against the checkpoint taken before the
 * conversation started, so it is the agent's work and not the agent's work plus
 * whatever you already had uncommitted. The commit stages exactly the paths in
 * it. Those two facts are the same fact, and they have to stay that way: a panel
 * that shows one change and commits another is not a review.
 *
 * There is no `land` button any more, because there is no branch to merge. The
 * second gate is the verdict below — the row closes when you say the work is
 * done, having watched it run in the dev server that serves this very tree.
 *
 * The spec update sits in the same panel as the commit message, deliberately.
 * "The app can now do X" and the diff that earns it are one claim, and reviewing
 * them apart is how a capability list ends up describing work that never landed.
 * Both are drafted rather than written: the editing IS the review.
 */
export function ReviewPanel({
  projectId,
  sessionId,
  onCommitted,
}: {
  projectId: string
  sessionId: string
  onCommitted: () => void
}) {
  const [diff, setDiff] = useState<DiffView | null>(null)
  const [draft, setDraft] = useState<ReviewDraft | null>(null)
  const [message, setMessage] = useState("")
  const [spec, setSpec] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sha, setSha] = useState<string | null>(null)

  const guard = async (label: string, fn: () => Promise<void>) => {
    setBusy(label)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const review = () =>
    void guard("reading", async () => {
      // The diff first, and the draft only if there is something to draft ABOUT.
      // Every conversation can be reviewed now, including the ones that were just
      // questions — and asking a model to write a commit message for an empty
      // diff would spend money to produce a 409 rendered as an error, over a
      // conversation that did exactly what was asked of it.
      const d = await api.chatDiff(projectId, sessionId)
      setDiff(d)
      setDraft(null)
      if (!d.diff.trim()) return

      const r = await api.draftReview(projectId, sessionId)
      setDraft(r)
      setMessage(r.message)
      setSpec(r.spec)
    })

  const commit = () =>
    void guard("committing", async () => {
      const r = await api.commitChat(projectId, sessionId, message, spec)
      setSha(r.sha)
      // Re-read: the tree matches the checkpoint again now, and leaving the old
      // patch on screen under a "committed" banner reads as though it did not
      // take. The board changed too — a commit is what a row was waiting for.
      setDiff(await api.chatDiff(projectId, sessionId))
      onCommitted()
    })

  return (
    <div className="flex min-h-0 flex-col gap-2 border-t border-line bg-chrome px-3 py-2">
      <div className="flex items-center gap-2 font-sans text-[11px]">
        <span className="text-fg-muted">review</span>
        {sha && <span className="text-diff-add-fg">committed {sha.slice(0, 7)}</span>}
        {error && <span className="min-w-0 flex-1 truncate text-err">{error}</span>}
        <div className="ml-auto flex items-center gap-1.5">
          <Button onClick={review} disabled={busy !== null}>
            {busy === "reading" ? "reading…" : draft ? "re-read" : "read the diff"}
          </Button>
          {draft && (
            <Button
              tone="primary"
              onClick={commit}
              disabled={busy !== null || !message.trim()}
              title="Commits exactly the files in the diff above, to the branch you have checked out."
            >
              {busy === "committing" ? "committing…" : "commit"}
            </Button>
          )}
        </div>
      </div>

      {diff && (
        <div className="max-h-64 min-h-0 overflow-auto rounded border border-line-soft bg-editor">
          {diff.diff.trim() ? (
            <Diff patch={diff.diff} />
          ) : (
            <p className="px-3 py-2 font-sans text-[11px] text-fg-dim">
              This conversation has not changed anything.
            </p>
          )}
        </div>
      )}

      {/* Named rather than resolved. Git cannot separate two people's edits
          inside one file, so committing one of these commits both — and the only
          honest thing to do is say which files, before the button is pressed. */}
      {draft && draft.mixed.length > 0 && (
        <p className="font-sans text-[11px] text-warn">
          You had already edited {draft.mixed.join(", ")} before this run. Committing takes your
          changes to {draft.mixed.length === 1 ? "it" : "them"} too.
        </p>
      )}

      {draft && (
        <div className="flex gap-2">
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="font-sans text-[10px] text-fg-dim">
              commit message · drafted by {draft.model}
            </span>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={6}
              className="w-full resize-none rounded border border-line-soft bg-input px-2 py-1 font-mono text-[12px] leading-relaxed outline-none focus:border-accent"
            />
          </label>
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="font-sans text-[10px] text-fg-dim">
              {draft.specChanged
                ? ".aide/spec.md · edit, or clear to leave it alone"
                : ".aide/spec.md · unchanged by this diff"}
            </span>
            <textarea
              value={spec}
              onChange={(e) => setSpec(e.target.value)}
              rows={6}
              placeholder="Empty leaves the spec exactly as it is."
              className="w-full resize-none rounded border border-line-soft bg-input px-2 py-1 font-mono text-[12px] leading-relaxed outline-none placeholder:text-fg-dim focus:border-accent"
            />
          </label>
        </div>
      )}
    </div>
  )
}
