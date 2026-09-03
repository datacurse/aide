import { stat } from "node:fs/promises"
import { join } from "node:path"
import type {
  GitCommit,
  GitCommitDetail,
  GitFileChange,
  GitFileState,
  GitGraphRow,
  GitLane,
  GitLog,
  GitOverview,
  GitPending,
  GitRef,
  GitTree,
  GitTreeEntry,
  GitWorkingTree,
} from "@aide/protocol"
import {
  git,
  gitBatch,
  gitDiffing,
  gitOr,
  refHost,
  refPath,
  refRoot,
  shellQuote,
  sshCommand,
  type RepoRef,
} from "./git.js"

/**
 * Reading a project's own repository — branch, history, and whatever is sitting
 * uncommitted in the working tree.
 *
 * Strictly read-only, and that is a rule rather than a description. The obvious
 * way to make untracked files appear in a diff is `git add -A -N`, but the
 * project's checkout belongs to the human. Staging intent-to-add across someone
 * else's working tree because they opened a read-only view is aide editing state
 * it was only asked to show. New files are diffed with `--no-index` against
 * /dev/null instead, which touches nothing.
 *
 * That rule used to have an escape hatch — a run's own worktree belonged to
 * aide, so `worktreeDiff` could stage freely in it. There is no such tree any
 * more: a run works the human's checkout, and `changes.ts` reaches the same
 * answer through a scratch index rather than by staging.
 */

// ---------------------------------------------------------------------------
// Is there a repo here at all
// ---------------------------------------------------------------------------

/**
 * How big a file is, on whichever machine holds it. Null when it is gone.
 *
 * Remotely this is `git hash-object`, which reports the blob size without
 * transferring the file — the question is only ever "is this too big to inline",
 * so moving a 40MB file across the network to answer it would be absurd.
 */
async function fileSize(root: RepoRef, path: string): Promise<number | null> {
  if (!refHost(root)) {
    try {
      return (await stat(join(refRoot(root), path))).size
    } catch {
      return null
    }
  }
  // `git hash-object -w` would write an object into the repository to measure a
  // file, which is a side effect on somebody's tree for a display decision.
  // `wc -c` is a read, and it is the same shell this file already reaches the
  // far machine through.
  //
  // Through `sshCommand` rather than a hand-built `execFile("ssh", …)`, because
  // that is what carries `REMOTE_GIT_TIMEOUT_MS`. This runs once per untracked
  // file — up to fifty times in one `workingTree` — so a host that stops
  // answering used to hang the whole request rather than one row of it, which is
  // the failure `git.ts` gave every OTHER remote call a timeout to prevent.
  const out = await gitOr("", () => sshCommand(root, `wc -c < ${shellQuote(refPath(root, path))}`))
  const n = Number(out.trim())
  return Number.isFinite(n) ? n : null
}

export async function isGitRepo(root: RepoRef): Promise<boolean> {
  try {
    const out = await git(root, ["rev-parse", "--is-inside-work-tree"])
    return out.trim() === "true"
  } catch {
    return false
  }
}

export async function repoRoot(dir: string): Promise<string | null> {
  try {
    return (await git(dir, ["rev-parse", "--show-toplevel"])).trim()
  } catch {
    return null
  }
}


// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export async function overview(root: RepoRef): Promise<GitOverview> {
  // Four independent questions, so one round trip rather than four. See
  // `gitBatch` — on a remote project the difference is about four and a half
  // seconds every time this pane refreshes.
  //
  // `--left-right --count` answers "ahead<tab>behind" in one call. Asked for
  // directly rather than read off `git status --branch`'s header, because that
  // header drops the counts entirely when they are zero, so its absence means
  // both "in step" and "no upstream" and the two are not the same thing.
  const [namedOut, headOut, upstreamOut, countsOut] = await gitBatch(root, [
    ["rev-parse", "--abbrev-ref", "HEAD"],
    ["rev-parse", "--short", "HEAD"],
    ["rev-parse", "--abbrev-ref", "@{upstream}"],
    ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
  ])

  // "HEAD" rather than a name is git's way of saying detached, and a detached
  // checkout is a real state a project can be in — mid-bisect, mid-rebase — not
  // an error to hide.
  const named = (namedOut ?? "").trim() || "HEAD"
  const branch = named === "HEAD" ? null : named

  // Empty in a repo with no commits yet, which is exactly what `unborn` means.
  const head = (headOut ?? "").trim() || null
  const upstream = (upstreamOut ?? "").trim() || null

  const [a, b] = (countsOut ?? "").trim().split(/\s+/)
  const ahead = Number(a) || 0
  const behind = Number(b) || 0

  // The path alone: `GitOverview.root` goes to the browser, which shows it as a
  // location and has no use for the transport.
  return { root: refRoot(root), branch, head, upstream, ahead, behind, unborn: head === null }
}

