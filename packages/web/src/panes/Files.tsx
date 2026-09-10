import { useCallback, useEffect, useRef, useState } from "react"
import type { GitFileState, GitTree, GitTreeEntry } from "@aide/protocol"
import { api } from "../api.js"
import { lookOf } from "../filetypes.js"
import { Hint } from "../Hint.js"
import { CaretRight, Folder } from "../icons.js"
import { useKeyed } from "../useKeyed.js"

/**
 * The project's files, as a tree.
 *
 * The rail's lower half has two readings of the same repository and you pick
 * one: the history, which answers "where am I", and this, which answers "what is
 * here". They share the half rather than stacking because they answer the same
 * kind of question — orientation — and a rail split three ways gives each of
 * them too few rows to be worth reading.
 *
 * This is a code-reading surface, which the brief puts in scope, and it is NOT
 * the repository browser the brief rules out. The difference is the object: this
 * draws the working tree as it is RIGHT NOW, the one every run edits and the
 * commit button takes. A browser draws the tree of an old commit, next to a diff
 * of a change read outside the conversation that produced it — which is the
 * second, project-shaped copy of a review that the history half already refuses
 * to be. Nothing here opens a past anything.
 *
 * Read through git rather than off the filesystem, and that decision is what
 * keeps it cheap: `.gitignore` is honoured for free, so `node_modules` and
 * `dist` never appear and aide never has to learn to parse an ignore file. It
 * also means a project on another machine works with no code of its own — the
 * same `ls-tree` goes down the same ssh connection every other read already
 * uses.
 */

/** The same palette the uncommitted list uses, for the same reason: one file, one colour. */
const STATE_STYLE: Record<GitFileState, string> = {
  added: "text-diff-add-fg",
  untracked: "text-diff-add-fg",
  modified: "text-warn",
  deleted: "text-diff-del-fg",
  renamed: "text-syn-var",
  copied: "text-syn-var",
  "type-changed": "text-warn",
  conflicted: "text-err",
  ignored: "text-fg-dim",
  unknown: "text-fg-dim",
}

const STATE_LABEL: Record<GitFileState, string> = {
  added: "added",
  untracked: "new, not committed",
  modified: "modified",
  deleted: "deleted",
  renamed: "renamed",
  copied: "copied",
  "type-changed": "type changed",
  conflicted: "conflicted",
  ignored: "ignored",
  unknown: "changed",
}

/** How far one level of nesting indents. Enough to read as a step, cheap in a 16rem column. */
const INDENT = 10

/**
 * Which directories are open, and what is in each one.
 *
 * One flat map keyed by directory path rather than a tree of nodes, and that is
 * what keeps a view nothing polls correct: reading a folder writes one key, and
 * nothing else in the structure moves. Nested, every open folder's contents
 * would live inside its parent's fetched answer, so re-reading any directory
 * would throw away everything below it.
 *
 * The repository root is the empty string, which is the one key always present:
 * a tree whose top level you had to click to see would be a list with no rows.
 */
type Loaded = ReadonlyMap<string, GitTree>

