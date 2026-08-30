import { useEffect } from "react"
import type {
  GitCommit,
  GitFileChange,
  GitFileState,
  GitGraphRow,
  GitLog,
  GitOverview,
  GitPending,
  GitRef,
} from "@aide/protocol"
import { api, type GitHistory } from "../api.js"
import { GraphCell, ROW_H, graphWidth } from "../GitGraph.js"
import { ArrowDown, ArrowUp, Tag } from "../icons.js"
import { Button, Empty, PaneHeader } from "../ui.js"
import { useKeyed } from "../useKeyed.js"

/**
 * What the project has left to commit, and the history it will land on.
 *
 * The rail is two readings of one repository, stacked in the order you ask them
 * in: what is not committed yet, then what already is. It was only ever the
 * first, and the second was missing in a way that is easy to state — nothing on
 * screen said which commit was the last one, so "am I looking at a clean tree on
 * top of my work, or on top of somebody else's" had no answer without a
 * terminal.
 *
 * What is still not here is a repository BROWSER. Nothing in the history is a
 * link: no commit view, no file tree, no diff of an old change. Reading a diff
 * belongs to the conversation that produced it, where there is a description and
 * a checkpoint to measure it against — a second, project-shaped copy of the same
 * change would be one more place to look and no more review. Orientation is a
 * cheaper thing than that, and it is all this half is for.
 *
 * There is still no staging and no discard either: a commit here is the whole of
 * what is uncommitted, and anything narrower would be a second review with no
 * diff attached — and would leave files behind in a list whose being empty is
 * the condition for starting the next chat.
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

/** A short line where the whole-pane `Empty` would be, now that it shares the rail. */
function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="shrink-0 px-3 py-2 font-sans text-[11px] leading-relaxed text-fg-dim">
      {children}
    </p>
  )
}

/**
 * The uncommitted-work indicator, and the history under it.
 *
 * On screen at all times, beside every pane, because the top half is the one
 * fact that decides what you are allowed to do next: a new conversation is
 * refused while that list has anything in it. A status you have to go to a tab
 * to read cannot carry that job — you would meet the refusal before you met the
 * reason.
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
   * The last commit stopped because one of the project's checks failed, and the
   * one automatic attempt at fixing it did not clear it either.
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
      ) : (
        <>
          {pending === null ? (
            <Note>Reading the working tree…</Note>
          ) : files.length === 0 ? (
            <Note>
              Nothing uncommitted on {pending.branch ?? "this checkout"}. A new chat can start.
            </Note>
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
                    A check failed, so nothing was committed. What ran — and whatever aide tried
                    about it — is beside this rail. Read that, then press again to commit anyway.
                  </div>
                )}
                <div className="mt-2">
                  <Button
                    tone={verifyRefused ? "danger" : "primary"}
                    onClick={onCommit}
                    // Locked by the run that has the checkout; disabled by our
                    // own commit already being in flight. Only the first has
                    // something else holding it, and only the first is worth a
                    // padlock — the second says "committing…" on its own face.
                    locked={commitBlocked}
                    disabled={committing}
                    title={
                      verifyRefused
                        ? "Commit this work even though a check failed. The failure stays in the log."
                        : `Draft a message from these ${files.length} file${files.length === 1 ? "" : "s"} and commit all of them. Both happen in the pane beside this one, where you can watch them.`
                    }
                  >
                    {committing ? "committing…" : verifyRefused ? "commit anyway" : "commit"}
                  </Button>
                </div>
              </div>
              {/* Sized to its contents and capped, rather than given the top half
                  outright: a run that touched sixty files must not push the
                  history off the bottom of the rail, and two uncommitted files
                  must not hold half a column of nothing open to prove it. */}
              <div className="max-h-[45%] shrink-0 overflow-auto py-1">
                {files.map((f) => (
                  <PendingRow key={`${f.code} ${f.path}`} file={f} />
                ))}
              </div>
            </>
          )}

          <History projectId={projectId} />
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

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/**
 * Its own beat, and a slow one. History moves when somebody commits, which is a
 * few times an hour; the list above it moves whenever an agent saves a file. One
 * poll for both would mean a `git log` and four `rev-parse`s every 1.5 seconds
 * to re-read an answer that had not changed.
 *
 * Slow, but still a poll rather than a refresh triggered by aide's own commit
 * button. Commits also arrive from the terminal the human has open next to this,
 * and a history that only updated when aide was the one committing would be
 * wrong exactly when they had gone looking for it.
 */