// ---------------------------------------------------------------------------
// Working tree
// ---------------------------------------------------------------------------

const STATE: Record<string, GitFileState> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type-changed",
  "?": "untracked",
  "!": "ignored",
  U: "conflicted",
}

/** git's unmerged codes: anything with a U, plus the two same-letter pairs. */
const isConflicted = (code: string) => code.includes("U") || code === "AA" || code === "DD"

/**
 * `--porcelain=v1 -z` rather than the human format, because the human one quotes
 * and escapes any path with a space or a non-ASCII byte, and unpicking C string
 * literals by hand is a bug waiting for the first file with a space in its name.
 * `-z` emits raw bytes with NUL terminators, and a rename spends two fields: the
 * new path, then the old one.
 */
export function parseStatus(z: string): GitFileChange[] {
  const fields = z.split("\0")
  const files: GitFileChange[] = []

  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]
    if (!entry) continue
    const code = entry.slice(0, 2)
    const path = entry.slice(3)
    if (!path) continue

    let from: string | null = null
    if (code[0] === "R" || code[0] === "C") {
      // The old path is its own NUL-terminated field, immediately after.
      from = fields[++i] ?? null
    }

    const conflicted = isConflicted(code)
    files.push({
      path,
      from,
      code,
      staged: conflicted ? "conflicted" : (STATE[code[0] ?? " "] ?? null),
      unstaged: conflicted ? "conflicted" : (STATE[code[1] ?? " "] ?? null),
    })
  }
  return files
}

export async function status(root: RepoRef): Promise<GitFileChange[]> {
  // `--untracked-files=all` so new files are listed one by one. The default
  // collapses them into a bare directory name, which cannot be diffed and reads
  // in the UI as one mystery entry instead of the six files it stands for.
  const z = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
  return parseStatus(z)
}

/**
 * What is left to commit, as opposed to what git happens to call dirty.
 *
 * `status()` above answers "what does git say"; this answers "what work is
 * outstanding", and they are now the same question. They were not always: aide
 * used to own a file in the tree that no commit could take, so an indicator that
 * counted it would have been lit forever. Nothing is excluded any more, and the
 * invariant this exists for is unchanged — what the rail lights on and what a
 * commit would take must be one set, or the screen explains neither the refusal
 * nor the button that clears it.
 *
 * The branch comes from one `rev-parse` rather than a whole `overview()`. This
 * is polled from the always-visible rail, and three extra round trips per beat
 * to learn ahead/behind counts nothing here shows would be paid on every beat.
 */
export async function pending(root: RepoRef): Promise<GitPending> {
  // Both in one round trip. This is THE polled call — the rail is always on
  // screen — so on a remote project the saving is 1.4s on every beat, which is
  // the difference between a rail that lags behind the tree and one that does
  // not.
  const [namedOut, z, countsOut] = await gitBatch(root, [
    ["rev-parse", "--abbrev-ref", "HEAD"],
    // `--untracked-files=all` so new files are listed one by one. The default
    // collapses them into a bare directory name, which cannot be diffed and
    // reads in the UI as one mystery entry instead of the six files it is.
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    // A third command in the SAME batch, so the push button knows whether it has
    // anything to send without costing this — the hardest-polled call in the
    // daemon — a second connection. Same form as `overview`'s: asked directly
    // rather than read off `status --branch`, whose header drops the counts when
    // they are zero and so cannot tell "in step" from "no upstream".
    ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
  ])
  const named = (namedOut ?? "").trim() || "HEAD"
  // A failed command yields "" from `gitBatch`, which is exactly what no
  // upstream looks like — and null is the honest answer for it, not 0. See
  // `GitPending.ahead`.
  const counts = (countsOut ?? "").trim()
  const aheadRaw = counts ? Number(counts.split(/\s+/)[0]) : Number.NaN
  return {
    branch: named === "HEAD" ? null : named,
    files: parseStatus(z ?? ""),
    ahead: Number.isFinite(aheadRaw) ? aheadRaw : null,
  }
}