export function FileTree({
  projectId,
  openFolders,
}: {
  projectId: string
  /**
   * Which folders are open, owned by the rail rather than by this component.
   *
   * Up there because this half is unmounted whenever you look at the history —
   * so state held here is state thrown away by a glance at the other tab, and
   * three clicks to reach a directory is exactly the thing not to make somebody
   * repeat. What is NOT lifted is the fetched contents: those are re-read on the
   * way back in, which is a request, where the clicks are a chore.
   */
  openFolders: ReturnType<typeof useKeyed<ReadonlySet<string>>>
}) {
  // Keyed by project, like every other reading in this rail: one repository's
  // paths must never be drawn under another's name.
  const [loaded, remember] = useKeyed<Loaded>(projectId)
  const [open, rememberOpen] = openFolders
  const [error, rememberError] = useKeyed<string>(projectId)
  // Which paths have a request in flight, so a folder says it is thinking rather
  // than sitting there looking broken on a repo — or a connection — that is slow.
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set())

  /**
   * The map as it is NOW, for the moment an answer lands.
   *
   * Two folders opened in quick succession is the case this exists for: both
   * requests read the state when they STARTED, so whichever answers second would
   * write a map built from before either of them, and the first folder's rows
   * would vanish the instant the second arrived.
   *
   * Written by `read` itself rather than mirrored from `loaded` in an effect,
   * which makes this the authoritative copy and the state a rendering of it. The
   * mirror is what a ref usually is here, and it cannot work: an effect runs
   * after the commit, so two answers landing in the same tick both merge into a
   * ref that is one commit stale, which is the very bug it was meant to prevent.
   *
   * Seeded from `loaded` on the way in, so a remount — a tab switch, or
   * StrictMode's second mount — starts from whatever this project already has
   * rather than from empty.
   */
  const latest = useRef<Loaded>(loaded ?? new Map())

  /**
   * The paths with a request ON THE WIRE right now, and only those.
   *
   * A ref rather than state, because it must be true the instant it is written:
   * the effect below asks for several directories in one pass, and a `busy` set
   * updated through React would still be empty for every one of them.
   *
   * It tracks in-flight and NOT "ever asked", which is the distinction that cost
   * an afternoon. As "ever asked" this deadlocked the whole view under
   * StrictMode, which mounts, unmounts and remounts every component in
   * development: the first mount's fetch was discarded with that mount, the ref
   * survived it — refs are not state — and the remount then found the root
   * already in the set and returned without asking. Nothing ever loaded, and the
   * tree sat on "Reading the tree…" for good. The failure looked like a slow
   * network, which is why it is written down rather than just fixed.
   *
   * A directory that FAILED is left out of it, so it can be asked for again. The
   * retry loop that guard was protecting against is handled where it belongs —
   * see `failed` below, which remembers the error instead of suppressing the
   * request.
   */
  const inFlight = useRef<Set<string>>(new Set())
  /**
   * Paths whose last read failed, so the effect stops re-asking for them.
   *
   * The loop this prevents is real: a failure puts nothing in `loaded`, so the
   * path stays in the wanted list, and every later answer from a sibling re-runs
   * the effect and asks again. Cleared by a click, which is the deliberate retry.
   */
  const failed = useRef<Set<string>>(new Set())
  // Both emptied on the way into a different project. Without this the paths
  // tried in one repository would suppress the reads for the identically-named
  // ones in the next — `src` is in every project here.
  const askedFor = useRef<string | null>(projectId)
  if (askedFor.current !== projectId) {
    askedFor.current = projectId
    inFlight.current = new Set()
    failed.current = new Set()
    // And the merge target, or the first answer for the new project would be
    // written on top of the previous one's directories — which `useKeyed` would
    // then file under the NEW project's key. One repository's paths appearing
    // under another's name is the one thing this rail may never do.
    latest.current = loaded ?? new Map()
  }

  const read = useCallback(
    async (path: string) => {
      // Only ever a de-duplicator for a request already on the wire — never a
      // record that this path was tried. See `inFlight`.
      if (inFlight.current.has(path)) return
      inFlight.current.add(path)
      failed.current.delete(path)
      setBusy((prev) => new Set(prev).add(path))
      try {
        const answer = await api.gitTree(projectId, path)
        // Filed under the project it was ASKED about — see `useKeyed`. A slow
        // `ls-tree` on the repo you just left otherwise lands in the rail of the
        // one you arrived at, which is the one thing this rail may never do.
        const next = new Map(latest.current).set(path, answer)
        // What the daemon sent unasked, for a remote project: each subdirectory
        // one level down, fetched inside the connection this request already
        // paid for. Merged in as though it had been asked for, so opening one of
        // these folders finds it cached and returns in a frame instead of in the
        // 1.4s an ssh handshake costs. See `GitTree.children`.
        //
        // Never overwrites a directory already read: a real answer is newer than
        // a prefetch that rode along with its parent, and a folder you opened,
        // watched a run change, and reopened must not be reverted by a stale
        // copy of itself.
        for (const [dir, entries] of Object.entries(answer.children)) {
          if (!next.has(dir)) next.set(dir, { path: dir, entries, children: {} })
        }
        // The ref first, so a second answer landing before React has committed
        // this one still merges on top of it rather than on top of the map this
        // one replaced.
        latest.current = next
        remember(projectId, next)
        rememberError(projectId, null)
      } catch (err) {
        failed.current.add(path)
        rememberError(projectId, err instanceof Error ? err.message : String(err))
      } finally {
        inFlight.current.delete(path)
        setBusy((prev) => {
          const next = new Set(prev)
          next.delete(path)
          return next
        })
      }
    },
    [projectId, remember, rememberError],
  )

  /**
   * Everything that should be on screen but has not been read yet, encoded so
   * the effect below can compare it by value rather than by array identity.
   *
   * The root, always — it is the one row you did not click for. And every folder
   * left open from before, because the open set outlives this component while
   * its contents do not: without this, coming back from the history finds three
   * folders with turned carets and nothing under any of them.
   *
   * JSON, and NOT a joined string, because the repository root's path is the
   * empty string and every separator scheme makes that ambiguous. Joining with a
   * newline was the first version and it deadlocked the whole pane: a list
   * holding only the root — which is EVERY fresh mount — joins to `""`, the
   * guard below read that as "nothing wanted" and returned, and the one fetch
   * this view depends on was never made. It looked exactly like a slow network,
   * on local and remote projects alike, which is how it survived two rounds of
   * being stared at.
   *
   * `JSON.stringify([""])` is `'[""]'` and `JSON.stringify([])` is `'[]'` —
   * different values, so "just the root" can no longer be read as "nothing to
   * do", and a path containing any character at all round-trips.
   */
  const wanted = JSON.stringify(["", ...(open ?? [])].filter((path) => !loaded?.has(path)))

  useEffect(() => {
    const paths = JSON.parse(wanted) as string[]
    if (paths.length === 0) return
    // `failed` is consulted HERE rather than inside `read`, so that a click can
    // still retry one — see `toggle`. Skipping it in `read` would make the
    // failure permanent for the life of the mount, which is the mistake the
    // in-flight guard used to make for every path, successful or not.
    for (const path of paths) {
      if (!failed.current.has(path)) void read(path)
    }
    // `read` is stable per project and `wanted` is what decides this. Depending
    // on `loaded` instead would re-run on every answer, which is the same loop
    // by another name.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, read])

  const toggle = (path: string) => {
    const isOpen = open?.has(path) ?? false
    const next = new Set(open ?? [])
    if (isOpen) next.delete(path)
    else {
      next.add(path)
      // Already have it — from a prefetch that rode along with its parent, or
      // from having opened it before — so it draws now and costs nothing. This
      // is the case the prefetch above exists to create: on a remote project the
      // alternative is a 1.4s ssh handshake between the click and the rows.
      //
      // Otherwise a click is a deliberate ask, so it forgets an earlier failure
      // and tries again — this is the retry for a directory that errored, and
      // nothing polls this view, so re-opening is the only refresh there is.
      if (!loaded?.has(path)) {
        failed.current.delete(path)
        void read(path)
      }
    }
    rememberOpen(projectId, next)
  }

  const rows = loaded?.get("")

  return (
    <>
      {/* A failed read never blanks what is already drawn, for the same reason
          the history's does not: this reads a repo an agent may be writing into,
          so a hiccup is commoner than an outage. */}
      {error && <p className="shrink-0 px-3 pb-1 font-sans text-[11px] text-err">{error}</p>}

      <div className="min-h-0 flex-1 overflow-auto py-1">
        {!rows ? (
          error ? null : (
            <p className="px-3 py-2 font-sans text-[11px] text-fg-dim">Reading the tree…</p>
          )
        ) : rows.entries.length === 0 ? (
          <p className="px-3 py-2 font-sans text-[11px] leading-relaxed text-fg-dim">
            Nothing committed here yet, and nothing new on disk.
          </p>
        ) : (
          <Level
            entries={rows.entries}
            depth={0}
            open={open ?? new Set()}
            loaded={loaded ?? new Map()}
            busy={busy}
            onToggle={toggle}
          />
        )}
      </div>
    </>
  )
}

/**
 * One directory's rows, and the open ones' contents under them.
 *
 * Recursive rather than a flattened list with a depth on each row. The tree is
 * only as deep as the folders you have opened, so the recursion is bounded by
 * something you did — and each level renders from its own fetched answer, which
 * means a re-read of one directory cannot disturb the rows of another.
 */
function Level({
  entries,
  depth,
  open,
  loaded,
  busy,
  onToggle,
}: {
  entries: GitTreeEntry[]
  depth: number
  open: ReadonlySet<string>
  loaded: Loaded
  busy: ReadonlySet<string>
  onToggle: (path: string) => void
}) {
  return (
    <>
      {entries.map((entry) => {
        const isOpen = open.has(entry.path)
        const children = loaded.get(entry.path)
        return (
          <div key={entry.path}>
            <Row
              entry={entry}
              depth={depth}
              open={isOpen}
              loading={busy.has(entry.path)}
              onToggle={onToggle}
            />
            {isOpen &&
              children &&
              (children.entries.length > 0 ? (
                <Level
                  entries={children.entries}
                  depth={depth + 1}
                  open={open}
                  loaded={loaded}
                  busy={busy}
                  onToggle={onToggle}
                />
              ) : (
                /* An open folder that came back with nothing — a directory
                   holding only ignored files is the ordinary way to get one.
                   Said rather than left blank: the caret has turned, so with no
                   line here the only reading is that the click did nothing. */
                <p
                  className="py-[3px] font-sans text-[11px] text-fg-dim"
                  style={{ paddingLeft: 12 + (depth + 1) * INDENT + 16 }}
                >
                  empty
                </p>
              ))}
          </div>
        )
      })}
    </>
  )
}

/**
 * One file or folder.
 *
 * A button only when it is a directory — that is the one row here with something
 * to do. A file is a div, and that is the boundary this view holds: opening one
 * would be an editor, and the brief is explicit that reading code in aide is in
 * scope while replacing the editor is not. What a file row is for is knowing it
 * is there and whether it has changed.
 */
function Row({
  entry,
  depth,
  open,
  loading,
  onToggle,
}: {
  entry: GitTreeEntry
  depth: number
  open: boolean
  loading: boolean
  onToggle: (path: string) => void
}) {
  // The indent is padding rather than a margin or a spacer element, so the hover
  // wash and the row's click target still run the full width of the column at
  // every depth — an indented row whose highlight starts halfway across reads as
  // a different list.
  const pad = 12 + depth * INDENT

  const marked = entry.kind === "directory" ? entry.dirty : entry.state !== null
  const tone = entry.state ? STATE_STYLE[entry.state] : marked ? "text-warn" : "text-fg-muted"

  if (entry.kind === "file") {
    const look = lookOf(entry.name)
    return (
      <Hint hint={`${entry.path}${entry.state ? ` · ${STATE_LABEL[entry.state]}` : ""}`}>
        <div
          // A file has no caret, so its badge starts in the column a sibling
          // folder spends on one. Both rows then run caret-or-badge, gap, icon-
          // width, gap, name — and the names land on the same x at every depth,
          // which is the whole reason a tree is readable at a glance.
          style={{ paddingLeft: pad }}
          className={`flex items-center gap-1.5 py-[3px] pr-3 font-sans text-[12px] ${tone}`}
        >
          {/* What kind of file this is — see `filetypes.ts`. The icon carries the
              class of thing (code, config, prose, a picture) and its colour
              carries the language, because at 12px a per-language glyph is a
              smudge told apart by position while a colour is legible at a glance.

              Boxed to 30px, which is not a taste: a folder row spends caret(12) +
              gap(6) + icon(12) before its name, so a file name lands on the same x
              as the folder name above it. Change either and the column goes
              ragged. */}
          <span
            className="flex shrink-0 justify-end"
            style={{ width: 30 }}
            aria-hidden="true"
          >
            <look.Icon className={`size-3.5 ${look.tone}`} />
          </span>
          <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        </div>
      </Hint>
    )
  }

  return (
    <Hint
      hint={
        entry.dirty
          ? `${entry.path} — something under here is uncommitted`
          : entry.path
      }
    >
      <button
        type="button"
        onClick={() => onToggle(entry.path)}
        style={{ paddingLeft: pad }}
        className={`flex w-full cursor-pointer items-center gap-1.5 py-[3px] pr-3 text-left font-sans text-[12px] transition-colors outline-none hover:bg-hover focus-visible:bg-hover ${tone}`}
      >
        <CaretRight
          className={`size-3 shrink-0 text-fg-dim transition-transform ${open ? "rotate-90" : ""}`}
        />
        <Folder className="size-3 shrink-0 text-fg-dim" />
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        {/* A folder mid-fetch. One character, in the column the file states use,
            because a slow directory on a remote project is otherwise a click with
            nothing on screen acknowledging it. */}
        {loading && <span className="shrink-0 font-mono text-[10px] text-fg-dim">…</span>}
      </button>
    </Hint>
  )
}
