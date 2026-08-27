import { useCallback, useEffect, useRef, useState } from "react"
import type {
  GitCommit,
  GitDirty,
  GitFileChange,
  GitFileState,
  GitGraphRow,
  GitRef,
} from "@aide/protocol"
import { api, type GitCommitDetail, type GitSummary, type GitWorkingTree } from "../api.js"
import { Diff } from "../Diff.js"
import { GraphCell, ROW_H, WorkingTreeCell, graphWidth } from "../GitGraph.js"
import { Button, Empty } from "../ui.js"

/**
 * The project's own repository: what is committed, and what is not yet.
 *
 * The task panes answer "what did the agent do"; this answers "what does the
 * repo look like". They are different questions — a project accumulates commits
 * from hands other than aide's, and half-finished edits sitting in the working
 * tree are the thing most likely to be forgotten and least likely to be
 * anywhere else in this UI.
 *
 * Strictly a reader. There is no stage, no commit, no discard, and that is not
 * an oversight: aide's two gates are commit and land, both of which belong to a
 * task and both of which already exist in the run pane. A second way to commit,
 * reachable from a page with no diff review attached to it, would be the exact
 * shortcut the two-gate rule exists to prevent.
 */

/** How often the list refreshes. Slower than the task poll — history is not live. */
const POLL_MS = 4000

const PAGE = 50

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

/**
 * What is uncommitted, in one line.
 *
 * Staged and unstaged are counted separately rather than added together,
 * because on a repo aide is working in they mean different things: unstaged is
 * usually yours, staged is usually mid-something.
 */
function describeDirt(d: GitDirty): string {
  const parts: string[] = []
  if (d.conflicted) parts.push(`${d.conflicted} conflicted`)
  if (d.staged) parts.push(`${d.staged} staged`)
  if (d.unstaged) parts.push(`${d.unstaged} changed`)
  if (d.untracked) parts.push(`${d.untracked} new`)
  return parts.length ? parts.join(" · ") : "nothing uncommitted"
}

