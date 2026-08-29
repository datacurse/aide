import type { GitFileChange, GitFileState, GitPending } from "@aide/protocol"
import { Button, Empty, PaneHeader } from "../ui.js"

/**
 * What the project has left to commit, and nothing else.
 *
 * This used to sit under a `git` pane that also drew the history and the diffs.
 * The history went: reading a change belongs to the conversation that made it,
 * where there is a description and a checkpoint to measure against, so a second
 * copy beside a project-shaped page was one more place to look and no more
 * review. What could not go is this rail — see below.
 *
 * What stayed is the list and the one button that acts on it. There is still no
 * staging and no discard, and that is not an oversight: a commit here is the
 * whole of what is uncommitted, and anything narrower would be a second review
 * with no diff attached — and would leave files behind in a list whose being
 * empty is the condition for starting the next chat.
 */

/** Same palette VS Code uses in its own SCM view, so the colours are not a new language. */
const STATE_STYLE: Record<GitFileState, { text: string; label: string }> = {
  added: { text: "text-diff-add-fg", label: "added" },
  untracked: { text: "text-diff-add-fg", label: "new" },
  modified: { text: "text-warn", label: "modified" },
  deleted: { text: "text-diff-del-fg", label: "deleted" },
  renamed: { text: "text-syn-var", label: "renamed" },
  copied: { text: "text-syn-var", label: "copied" },
  "type-changed": { text: "text-warn", label: "type changed" },
  conflicted: { text: "text-err", label: "conflicted" },
  ignored: { text: "text-fg-dim", label: "ignored" },
  unknown: { text: "text-fg-dim", label: "?" },
}

/** One letter, in the state's colour — all a 16rem column can spare. */
const MARK: Record<GitFileState, string> = {
  added: "A",
  untracked: "U",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  "type-changed": "T",
  conflicted: "!",
  ignored: "I",
  unknown: "?",
}

/**
 * The uncommitted-work indicator.
 *
 * On screen at all times, beside every pane, because it is the one fact that
 * decides what you are allowed to do next: a new conversation is refused while
 * this list has anything in it. A status you have to go to a tab to read cannot
 * carry that job — you would meet the refusal before you met the reason.
 *
 * The commit button is here, next to the list of what it would take, and it
 * takes exactly this list. That sentence used to be false: it committed a
 * CONVERSATION's work, measured against that chat's checkpoint, so it could not
 * be pressed without one open. Nothing makes the files in this rail a chat's —
 * an editor, a formatter and an install all write to the same tree — and for
 * those the rail was a permanent block with a dead button beside it and a
 * terminal as the only way out.
 *
 * A chat still matters to a commit, just not to what it takes: with one open the
 * run streams into its transcript and the commit carries its id. With none, the
 * run streams into whatever the middle pane is showing and the commit is
 * attributed to nobody, which is the truth about it.
 *
 * Nothing is filtered out of the list. Every file here is one a commit can take,
 * which has to stay true: the block on starting a new conversation reads this
 * same list, so a file that could sit here uncommittable would be a block with
 * no way out of it.
 */
export function PendingRail({
  projectId,
  pending,
  error,
  commitBlocked,
  committing,
  verifyRefused,
  onCommit,
}: {
  projectId: string | null
  pending: GitPending | null
  /** A failed poll, reported above the last good answer rather than replacing it. */
  error: string | null
  /**
   * Why this work cannot be committed from here, or null when it can.
   *
   * A sentence rather than a boolean, and it goes on the disabled button's
   * title: "commit is greyed out" with no reason is the shape of a bug. The only
   * reason left is another run holding the checkout, which is a wait rather than
   * something to go and do.
   */
  commitBlocked: string | null
  committing: boolean
  /**
   * The last commit stopped because one of the project's checks failed.
   *
   * Turns the button into a second, deliberate press rather than adding a
   * checkbox beside it: the failure is written out in the conversation next to
   * this rail, so the only honest place to offer "anyway" is after you have been
   * shown what is wrong.
   */
  verifyRefused: boolean
  onCommit: () => void
}) {
  const files = pending?.files ?? []
  return (
    <aside className="flex w-64 shrink-0 flex-col border-l border-line bg-chrome">
      <PaneHeader title="uncommitted">
        {files.length > 0 && (
          <span className="rounded-sm bg-warn/15 px-1.5 py-0.5 font-sans text-[10px] text-warn">
            {files.length}
          </span>
        )}
      </PaneHeader>

      {error && (
        <div className="shrink-0 border-b border-line px-3 py-1 font-sans text-[11px] text-err">
          {error}
        </div>
      )}

      {!projectId ? (
        <Empty>Select a project.</Empty>
      ) : pending === null ? (
        <Empty>Reading the working tree…</Empty>
      ) : files.length === 0 ? (
        <Empty>
          Nothing uncommitted on {pending.branch ?? "this checkout"}. A new chat can start.
        </Empty>
      ) : (
        <>
          <div className="shrink-0 border-b border-line px-3 py-2 font-sans text-[11px] leading-relaxed text-fg-dim">
            {/* Said here rather than only at the refusal. Meeting the rule for
                the first time as an error, after typing a message, is how a
                deliberate constraint reads as a bug. */}
            <span className="text-warn">
              {files.length} file{files.length === 1 ? "" : "s"}
            </span>{" "}
            uncommitted on {pending.branch ?? "a detached checkout"}. Commit this work before
            starting another chat.
            {verifyRefused && (
              <div className="mt-2 text-warn">
                A check failed, so nothing was committed. It is written out beside this rail — read
                it, then press again to commit anyway.
              </div>
            )}
            <div className="mt-2">
              <Button
                tone={verifyRefused ? "danger" : "primary"}
                onClick={onCommit}
                disabled={committing || commitBlocked !== null}
                title={
                  commitBlocked ??
                  (verifyRefused
                    ? "Commit this work even though a check failed. The failure stays in the log."
                    : `Draft a message from these ${files.length} file${files.length === 1 ? "" : "s"} and commit all of them. Both happen in the pane beside this one, where you can watch them.`)
                }
              >
                {committing ? "committing…" : verifyRefused ? "commit anyway" : "commit"}
              </Button>
            </div>
          </div>
          <div className="flex-1 overflow-auto py-1">
            {files.map((f) => (
              <PendingRow key={`${f.code} ${f.path}`} file={f} />
            ))}
          </div>
        </>
      )}
    </aside>
  )
}

function PendingRow({ file }: { file: GitFileChange }) {
  // The working-tree half when there is one, because that is the newer edit;
  // a file staged as added and then changed again is still, to a reader, changed.
  const state = file.unstaged ?? file.staged ?? "unknown"
  const cut = file.path.lastIndexOf("/")
  const dir = cut === -1 ? "" : file.path.slice(0, cut + 1)
  const name = cut === -1 ? file.path : file.path.slice(cut + 1)
  return (
    <div
      className="flex items-baseline gap-2 px-3 py-[3px] font-sans text-[12px]"
      title={`${file.from ? `${file.from} → ` : ""}${file.path} · ${STATE_STYLE[state].label}`}
    >
      <span className="min-w-0 flex-1 truncate text-fg-muted">
        {/* Directory first and dimmed, so the eye lands on the filename — the
            column is too narrow to show both at full weight. */}
        {dir && <span className="text-fg-dim">{dir}</span>}
        {name}
      </span>
      <span className={`shrink-0 font-mono text-[10px] ${STATE_STYLE[state].text}`}>
        {MARK[state]}
      </span>
    </div>
  )
}