const POLL_MS = 4000

/**
 * How much history the rail asks for, and how much more each press adds.
 *
 * Thirty is what "where am I" costs: several days of a project moving, and the
 * question this half exists to answer. What it is not is a claim that the
 * thirty-first commit is none of your business — the list said so itself, with
 * a line at the bottom admitting it stopped, and the only way past that line was
 * a terminal. So the line became the control: the page grows by another thirty
 * per press, on the reasoning that somebody who has scrolled to the end of one
 * page wants the next one, not all five hundred.
 *
 * Still a page and not an infinite scroll. Each press is a deliberate ask for
 * more work from a `git log` that runs every four seconds from then on, and the
 * poll costs what the current page costs — a rail that quietly grew itself while
 * you scrolled would raise that bill without anybody choosing to.
 */
const PAGE = 30

/**
 * Where growing stops.
 *
 * The daemon clamps at 500 of its own accord, so past this the button would
 * still be there, still be pressable, and buy nothing — a control that no longer
 * does what it says. Same number on both sides deliberately: this is the point
 * where the rail admits the rest is the terminal's job.
 */
const MAX_PAGE = 500

function ago(iso: string): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ""
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  if (s < 2_592_000) return `${Math.floor(s / 86_400)}d ago`
  return new Date(t).toLocaleDateString()
}

/**
 * What the project has already committed, newest first.
 *
 * Polls on its own, unlike the half above it, which App owns because two things
 * read it. Exactly one thing reads this, and it is this — so the fetch lives
 * where it is used.
 */
