/**
 * Reading a project's own git history.
 *
 * Distinct from the task-worktree types next door: those describe work aide is
 * doing, this describes the repo the work lands in. Both ends compile from these
 * definitions, so the daemon cannot rename a field without the web build saying
 * so.
 *
 * Everything here is a plain string or number on purpose — no Date, no Buffer.
 * These cross the wire as JSON and a revived Date would only ever be re-rendered
 * as text anyway.
 */

/** One half of a porcelain status code, named. */
export type GitFileState =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "type-changed"
  | "untracked"
  | "ignored"
  | "conflicted"
  | "unknown"

export interface GitFileChange {
  path: string
  /** The old path, for renames and copies. Null otherwise. */
  from: string | null
  /** The index half of the status code — what a plain `git commit` would take. */
  staged: GitFileState | null
  /** The working-tree half — what is edited but not staged. */
  unstaged: GitFileState | null
  /** The raw XY code, so an exotic combination is still legible in the UI. */
  code: string
}

export interface GitOverview {
  /** Absolute path to the repo root, so the UI never has to guess where it is. */
  root: string
  /** Null when HEAD is detached — the UI shows the sha instead. */
  branch: string | null
  /** Short sha of HEAD, or null in a repo with no commits yet. */
  head: string | null
  /** e.g. `origin/main`, or null when the branch tracks nothing. */
  upstream: string | null
  ahead: number
  behind: number
  /** True before the first commit, when `git log` has nothing to answer with. */
  unborn: boolean
}

/** Counts only. The list column needs a badge, not a file list. */
export interface GitDirty {
  staged: number
  unstaged: number
  untracked: number
  conflicted: number
}

/**
 * A name pointing at a commit.
 *
 * Classified in the daemon, from `--decorate=full`, because the short form
 * cannot be told apart by looking: `aide/task-0004` is a local branch and
 * `origin/main` is a remote one, and both are "a name with a slash in it". aide
 * creates branches with slashes in them by design, so a guess from the shape of
 * the name would mislabel every branch aide made itself.
 */
export interface GitRef {
  /** Short, as you would type it: `main`, `origin/main`, `v1.2`. */
  name: string
  kind: "branch" | "remote" | "tag"
  /** The one that is checked out — git's `HEAD -> `. */
  head: boolean
}

export interface GitCommit {
  sha: string
  short: string
  author: string
  authorEmail: string
  /** ISO 8601, with the author's own offset preserved. */
  date: string
  /** Branches, remotes and tags pointing here. */
  refs: GitRef[]
  parents: string[]
  subject: string
  /**
   * Board row ids from `Aide-Row` trailers. This is what makes history navigable
   * back to the task that asked for a commit, which is the whole reason
   * `withTrailers` writes them.
   */
  rows: string[]
}

/**
 * One line of the drawn history: which column it runs in, and in which colour.
 *
 * `color` is an index, not a colour. The wire has no business carrying hex, and
 * an index is what lets a branch line keep its colour for as long as it lives
 * instead of changing halfway down the page.
 */
export interface GitLane {
  lane: number
  color: number
}

/**
 * How one row of the log is drawn.
 *
 * Computed here rather than in the browser because a lane is a property of the
 * PAGE, not of the commit: ask for fifty commits instead of a hundred and the
 * same commit sits in a different column, and paging is the daemon's business.
 * It is also the half of this feature that can be wrong in a way nobody sees —
 * so it lives where `pnpm smoke` can reach it.
 *
 * `sha` is repeated rather than left implicit so a row can be matched to its
 * commit instead of trusted to line up by index.
 */
export interface GitGraphRow {
  sha: string
  /** The column this commit's dot sits in. */
  lane: number
  color: number
  /** Lines that pass this row untouched, drawn top edge to bottom edge. */
  through: GitLane[]
  /**
   * Lines arriving from the top edge and ending at this dot — the commits that
   * have this one as a parent.
   *
   * Includes the commit's OWN lane, which is the ordinary case and easy to
   * forget: leave it out and every dot in the middle of a branch is drawn with
   * a gap above it. Empty only at a branch tip, where nothing above points here.
   */
  enters: GitLane[]
  /**
   * Lines leaving this dot for the bottom edge — its parents. The first keeps
   * the commit's own lane and colour, which is what makes a branch read as one
   * unbroken line; every other parent is a merge going back out. Empty for a
   * root commit, whose line simply stops.
   */
  leaves: GitLane[]
}

export interface GitLog {
  commits: GitCommit[]
  /** Whether history continues past the last entry — drives "load more". */
  more: boolean
  /** One row per commit, in the same order. */
  graph: GitGraphRow[]
  /** Widest point of the graph, so the column is reserved once and never jitters. */
  lanes: number
}

/** Everything the list column needs, in one request, cheap enough to poll. */
export interface GitSummary {
  overview: GitOverview
  dirty: GitDirty
  log: GitLog
}

/**
 * What has not been committed yet, in the scope a commit would actually take.
 *
 * Deliberately neither `GitDirty` nor `GitWorkingTree`. Counts cannot name a
 * file, and the working tree carries a whole patch, which is far too much to
 * poll on every beat — this is the middle, enough to say "these three files"
 * without reading any of their contents.
 *
 * `files` EXCLUDES `.aide/todos.md`. The daemon rewrites that file in the same
 * tree as rows open and close, so it is dirty almost permanently and is never
 * committable; counting it would leave every aide-managed project showing
 * uncommitted work forever — and since a new conversation is refused while this
 * list is non-empty, the block would never lift.
 */
export interface GitPending {
  /** Null when HEAD is detached — the indicator says so rather than guessing. */
  branch: string | null
  files: GitFileChange[]
}

export interface GitWorkingTree {
  /**
   * Carried along because the working tree cannot be described without it —
   * "3 files changed" means something different on `main` than on a task branch
   * — and because the daemon has to read it anyway to know whether there is a
   * HEAD to diff against. A second request for it would be a second poll.
   */
  overview: GitOverview
  files: GitFileChange[]
  /** Tracked changes and new files as one patch, ready for the diff renderer. */
  diff: string
  /**
   * Untracked files deliberately left out of `diff`, with the reason. Reported
   * rather than dropped: a diff that silently omits a file reads as "nothing
   * changed there", which is the one thing a review surface must never say.
   */
  omitted: { path: string; why: string }[]
}

export interface GitCommitDetail {
  commit: GitCommit
  /** The full message, subject included. */
  message: string
  /** `--stat` output. */
  stat: string
  diff: string
}