/**
 * How much untracked content is worth rendering inline. A stray build artefact
 * or an unignored lockfile is megabytes of noise, and a view that hangs on one
 * is worse than a view that says it skipped it.
 */
const UNTRACKED_FILE_LIMIT = 50
const UNTRACKED_BYTE_LIMIT = 512 * 1024

export async function workingTree(root: RepoRef): Promise<GitWorkingTree> {
  const files = await status(root)
  const view = await overview(root)

  // `diff HEAD` is staged and unstaged together — everything between the last
  // commit and the files on disk, which is the question this view exists to
  // answer. Before the first commit there is no HEAD to compare against, so the
  // index is the only baseline there is.
  const tracked = await gitOr("", () =>
    git(root, view.unborn ? ["diff", "--cached"] : ["diff", "HEAD"]),
  )

  const parts = tracked.trim() ? [tracked.trimEnd()] : []
  const omitted: { path: string; why: string }[] = []
  let rendered = 0

  for (const f of files) {
    if (f.code !== "??") continue
    if (rendered >= UNTRACKED_FILE_LIMIT) {
      omitted.push({ path: f.path, why: `over ${UNTRACKED_FILE_LIMIT} new files` })
      continue
    }
    // The size decides whether this file is inlined, so it has to be read on
    // the machine holding it. `stat` here would be measuring a path that does
    // not exist on this one, and every untracked file in a remote project would
    // be reported as having disappeared.
    const size = await fileSize(root, f.path)
    if (size === null) {
      // Gone between the status call and this one. Not an error, just gone.
      omitted.push({ path: f.path, why: "disappeared while reading" })
      continue
    }
    if (size > UNTRACKED_BYTE_LIMIT) {
      omitted.push({ path: f.path, why: `${Math.round(size / 1024)} KB, too large to inline` })
      continue
    }
    // git understands /dev/null on Windows too — it matches the literal string
    // rather than resolving it through the OS — and it makes git emit a real
    // `new file mode` header, so new files land in the same renderer as every
    // other patch instead of needing a second one.
    const patch = await gitOr("", () =>
      gitDiffing(root, ["diff", "--no-index", "--", "/dev/null", f.path]),
    )
    if (patch.trim()) {
      parts.push(patch.trimEnd())
      rendered++
    }
  }

  return { overview: view, files, diff: parts.join("\n"), omitted }
}

// ---------------------------------------------------------------------------
// The tree of files
// ---------------------------------------------------------------------------

/**
 * Which of a file's two status halves the tree shows.
 *
 * The working-tree half when there is one, exactly as the uncommitted list above
 * it chooses — see `PendingRow`. Same rule in both places on purpose: one file
 * marked "added" in one list and "modified" in the other, on the same rail, is
 * two lists that appear to disagree about the same fact.
 */
const shownState = (f: GitFileChange): GitFileState => f.unstaged ?? f.staged ?? "unknown"

/**
 * One directory of the working tree, from `ls-tree` plus `status`.
 *
 * Pure, and separate from the call that fetches its inputs, because everything
 * here that can be wrong is wrong quietly: a prefix compared without its
 * trailing slash makes `src2/` a child of `src`, and a deleted file that git
 * still lists in HEAD's tree would otherwise show as an ordinary row. `pnpm
 * smoke` reaches this directly.
 *
 * Three sources rather than one, and each covers what the others cannot:
 *
 * - `ls-tree` is what is COMMITTED here, which is most of the repository and is
 *   the only one of the three that is cheap to ask for one directory at a time.
 * - `status` adds what is not committed — an untracked file exists on disk and
 *   in no tree — and marks everything it names.
 * - and `status` again, over the whole repo, is what lets a COLLAPSED directory
 *   say that something under it changed. That is the mark you actually navigate
 *   by, and nothing local to this directory knows it.
 *
 * A path that git reports as deleted is dropped rather than drawn struck
 * through. It is in HEAD's tree and not on disk, and a file tree whose rows are
 * things you can open must not offer one that is not there.
 */