function History({ projectId }: { projectId: string }) {
  // Kept per project rather than cleared on the way out — see `useKeyed`. The
  // rule that another repository's commits may never appear under this
  // project's name is what the clearing was for, and filing each page under the
  // project it was read from keeps it without emptying the rail on every switch.
  const [history, rememberHistory] = useKeyed<GitHistory>(projectId)
  const [error, rememberError] = useKeyed<string>(projectId)
  // How far back this project's history is currently opened. Keyed like the
  // page itself, so coming back to a project you had expanded finds it still
  // expanded — and, more to the point, so a project you had NOT expanded is
  // never handed the previous one's depth, which would show as the rail
  // silently costing five hundred commits a poll in a repo you just opened.
  const [depth, rememberDepth] = useKeyed<number>(projectId)
  const page = depth ?? PAGE

  useEffect(() => {
    let live = true
    const load = async () => {
      try {
        const next = await api.gitHistory(projectId, page)
        if (!live) return
        rememberHistory(projectId, next)
        rememberError(projectId, null)
      } catch (err) {
        if (!live) return
        rememberError(projectId, err instanceof Error ? err.message : String(err))
      }
    }
    // Runs on `page` as well as on the project, which is what makes the button
    // below a single `rememberDepth` and nothing else: growing the page IS the
    // fetch for the longer one, immediately, rather than a press that appears
    // to do nothing until the next poll comes round up to four seconds later.
    void load()
    const timer = setInterval(() => void load(), POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [projectId, page, rememberHistory, rememberError])

  return (
    <section className="flex min-h-0 flex-1 flex-col border-t border-line">
      <div className="flex h-7 shrink-0 items-center gap-2 px-3">
        <h3 className="shrink-0 font-sans text-[11px] font-semibold tracking-wide text-fg-muted uppercase">
          history
        </h3>
        {history && <Upstream overview={history.overview} />}
      </div>

      {/* A failed poll never blanks the page behind it: this refreshes against a
          repo an agent may be writing into, so one hiccup taking the history
          away would be a far commoner sight than an actual outage. */}
      {error && <div className="shrink-0 px-3 pb-1 font-sans text-[11px] text-err">{error}</div>}

      {!history ? (
        error ? null : <Note>Reading the history…</Note>
      ) : history.log.commits.length === 0 ? (
        <Note>No commits yet. The first one starts the history.</Note>
      ) : (
        <Commits
          log={history.log}
          head={history.overview.head}
          // Null at the ceiling rather than a press that re-fetches the same
          // five hundred rows: see MAX_PAGE. `Commits` takes the absence as
          // "say it stopped, offer nothing", which is what the line did before
          // any of this was pressable.
          onMore={
            page >= MAX_PAGE
              ? null
              : () => rememberDepth(projectId, Math.min(page + PAGE, MAX_PAGE))
          }
        />
      )}
    </section>
  )
}

function Commits({
  log,
  head,
  onMore,
}: {
  log: GitLog
  head: string | null
  /** Grow the page, or null when there is no more room to grow into. */
  onMore: (() => void) | null
}) {
  // Which row the working tree is standing on. Matched on the abbreviation git
  // itself printed for both, so there is no guess about how many characters
  // "short" means in this repo.
  const headIndex = head ? log.commits.findIndex((c) => c.short === head) : -1
  const rows = new Map<string, GitGraphRow>(log.graph.map((r) => [r.sha, r]))

  return (
    <div className="min-h-0 flex-1 overflow-auto pb-1">
      {log.commits.map((c, i) => (
        <CommitRow
          key={c.sha}
          commit={c}
          // Looked up by sha rather than taken from graph[i]. The daemon sends
          // them in the same order and the smoke test says so, but a commit is
          // not allowed to vanish from a history view because a pairing was off
          // by one — this way the worst case is a row with no line beside it.
          row={rows.get(c.sha)}
          lanes={log.lanes}
          number={log.numbers[c.sha]}
          head={i === headIndex}
        />
      ))}
      {/* Said rather than left to be inferred from a list that stops. A page
          that ends silently reads as "this is the whole repository", which on a
          project older than thirty commits is simply false.

          And pressable, because saying it was only half the job: the sentence
          admitted the list had been cut off and then left the terminal as the
          only way to see past the cut. Indented to the lane the graph's lines
          end at, so it reads as the bottom of the list rather than a control
          parked underneath it — this is where the history keeps going, and the
          press is how. */}
      {log.more &&
        (onMore ? (
          <button
            type="button"
            onClick={onMore}
            title={`Show another ${PAGE} commits. The rail re-reads this longer page every few seconds from now on.`}
            className="w-full cursor-pointer py-1 pr-3 text-left font-sans text-[10px] text-fg-dim transition-colors outline-none hover:text-fg-muted focus-visible:text-fg-muted"
            style={{ paddingLeft: graphWidth(log.lanes) + 16 }}
          >
            show {PAGE} more
          </button>
        ) : (
          /* At the ceiling. The list still stops, so it still has to say so —
             what it must not do is keep offering a press that would return the
             same rows. */
          <p
            className="py-1 pr-3 font-sans text-[10px] text-fg-dim"
            style={{ paddingLeft: graphWidth(log.lanes) + 16 }}
          >
            history continues past here
          </p>
        ))}
    </div>
  )
}

/**
 * Where the branch stands against the remote it tracks.
 *
 * The branch NAME is not repeated here — the half above already says which one
 * the uncommitted work is on, and a 16rem column cannot afford to say it twice.
 * What this adds is the part nothing else on screen knows: how far the checkout
 * has drifted from what has been pushed.
 */
function Upstream({ overview }: { overview: GitOverview }) {
  const { branch, head, upstream, ahead, behind } = overview
  const where = branch ?? `detached at ${head ?? "nothing"}`
  const title = upstream
    ? `${where}, against ${upstream}: ${ahead} ahead, ${behind} behind.\n${overview.root}`
    : `${where}, tracking nothing. Nothing here has been pushed anywhere.\n${overview.root}`
  return (
    <span className="ml-auto flex min-w-0 items-center gap-1.5 font-sans text-[11px]" title={title}>
      {ahead > 0 && (
        <span className="flex shrink-0 items-center gap-0.5 text-diff-add-fg">
          <ArrowUp className="size-3" />
          {ahead}
        </span>
      )}
      {behind > 0 && (
        <span className="flex shrink-0 items-center gap-0.5 text-warn">
          <ArrowDown className="size-3" />
          {behind}
        </span>
      )}
      <span className="min-w-0 truncate text-fg-dim">{upstream ?? "no upstream"}</span>
    </span>
  )
}

/**
 * One commit.
 *
 * Fixed height, and that is structural rather than cosmetic: the graph beside it
 * draws each line from the top edge of the row to the bottom edge, so the lines
 * only meet if every row is exactly ROW_H tall. Anything here that could grow
 * the box — a second line of refs, a subject that wraps — has to truncate
 * instead.
 *
 * A div and not a button. There is nothing to open, and that is the boundary
 * between this and the repository browser it is not: the diff for any of these
 * is in the conversation that produced it.
 */
function CommitRow({
  commit,
  row,
  lanes,
  number,
  head,
}: {
  commit: GitCommit
  /** Missing only if the daemon and the browser disagree about the page. */
  row: GitGraphRow | undefined
  lanes: number
  /**
   * How far along the branch's own line this commit is — 1 for the first one
   * ever made here. Undefined for a commit that arrived on a branch and is
   * therefore not a step along it; see `GitLog.numbers`.
   */
  number: number | undefined
  head: boolean
}) {
  const place =
    number === undefined
      ? "not a step along this branch's line, so it has no number"
      : `commit #${number} along this branch`
  return (
    <div
      title={`${commit.subject}\n\n${place} · ${commit.short} · ${commit.author} · ${new Date(commit.date).toLocaleString()}`}
      style={{ height: ROW_H }}
      className="flex w-full items-stretch gap-2 pr-3 pl-2 font-sans"
    >
      {row ? (
        <GraphCell row={row} lanes={lanes} head={head} />
      ) : (
        <div className="shrink-0" style={{ width: graphWidth(lanes) }} />
      )}
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        {/* Subject first, badges after, the way VS Code lays out the same row:
            the badges are `shrink-0`, so a long subject truncates and the name
            of the branch — the thing you are scanning for — never does. */}
        <div className="flex items-center gap-1">
          <span
            className={`min-w-0 flex-1 truncate text-[12px] leading-[15px] ${
              head ? "text-fg" : "text-fg-muted"
            }`}
          >
            {commit.subject}
          </span>
          {commit.refs.map((r) => (
            <RefBadge key={`${r.kind}:${r.name}`} gitRef={r} />
          ))}
        </div>
        <div className="flex items-baseline gap-2 text-[10px] leading-[13px] text-fg-dim">
          {/* A column of its own, fixed width and never dropped. Held open even
              when a commit has no number: letting the row close the gap would
              shunt every sha under it half a column left and turn the one list
              on screen you scan vertically into a ragged edge.

              Left-aligned, not right: right-aligning parked the digits against
              the far edge of the box, so the number started a few pixels in
              from the subject above it and the whole column read as crooked.
              The `#` is what makes a bare integer next to a sha legible as a
              position at all. */}
          <span className="min-w-[2rem] shrink-0 font-mono text-fg-muted">
            {number === undefined ? "" : `#${number}`}
          </span>
          <span className="shrink-0 font-mono">{commit.short}</span>
          <span className="ml-auto shrink-0">{ago(commit.date)}</span>
        </div>
      </div>
    </div>
  )
}

/**
 * A branch, remote or tag, as a pill.
 *
 * The checked-out branch is not filtered out as "where you already are": with a
 * graph it is the opposite, a line with nothing at the end of it is a line you
 * cannot name, and which commit you are standing on is the first thing anyone
 * looks for. A remote that has fallen behind is worth its own pill for the same
 * reason — it draws the line under which everything has been pushed.
 */
// Not called `ref`: React 19 would pass it through as an ordinary prop, but a
// component with a `ref` prop is a trap for whoever reads this next.
function RefBadge({ gitRef: r }: { gitRef: GitRef }) {
  const tone = r.head
    ? "border-accent bg-accent text-white"
    : r.kind === "tag"
      ? "border-warn/50 text-warn"
      : r.kind === "remote"
        ? "border-line-soft text-fg-dim"
        : "border-syn-var/40 text-syn-var"
  return (
    <span
      title={`${r.kind}${r.head ? ", checked out" : ""}: ${r.name}`}
      className={`max-w-[6rem] shrink-0 truncate rounded-sm border px-1 text-[10px] leading-[14px] ${tone}`}
    >
      {/* Inline, and not a flex row: `truncate` is what keeps a long branch name
          from widening the row it shares with the subject, and it only works on
          text that is still text. */}
      {r.kind === "tag" && <Tag className="mr-0.5 inline size-2.5 align-[-0.15em]" />}
      {r.name}
    </span>
  )
}
