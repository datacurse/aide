import { useMemo, useState } from "react"
import { splitHiddenColumns } from "@aide/protocol"
import { api, type ProjectView } from "../api.js"
import { Eye } from "../icons.js"
import { Button, Empty } from "../ui.js"
import { usePoll } from "../usePoll.js"
import type { AppLocation } from "../useAppLocation.js"
import { WallColumn } from "./Column.js"
import { useHiddenColumns } from "./hidden.js"

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
 *
 * ## Hiding a column
 *
 * A project you are not working on this week can be hidden, which is a view
 * setting and nothing else — see `hidden.ts` for why it is not the registry's
 * business. What matters HERE is that the count of hidden columns is always on
 * screen while any are hidden, and it is the control that brings them back.
 *
 * That is not decoration. Hiding is the one thing on this page that makes a
 * project stop being drawn, and the wall's whole claim is that it shows you
 * everything at once — so a hidden column with nothing on screen to say so turns
 * this page into a quiet liar the moment you forget you hid something. The wall
 * would report "3 projects · one chat each" while five existed, and the missing
 * two would be indistinguishable from projects that had been forgotten. So the
 * header says how many are hidden, and one press restores them all.
 */

/** The projects list, on the app's own beat — one request for every column. */
const POLL_MS = 1500

export function Wall({
  onClose,
  onOpen,
}: {
  onClose: () => void
  onOpen: (loc: Partial<AppLocation>) => void
}) {
  const [projects, setProjects] = useState<ProjectView[]>([])
  const [error, setError] = useState<string | null>(null)
  const hidden = useHiddenColumns()

  // A hidden column is not rendered at all rather than rendered and styled away:
  // `WallColumn` polls its own project, holds a run stream and subscribes to the
  // draft store, so a `display:none` version would keep every one of those costs
  // for a column nobody can see — and for a remote project each poll is an ssh
  // connection, which `useOnScreen` exists to ration. Hiding has to be at least
  // as cheap as scrolling away.
  //
  // The count comes back from the same call that does the filtering, so the
  // number in the header cannot disagree with the columns missing from the page.
  // See `splitHiddenColumns` for the two ways they drift apart when it does not.
  const { shown, hiddenCount } = useMemo(
    () => splitHiddenColumns(projects, hidden.ids),
    [projects, hidden.ids],
  )

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

  return (
    <main className="flex h-full flex-col bg-editor font-mono text-fg antialiased">
      <header className="flex h-9 shrink-0 items-center gap-3 border-b border-line bg-chrome px-3">
        <h1 className="font-sans text-[11px] font-semibold tracking-wide text-fg-muted uppercase">
          wall
        </h1>
        <span className="font-sans text-[11px] text-fg-dim">
          {shown.length} {shown.length === 1 ? "project" : "projects"} · one chat each
        </span>
        {/* Always on screen while anything is hidden, and it is the way back.
            A hidden column that the page never mentions is the wall quietly
            under-reporting what exists — see the note at the top. */}
        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={hidden.showAll}
            title={`Show ${hiddenCount === 1 ? "the hidden column" : `all ${hiddenCount} hidden columns`} again`}
            className="flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 font-sans text-[11px] text-fg-dim hover:bg-hover hover:text-fg"
          >
            <Eye className="size-3 shrink-0" />
            {hiddenCount} hidden
          </button>
        )}
        {error && <span className="font-sans text-[11px] text-err">{error}</span>}
        <div className="ml-auto">
          <Button onClick={onClose} title="Back to the panes, exactly where you left them">
            close
          </Button>
        </div>
      </header>

      {projects.length === 0 ? (
        <Empty>No projects yet. Add a git repository from the panes.</Empty>
      ) : shown.length === 0 ? (
        // Hiding everything must not look like having nothing. The message above
        // is about an empty registry and would be a plain lie here — the way out
        // is the `N hidden` control in the header, so this names it rather than
        // repeating it as a second button that could drift from the first.
        <Empty>
          Every project is hidden. Press “{hiddenCount} hidden” above to bring them back.
        </Empty>
      ) : (
        // Horizontal scroll is not only the layout — it is what bounds the
        // request rate, because a column only polls while it is on screen. See
        // `useOnScreen`.
        //
        // REGISTRY ORDER, which is the order projects were added and the order
        // the projects rail already draws. Not sorted here, and that is the
        // point: a column has to stay where you left it.
        //
        // The first version ranked by the lock — needs-you, then running, then
        // quiet — which is a fine ordering for a list you read once and a bad one
        // for a page you navigate by position. It reorders on the 1.5s poll, so
        // columns swap places with nobody touching anything, purely because a
        // turn somewhere finished. You learn the layout, reach for the third
        // column, and send a turn to whichever project has since moved into it.
        // A page you steer from cannot rearrange itself under the pointer, and
        // "the urgent one is leftmost" is not worth that.
        //
        // What is lost is real and is answered elsewhere: a project that needs
        // you is no longer first. Its column still says so — the holder dot,
        // `blocked` on the card — and the dashboard is where "where did the time
        // go across everything" is asked. Being findable beats being sorted.
        <div className="flex min-h-0 flex-1 overflow-x-auto">
          {/* Centred when the columns do not fill the window, left-aligned the
              moment they overflow it. Two projects at 24rem on a wide screen
              otherwise sit in the left third with the rest of the page empty,
              which reads as a layout that failed rather than one that fits.

              `mx-auto` on an inner row, NOT `justify-center` on the scroller.
              They look equivalent and are not: a centred flex container with
              overflow puts half the excess in front of the first column as
              NEGATIVE scroll space, which no browser will scroll to — so the
              leftmost project becomes unreachable at exactly the width where
              scrolling starts to matter. `auto` margins resolve to zero once
              the content is larger than the box, so this form is centring below
              the fold and a plain left-aligned row above it. */}
          {/* `h-full` and not just a stretched flex item: the column inside is
              `h-full`, which resolves against THIS box, and a wrapper sized by
              its content would leave every column measuring itself against a
              height it just supplied — the panes collapse to their content and
              the composer stops sitting at the bottom. */}
          <div className="mx-auto flex h-full min-h-0">
            {shown.map((p) => (
              <WallColumn
                key={p.id}
                project={p}
                onOpen={onOpen}
                onHide={() => hidden.hide(p.id)}
                // Dropped here rather than waited for on the next beat. The poll
                // would notice within 1.5s, and for that beat the column is still
                // on screen and still typeable — a send in it lands on a project
                // the daemon has already forgotten.
                onRemoved={() => setProjects((all) => all.filter((x) => x.id !== p.id))}
              />
            ))}
          </div>
        </div>
      )}
    </main>
  )
}