/**
 * A branch, remote or tag, as a pill.
 *
 * The checked-out branch used to be filtered out as noise — "where you already
 * are". With a graph it is the opposite: a line with nothing at the end of it is
 * a line you cannot name, and which of them you are standing on is the first
 * thing anyone looks for.
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
      className={`max-w-[9rem] shrink-0 truncate rounded-sm border px-1 text-[10px] leading-[15px] ${tone}`}
    >
      {r.kind === "tag" ? `⌂ ${r.name}` : r.name}
    </span>
  )
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export function GitList({
  projectId,
  selected,
  onSelect,
}: {
  projectId: string | null
  /** null is the working tree, which is always the first row. */
  selected: string | null
  onSelect: (sha: string | null) => void
}) {
  const [summary, setSummary] = useState<GitSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [limit, setLimit] = useState(PAGE)

  // Reset the page size when the project changes. Without this, opening a small
  // repo after scrolling deep into a large one asks for 500 commits it does not
  // have — harmless, but it also keeps the deep page size for every project you
  // visit afterwards.
  useEffect(() => setLimit(PAGE), [projectId])

  useEffect(() => {
    if (!projectId) {
      setSummary(null)
      return
    }
    let live = true
    const load = async () => {
      try {
        const next = await api.git(projectId, limit)
        if (!live) return
        setSummary(next)
        setError(null)
      } catch (err) {
        if (!live) return
        setError(err instanceof Error ? err.message : String(err))
      }
    }
    void load()
    const timer = setInterval(() => void load(), POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [projectId, limit])

  if (!projectId) return <Empty>Select a project.</Empty>
  // A failed poll only takes over the pane when there is nothing behind it.
  // This refreshes every few seconds against a repo an agent may be writing
  // into, so one hiccup blanking the history you were reading would be a far
  // more common sight than an actual outage.
  if (!summary) return <Empty>{error ?? "Reading the repository…"}</Empty>

  const { overview, dirty, log } = summary
  // Which row the working tree is standing on. Matched on the abbreviation git
  // itself printed for both, so there is no guess about how many characters
  // "short" means in this repo.
  const headIndex = overview.head ? log.commits.findIndex((c) => c.short === overview.head) : -1
  const headRow = headIndex === -1 ? null : log.graph[headIndex]
  const rows = new Map(log.graph.map((r) => [r.sha, r]))

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {error && (
        <div className="shrink-0 border-b border-line px-3 py-1 font-sans text-[11px] text-err">
          {error}
        </div>
      )}
      <div className="shrink-0 border-b border-line px-3 py-2 font-sans text-[11px]">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-fg" title={overview.root}>
            {overview.branch ?? `detached at ${overview.head ?? "nothing"}`}
          </span>
          {overview.head && <span className="shrink-0 text-fg-dim">{overview.head}</span>}
        </div>
        <div className="mt-0.5 flex items-baseline gap-2 text-fg-dim">
          {overview.upstream ? (
            <>
              <span className="truncate">{overview.upstream}</span>
              {overview.ahead > 0 && <span className="text-diff-add-fg">↑{overview.ahead}</span>}
              {overview.behind > 0 && <span className="text-warn">↓{overview.behind}</span>}
              {overview.ahead === 0 && overview.behind === 0 && <span>in step</span>}
            </>
          ) : (
            <span>no upstream</span>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto py-1">
        <WorkingTreeRow
          dirty={dirty}
          lanes={log.lanes}
          lane={headRow?.lane ?? 0}
          // Only when the row directly below really is HEAD. `--branches` can put
          // another branch's tip at the top of the page, and a line drawn from
          // the working tree to a commit it is not sitting on is a lie the reader
          // has no way to catch.
          connected={headIndex === 0}
          selected={selected === null}
          onSelect={() => onSelect(null)}
        />

        {overview.unborn ? (
          <Empty>No commits yet.</Empty>
        ) : (
          log.commits.map((c, i) => (
            <CommitRow
              key={c.sha}
              commit={c}
              // Looked up by sha rather than taken from graph[i]. The daemon
              // sends them in the same order and the smoke test says so, but a
              // commit is not allowed to vanish from a history view because a
              // pairing was off by one — this way the worst case is a row with
              // no line beside it.
              row={rows.get(c.sha)}
              lanes={log.lanes}
              head={i === headIndex}
              selected={c.sha === selected}
              onSelect={() => onSelect(c.sha)}
            />
          ))
        )}

        {log.more && (
          <div className="py-2 pr-3" style={{ paddingLeft: graphWidth(log.lanes) + 16 }}>
            <Button onClick={() => setLimit((n) => n + PAGE)}>older</Button>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * The working tree, drawn as the node it is: one step above HEAD, and not a
 * commit yet.
 */
function WorkingTreeRow({
  dirty,
  lanes,
  lane,
  connected,
  selected,
  onSelect,
}: {
  dirty: GitDirty
  lanes: number
  lane: number
  connected: boolean
  selected: boolean
  onSelect: () => void
}) {
  const count = dirty.staged + dirty.unstaged + dirty.untracked + dirty.conflicted
  return (
    <button
      type="button"
      onClick={onSelect}
      style={{ height: ROW_H }}
      className={`flex w-full items-stretch gap-2 pr-3 pl-2 text-left font-sans ${
        selected ? "bg-active text-white" : "text-fg-muted hover:bg-hover"
      }`}
    >
      <WorkingTreeCell lanes={lanes} lane={lane} dirty={count > 0} connected={connected} />
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px]">working tree</span>
          {dirty.conflicted > 0 && <span className="shrink-0 text-[10px] text-err">!</span>}
        </div>
        <span
          className={`truncate text-[10px] ${
            selected ? "text-white/70" : count > 0 ? "text-warn" : "text-fg-dim"
          }`}
        >
          {describeDirt(dirty)}
        </span>
      </div>
    </button>
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
 */
function CommitRow({
  commit,
  row,
  lanes,
  head,
  selected,
  onSelect,
}: {
  commit: GitCommit
  /** Missing only if the daemon and the browser disagree about the page. */
  row: GitGraphRow | undefined
  lanes: number
  head: boolean
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      title={commit.subject}
      style={{ height: ROW_H }}
      className={`flex w-full items-stretch gap-2 pr-3 pl-2 text-left font-sans ${
        selected ? "bg-active text-white" : "text-fg-muted hover:bg-hover"
      }`}
    >
      {row ? (
        <GraphCell row={row} lanes={lanes} head={head} />
      ) : (
        <div className="shrink-0" style={{ width: graphWidth(lanes) }} />
      )}
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
        {/* Subject first, badges after, the way VS Code lays out the same row:
            the badges are `shrink-0`, so a long subject truncates and the name
            of the branch — the thing you are scanning for — never does. */}
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[13px]">{commit.subject}</span>
          {commit.refs.map((r) => (
            <RefBadge key={`${r.kind}:${r.name}`} gitRef={r} />
          ))}
        </div>
        <div className="flex items-baseline gap-2 text-[10px]">
          <span className={selected ? "text-white/70" : "text-fg-dim"}>{commit.short}</span>
          {commit.tasks.map((t) => (
            <span
              key={t}
              className={selected ? "text-white/70" : "text-diff-add-fg"}
              title="Aide-Task trailer"
            >
              task {t}
            </span>
          ))}
          <span className={`min-w-0 truncate ${selected ? "text-white/70" : "text-fg-dim"}`}>
            {commit.author}
          </span>
          <span className={`ml-auto shrink-0 ${selected ? "text-white/70" : "text-fg-dim"}`}>
            {ago(commit.date)}
          </span>
        </div>
      </div>
    </button>
  )
}

// ---------------------------------------------------------------------------
// The detail
// ---------------------------------------------------------------------------

function FileRow({ file }: { file: GitFileChange }) {
  // Both halves are shown when they disagree, because "staged as added, changed
  // again since" is a real and confusing state, and one label has to pick a
  // side and hide the other.
  const states = [file.staged, file.unstaged].filter(
    (s, i, all): s is GitFileState => s !== null && all.indexOf(s) === i,
  )
  return (
    <div className="flex items-baseline gap-2 py-0.5 font-sans text-[11px]">
      <span className="w-28 shrink-0 text-right">
        {states.map((s) => (
          <span key={s} className={`${STATE_STYLE[s].text} ml-1.5`}>
            {STATE_STYLE[s].label}
          </span>
        ))}
      </span>
      <span className="min-w-0 flex-1 truncate text-fg-muted" title={file.path}>
        {file.from && <span className="text-fg-dim">{file.from} → </span>}
        {file.path}
      </span>
      <span className="shrink-0 font-mono text-[10px] text-fg-dim">{file.code.trim() || "··"}</span>
    </div>
  )
}

export function GitPane({ projectId, sha }: { projectId: string | null; sha: string | null }) {
  const [tree, setTree] = useState<GitWorkingTree | null>(null)
  const [detail, setDetail] = useState<GitCommitDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)

  const fail = useCallback((err: unknown) => {
    setError(err instanceof Error ? err.message : String(err))
  }, [])

  // A commit is immutable, so it is fetched once and never polled. The working
  // tree is the opposite — an agent may be writing into it right now — so it
  // refreshes on the same beat as the list.
  useEffect(() => {
    if (!projectId || sha === null) {
      setDetail(null)
      return
    }
    let live = true
    setDetail(null)
    setError(null)
    void api
      .gitCommit(projectId, sha)
      .then((d) => live && setDetail(d))
      .catch((err) => live && fail(err))
    return () => {
      live = false
    }
  }, [projectId, sha, fail])

  useEffect(() => {
    if (!projectId || sha !== null) {
      setTree(null)
      return
    }
    let live = true
    setError(null)
    const load = () =>
      api
        .gitWorking(projectId)
        .then((t) => {
          if (!live) return
          setTree(t)
          setError(null)
        })
        .catch((err) => live && fail(err))
    void load()
    const timer = setInterval(() => void load(), POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [projectId, sha, fail])

  // A diff is read top-down. Landing halfway through the previous one after
  // clicking a different commit reads as the page failing to change.
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 })
  }, [sha])

  if (!projectId) return <Empty>Select a project.</Empty>

  return (
    <div ref={scroller} className="flex-1 overflow-auto">
      {/* Same rule as the list: a failed refresh is reported above whatever is
          already on screen rather than replacing it. */}
      {error && (
        <div className="border-b border-line px-3 py-1 font-sans text-[11px] text-err">{error}</div>
      )}
      {sha === null ? (
        tree === null ? (
          <Empty>{error ? "" : "Reading the working tree…"}</Empty>
        ) : (
          <WorkingTreeView tree={tree} />
        )
      ) : detail === null ? (
        <Empty>{error ? "" : "Reading the commit…"}</Empty>
      ) : (
        <CommitView detail={detail} />
      )}
    </div>
  )
}

function WorkingTreeView({ tree }: { tree: GitWorkingTree }) {
  if (tree.files.length === 0) {
    return (
      <Empty>
        Nothing uncommitted. The working tree matches{" "}
        {tree.overview.branch ?? tree.overview.head ?? "HEAD"}.
      </Empty>
    )
  }
  return (
    <div className="px-3 py-2">
      <div className="border-b border-line pb-2">
        {tree.files.map((f) => (
          <FileRow key={`${f.code} ${f.path}`} file={f} />
        ))}
      </div>

      {tree.omitted.length > 0 && (
        <div className="border-b border-line py-2 font-sans text-[11px] text-fg-dim">
          {/* Said out loud rather than dropped: a diff that quietly omits a file
              reads as "nothing changed there". */}
          Not shown below —{" "}
          {tree.omitted.map((o) => `${o.path} (${o.why})`).join(", ")}
        </div>
      )}

      <div className="pt-2 font-mono text-xs leading-relaxed">
        {tree.diff.trim() ? (
          <Diff patch={tree.diff} />
        ) : (
          <p className="py-4 text-center font-sans text-xs text-fg-dim">
            No textual changes — the files above differ only in mode, or are binary.
          </p>
        )}
      </div>
    </div>
  )
}

function CommitView({ detail }: { detail: GitCommitDetail }) {
  const { commit } = detail
  return (
    <div className="px-3 py-2">
      <div className="border-b border-line pb-3 font-sans">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-syn-var" title={commit.sha}>
            {commit.short}
          </span>
          {commit.refs.map((r) => (
            <RefBadge key={`${r.kind}:${r.name}`} gitRef={r} />
          ))}
          {commit.tasks.map((t) => (
            <span key={t} className="text-[10px] text-diff-add-fg" title="Aide-Task trailer">
              task {t}
            </span>
          ))}
        </div>
        <div className="mt-1 text-[11px] text-fg-dim">
          {commit.author} &lt;{commit.authorEmail}&gt; · {new Date(commit.date).toLocaleString()} (
          {ago(commit.date)})
        </div>
        {commit.parents.length > 1 && (
          <div className="mt-1 text-[11px] text-fg-dim">
            {/* The diff below is against the first parent, which for a merge is
                "what this brought in" rather than "what conflicts were resolved".
                Saying so beats leaving the reader to work out which one git
                chose. */}
            Merge of {commit.parents.length} parents — shown against{" "}
            <span className="font-mono">{commit.parents[0]?.slice(0, 7)}</span>
          </div>
        )}
        <pre className="mt-2 whitespace-pre-wrap font-mono text-xs text-fg">{detail.message}</pre>
      </div>

      {detail.stat && (
        <pre className="border-b border-line py-2 font-mono text-[11px] whitespace-pre text-fg-muted">
          {detail.stat}
        </pre>
      )}

      <div className="pt-2 font-mono text-xs leading-relaxed">
        {detail.diff.trim() ? (
          <Diff patch={detail.diff} />
        ) : (
          <p className="py-4 text-center font-sans text-xs text-fg-dim">
            This commit changed no files.
          </p>
        )}
      </div>
    </div>
  )
}
