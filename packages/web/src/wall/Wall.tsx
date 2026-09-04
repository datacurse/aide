import { useEffect, useMemo, useState } from "react"
import { api, type ProjectView } from "../api.js"
import { Button, Empty } from "../ui.js"
import { usePoll } from "../usePoll.js"
import type { AppLocation } from "../useAppLocation.js"
import { WallColumn } from "./Column.js"

/**
 * Every project at once, one column each, scrolled horizontally.
 *
 * ## Why this is a page and not a fifth pane
 *
 * The same argument the dashboard settled. Every pane is scoped to ONE project;
 * "what is everything doing, and what should I start next" is a question none of
 * them can answer, and it is asked when you are between pieces of work rather
 * than inside one. So it takes the whole window and hands it back, instead of
 * costing every pane a share of its width forever.
 *
 * It REPLACES the panes rather than covering them, because they poll — and a
 * remote `gitPending` is an ssh connection. Nothing is lost by unmounting them:
 * a run belongs to the daemon, and the URL keeps the project and the open chat,
 * so `close` returns you exactly where you were.
 *
 * ## What makes it different from the dashboard
 *
 * The dashboard COUNTS and does not open. This one ACTS: it is the only surface
 * in aide where you send a turn to a project without first selecting it. That is
 * the whole reason it exists — the dashboard's own reading is that the largest
 * recoverable item is dead time, aide finished with nothing queued, and every
 * project has its own lock so several can run at once. What stops that happening
 * today is purely navigational: starting work in one project means leaving the
 * turn you were watching in another.
 *
 * ## What it deliberately does not have
 *
 * No "commit all". Reviewing four diffs is four acts, and a button collapsing
 * them into one press is the brief's two-gates-into-one-button — not a
 * simplification but the removal of the review. Each column commits its own tree.
 *
 * No broadcast box. One prompt sent to every project is five turns written with
 * one project in mind, and reviewing what comes back costs more than the typing
 * saved. One send per chat.
 */

/** The projects list, on the app's own beat — one request for every column. */
const POLL_MS = 1500

/**
 * How often the ages on the cards are recomputed.
 *
 * Slower than the poll, because it only moves text like "3m" and "2h". A card's
 * live step keeps its own second-by-second clock; that is the one row on screen
 * that has to move, and it is one row rather than every card in every column.
 */
const CLOCK_MS = 30_000

export function Wall({
  onClose,
  onOpen,
}: {
  onClose: () => void
  onOpen: (loc: Partial<AppLocation>) => void
}) {
  const [projects, setProjects] = useState<ProjectView[]>([])
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  usePoll(
    async () => {
      try {
        setProjects(await api.projects())
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    POLL_MS,
    [],
  )

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS)
    return () => clearInterval(timer)
  }, [])

  /**
   * Column order: what needs you, then what is running, then what is waiting to
   * be committed, then the quiet ones.
   *
   * DERIVED rather than hand-arranged, for the reason the chat list gives for
   * dropping its own status rank: an order you maintain is one more thing to
   * maintain. This one is different from that list in the way that matters — you
   * do not type into the wall's ordering, you scan it, so putting the urgent
   * thing first costs nothing and saves the scan.
   *
   * The rank is coarse ON PURPOSE. Uncommitted files are deliberately NOT in it:
   * they are polled per column and only by the columns that are visible, so a
   * rank reading them would reorder the page as you scrolled — the columns you
   * had just looked at would sort themselves out from under you.
   */
  const ordered = useMemo(
    () =>
      [...projects].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)),
    [projects],
  )

  return (
    <main className="flex h-full flex-col bg-editor font-mono text-fg antialiased">
      <header className="flex h-9 shrink-0 items-center gap-3 border-b border-line bg-chrome px-3">
        <h1 className="font-sans text-[11px] font-semibold tracking-wide text-fg-muted uppercase">
          wall
        </h1>
        <span className="font-sans text-[11px] text-fg-dim">
          {projects.length} {projects.length === 1 ? "project" : "projects"} · one chat each
        </span>
        {error && <span className="font-sans text-[11px] text-err">{error}</span>}
        <div className="ml-auto">
          <Button onClick={onClose} title="Back to the panes, exactly where you left them">
            close
          </Button>
        </div>
      </header>

      {ordered.length === 0 ? (
        <Empty>No projects yet. Add a git repository from the panes.</Empty>
      ) : (
        // Horizontal scroll is not only the layout — it is what bounds the
        // request rate, because a column only polls while it is on screen. See
        // `useOnScreen`.
        <div className="flex min-h-0 flex-1 overflow-x-auto">
          {ordered.map((p) => (
            <WallColumn key={p.id} project={p} now={now} onOpen={onOpen} />
          ))}
        </div>
      )}
    </main>
  )
}

/**
 * How urgent a column is, lowest first.
 *
 * Read off the lock alone, which is the only fact the wall has about every
 * project without asking each one — `blocked` is a run stopped ON you, a holder
 * is a run in flight, and neither costs a request of its own.
 */
function rank(p: ProjectView): number {
  if (p.holder?.blocked) return 0
  if (p.holder) return 1
  return 2
}