export function buildTree(
  path: string,
  lsTree: string,
  changes: GitFileChange[],
): GitTreeEntry[] {
  // Normalised once, with the trailing slash, so `startsWith` cannot match a
  // sibling whose name merely begins the same way — `src/` never matches
  // `src2/foo.ts`. The root is the empty prefix, which matches everything, which
  // is correct.
  const prefix = path ? `${path.replace(/\/+$/, "")}/` : ""

  const state = new Map<string, GitFileState>()
  const deleted = new Set<string>()
  // Every directory with something uncommitted anywhere beneath it. Built by
  // walking each changed path's ancestors, so `a/b/c.ts` marks `a/b` and `a`.
  const dirty = new Set<string>()
  for (const change of changes) {
    const shown = shownState(change)
    state.set(change.path, shown)
    if (shown === "deleted") deleted.add(change.path)
    // A rename leaves its old path behind, and git names it in the same entry
    // rather than as a deletion of its own — without this, the file appears
    // under both names and one of them cannot be opened.
    if (change.from) deleted.add(change.from)
    for (let cut = change.path.indexOf("/"); cut !== -1; cut = change.path.indexOf("/", cut + 1)) {
      dirty.add(change.path.slice(0, cut))
    }
  }

  const entries = new Map<string, GitTreeEntry>()
  const add = (name: string, kind: "file" | "directory") => {
    const full = `${prefix}${name}`
    if (kind === "file" && deleted.has(full)) return
    // First writer wins, so a name in both `ls-tree` and `status` — a tracked
    // file that has been edited — keeps one row rather than two.
    if (entries.has(full)) return
    entries.set(full, {
      name,
      path: full,
      kind,
      state: kind === "file" ? (state.get(full) ?? null) : null,
      dirty: kind === "directory" ? dirty.has(full) : false,
    })
  }

  // `ls-tree` without `-r` already lists exactly one level, and marks a
  // directory with the `tree` type — so there is no name-splitting to do here
  // and no chance of mistaking a file with a slash in its name for a folder.
  for (const line of lsTree.split("\0")) {
    if (!line) continue
    // `<mode> <type> <object>\t<path>` — the tab is the only safe split, since
    // a path may contain spaces.
    const tab = line.indexOf("\t")
    if (tab === -1) continue
    const type = line.slice(0, tab).split(/\s+/)[1]
    const full = line.slice(tab + 1)
    const name = full.slice(prefix.length)
    if (!name) continue
    add(name, type === "tree" ? "directory" : "file")
  }

  // Untracked work, which is in no tree and therefore in nothing above. A new
  // file two levels down contributes the DIRECTORY that holds it, not itself —
  // that folder is untracked too, so `ls-tree` has never heard of it either.
  for (const change of changes) {
    if (!change.path.startsWith(prefix)) continue
    const rest = change.path.slice(prefix.length)
    if (!rest) continue
    const cut = rest.indexOf("/")
    if (cut === -1) add(rest, "file")
    else add(rest.slice(0, cut), "directory")
  }

  // Directories first, then A–Z within each group, case-insensitively: the order
  // VS Code's explorer uses, and the one that makes a folder findable by where
  // it is rather than by reading every row.
  return [...entries.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  })
}

/**
 * One directory of the working tree, wherever the repository is.
 *
 * Every read in ONE round trip, and on a remote project that is the only number
 * that matters. Measured against `tg`: `ssh echo hi` is 1.44s, this whole call
 * is 1.55s. The handshake is the cost and the git is a rounding error, because
 * Windows OpenSSH cannot multiplex — which is why the shape here is "ask for
 * everything you might want while the door is open" rather than "ask for the
 * least".
 *
 * `status` is the whole repository rather than this directory, because that is
 * what a COLLAPSED folder's dirty mark is made of — a directory's own listing
 * cannot know about a change three levels below it. It is read once and reused
 * for the prefetched children too, since it already describes them.
 */
export async function tree(root: RepoRef, path: string): Promise<GitTree> {
  // Trailing slash, because `ls-tree HEAD src` prints the DIRECTORY `src` as one
  // entry, and `ls-tree HEAD src/` prints what is inside it. One character, and
  // without it every folder opens to show only itself.
  const clean = path.replace(/^\/+|\/+$/g, "")
  const [lsTree, z] = await gitBatch(root, [
    ["ls-tree", "-z", "HEAD", clean ? `${clean}/` : "."],
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
  ])
  const changes = parseStatus(z ?? "")
  const entries = buildTree(clean, lsTree ?? "", changes)

  // A remote project pays for the CONNECTION, not for the reading: `ls-tree` on
  // a directory is ~80ms and the ssh handshake around it is 1.4s, because
  // Windows OpenSSH cannot multiplex. So the second round trip — the one you
  // spend opening the first folder — is bought here instead, inside the
  // connection that is already open, and the expand it pays for is instant.
  //
  // One level deep and no further. Two would be most of the repository read to
  // draw rows nobody has asked for, which is the whole-tree fetch this design
  // exists to avoid; one is bounded by the directories on screen.
  //
  // Local projects skip it: there is no handshake to amortise, each read is
  // ~30ms, and prefetching would be work done on the chance it is wanted.
  const children: Record<string, GitTreeEntry[]> = {}
  const dirs = entries.filter((e) => e.kind === "directory")
  if (refHost(root) && dirs.length > 0) {
    const inner = await gitBatch(
      root,
      dirs.map((d) => ["ls-tree", "-z", "HEAD", `${d.path}/`]),
    )
    dirs.forEach((d, i) => {
      // The SAME status output, reused rather than re-read. It is the whole
      // repository's, so it already describes every one of these directories —
      // asking again per child would be the expensive call git makes, repeated.
      children[d.path] = buildTree(d.path, inner[i] ?? "", changes)
    })
  }

  return { path: clean, entries, children }
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

const FIELDS = [
  "%H",
  "%h",
  "%an",
  "%ae",
  "%aI",
  "%D",
  "%P",
  "%s",
] as const

// Unit separator between fields. Nothing git puts in these can contain one, and
// unlike a space or a pipe it needs no escaping for subjects that contain either.
const FORMAT = `--format=${FIELDS.join("%x1f")}`

/**
 * `HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1`.
 *
 * Read from the full form on purpose — see GitRef. Anything git decorates with
 * that is not a ref path (`grafted`, `replaced`) is kept as it came rather than
 * dropped: an unexplained word next to a commit is a question, and a commit
 * quietly missing its decoration is a wrong answer.
 */
function parseRefs(raw: string): GitRef[] {
  const out: GitRef[] = []
  for (const piece of raw.split(",").map((r) => r.trim()).filter(Boolean)) {
    let rest = piece
    let head = false
    if (rest.startsWith("HEAD -> ")) {
      head = true
      rest = rest.slice(8)
    }
    if (rest === "HEAD") {
      // Detached: HEAD is at this commit and no branch is.
      out.push({ name: "HEAD", kind: "branch", head: true })
      continue
    }
    if (rest.startsWith("tag: ")) rest = rest.slice(5)
    if (rest.startsWith("refs/heads/")) out.push({ name: rest.slice(11), kind: "branch", head })
    else if (rest.startsWith("refs/remotes/")) out.push({ name: rest.slice(13), kind: "remote", head })
    else if (rest.startsWith("refs/tags/")) out.push({ name: rest.slice(10), kind: "tag", head })
    else out.push({ name: rest, kind: "branch", head })
  }
  return out
}

function parseCommit(line: string): GitCommit | null {
  const f = line.split("\x1f")
  const [sha, short, author, authorEmail, date, refs, parents, ...rest] = f
  if (!sha || !short) return null
  return {
    sha,
    short,
    author: author ?? "",
    authorEmail: authorEmail ?? "",
    date: date ?? "",
    refs: parseRefs(refs ?? ""),
    parents: (parents ?? "").split(" ").filter(Boolean),
    // Rejoined rather than taken as one field, so a subject that somehow does
    // contain a separator truncates instead of losing the commit entirely.
    subject: rest.join("\x1f"),
  }
}

/**
 * Lanes for a page of history: the drawn graph, minus the drawing.
 *
 * A track is a line on its way down the page, and what it holds is the sha it
 * is still LOOKING for. A commit takes over the first track waiting for it —
 * that is what makes a branch one unbroken line rather than a new column per
 * commit — and any other track waiting for the same sha is a second child, so
 * it ends here and is drawn merging in.
 *
 * Two rules earn their keep and are easy to get wrong:
 *
 * - The first parent inherits the commit's own lane AND its colour. Give it a
 *   fresh lane and `main` changes colour and column at every merge, which is
 *   the difference between a graph you can follow and a plate of spaghetti.
 * - A lane freed by a merge is reused, but only ever from the left. Without
 *   that, a busy repo drifts rightwards forever and the column grows to fit
 *   lanes that are all empty.
 *
 * A parent outside the page is not a special case: its track stays open and the
 * row draws a line leaving the bottom edge, which is what "history continues
 * past here" looks like.
 */
export function buildGraph(commits: GitCommit[]): { graph: GitGraphRow[]; lanes: number } {
  interface Track {
    /** The sha this line is descending towards. */
    sha: string
    color: number
  }
  const tracks: (Track | null)[] = []
  const graph: GitGraphRow[] = []
  let nextColor = 0
  let lanes = 0

  /** Leftmost gap, else a new column on the right. */
  const free = () => {
    const gap = tracks.indexOf(null)
    return gap === -1 ? tracks.length : gap
  }

  for (const commit of commits) {
    let lane = tracks.findIndex((t) => t?.sha === commit.sha)
    // Nothing was waiting for it: a branch tip, or a commit whose children are
    // above the top of this page. Either way nothing is drawn above the dot.
    const tip = lane === -1
    if (tip) {
      lane = free()
      tracks[lane] = { sha: commit.sha, color: nextColor++ }
    }
    const color = tracks[lane]?.color ?? 0

    const enters: GitLane[] = tip ? [] : [{ lane, color }]
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i]
      if (i !== lane && t?.sha === commit.sha) {
        enters.push({ lane: i, color: t.color })
        tracks[i] = null
      }
    }

    // Read before the parents are placed, so a lane this commit is about to open
    // is not also claimed to be running past it.
    const through: GitLane[] = []
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i]
      if (i !== lane && t) through.push({ lane: i, color: t.color })
    }

    const leaves: GitLane[] = []
    const [first, ...rest] = commit.parents
    if (first) {
      tracks[lane] = { sha: first, color }
      leaves.push({ lane, color })
    } else {
      tracks[lane] = null
    }
    for (const parent of rest) {
      const open = tracks.findIndex((t) => t?.sha === parent)
      const existing = open === -1 ? null : tracks[open]
      if (existing) {
        // Two branches with the same parent share one line down to it.
        leaves.push({ lane: open, color: existing.color })
        continue
      }
      const l = free()
      const c = nextColor++
      tracks[l] = { sha: parent, color: c }
      leaves.push({ lane: l, color: c })
    }

    lanes = Math.max(lanes, lane + 1)
    for (const l of [...through, ...enters, ...leaves]) lanes = Math.max(lanes, l.lane + 1)
    graph.push({ sha: commit.sha, lane, color, through, enters, leaves })

    // Trailing empties would otherwise make `free()` walk further every row.
    while (tracks.length > 0 && tracks[tracks.length - 1] === null) tracks.pop()
  }

  return { graph, lanes }
}

/**
 * How far along the checkout's own line each commit on the page is.
 *
 * The number a human means by "how far have I got": the first commit is 1, HEAD
 * is however many there are, and a commit keeps its number for as long as the
 * history behind it is not rewritten. That stability is the entire requirement
 * — a page numbered 1 to 30 from the top renumbers every commit in the project
 * every time you make one, which is a row index rather than something to track
 * progress against.
 *
 * The first-parent line rather than `rev-list --count <sha>` per commit. That is
 * the exact answer to "how many commits can this one reach", and it costs a
 * process per row per poll to get; the two agree along a mainline anyway. Where
 * they part is a commit that arrived on a branch, and one of those gets no
 * number at all rather than a plausible wrong one — it is not a step along the
 * line being counted, and the UI leaves its column blank.
 *
 * Two calls rather than one long list: `--count` walks the whole line, because
 * the newest commit's number has to be how many there ARE and not how many were
 * asked for, and the second is bounded by the page so a ten-thousand-commit repo
 * does not send its entire history down the wire to number thirty rows.
 */
async function firstParentNumbers(root: RepoRef, limit: number): Promise<Record<string, number>> {
  const counted = await gitOr("", () =>
    git(root, ["rev-list", "--count", "--first-parent", "HEAD"]),
  )
  const total = Number(counted.trim())
  // A repo with no commits counts nothing, and there is nothing to number.
  if (!Number.isInteger(total) || total <= 0) return {}

  const line = await gitOr("", () =>
    git(root, ["rev-list", "--first-parent", `-n${limit}`, "HEAD"]),
  )
  const numbers: Record<string, number> = {}
  line
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .forEach((sha, i) => {
      numbers[sha] = total - i
    })
  return numbers
}

export async function log(root: RepoRef, limit: number): Promise<GitLog> {
  // `--topo-order` because the default is date order, and date order interleaves
  // two branches by when someone happened to commit — drawing a line that
  // crosses itself for no reason a reader can see. `--branches` because a graph
  // of one branch is a straight line, and the branches and merges a human makes
  // in their own repository are the shape this view exists to show. HEAD is
  // named as well, so a detached checkout still appears in its own history.
  //
  // One extra, so "is there more history" is an answer rather than a guess made
  // from whether the page came back full.
  //
  // The numbering is asked for alongside rather than after: it reads different
  // refs and shares nothing with the page, so making it wait would spend a
  // round trip to Windows' process table for no ordering that matters.
  const [out, numbers] = await Promise.all([
    gitOr("", () =>
      git(root, [
        "log",
        `-n${limit + 1}`,
        "--topo-order",
        "--decorate=full",
        FORMAT,
        "HEAD",
        "--branches",
      ]),
    ),
    firstParentNumbers(root, limit),
  ])
  const all = out.split("\n").map(parseCommit).filter((c): c is GitCommit => c !== null)
  const commits = all.slice(0, limit)
  // Built from the page rather than from `all`: the one extra commit exists to
  // answer "is there more", and letting it open a lane would draw a line for a
  // row that is not on the screen.
  const { graph, lanes } = buildGraph(commits)
  return { commits, more: all.length > limit, graph, lanes, numbers }
}

/**
 * A sha, and nothing that could be mistaken for an option.
 *
 * This value arrives from the URL. Without the check, a hash of
 * `--upload-pack=<anything>` reaches `git show` as a flag rather than as a
 * revision, and git is an excellent tool for running arbitrary programs once it
 * is allowed to choose its own arguments. Hex only, so there is no argument to
 * have.
 */
export const isSha = (v: string): boolean => /^[0-9a-f]{4,40}$/i.test(v)

export async function commitDetail(root: RepoRef, sha: string): Promise<GitCommitDetail | null> {
  if (!isSha(sha)) return null

  const line = await gitOr("", () => git(root, ["log", "-1", "--decorate=full", FORMAT, sha]))
  const commit = parseCommit(line.split("\n")[0] ?? "")
  if (!commit) return null

  const message = await gitOr("", () => git(root, ["log", "-1", "--format=%B", sha]))

  // `-m --first-parent` is what makes a merge show anything at all. Plain
  // `git show` on a merge prints a combined diff, which is empty whenever the
  // merge resolved cleanly — so without these two flags every cleanly merged
  // branch appears here as a commit that changed no files. On an ordinary commit
  // they do nothing.
  const shown = ["show", "--format=", "-m", "--first-parent", sha]
  const stat = await gitOr("", () => git(root, [...shown, "--stat"]))
  const diff = await gitOr("", () => git(root, [...shown, "--patch"]))

  return { commit, message: message.trimEnd(), stat: stat.trim(), diff }
}
