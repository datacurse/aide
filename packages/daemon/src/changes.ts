import { rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { STATE_DIR } from "@aide/protocol"
import { git, gitOr, withWorkingTreeIndex } from "./git.js"

/**
 * What a run changed, and committing it.
 *
 * The unit used to be a worktree, and that made this file easy: the checkout
 * started clean, so everything in it was the agent's work by construction.
 * Working in the project's own tree removes that guarantee, and everything below
 * exists to put it back — the run's changes are measured against the checkpoint
 * taken before it started, never against HEAD.
 *
 * The invariant this file is here to hold is unchanged, and is worth restating
 * because it is the whole point of the review gate: the diff the human reads and
 * the paths the commit stages must be derived from the same computation. If they
 * disagree, the human approves one change and commits another.
 */

// ---------------------------------------------------------------------------
// Whose files are whose
// ---------------------------------------------------------------------------

/**
 * The parts of `.aide/` the DAEMON writes, excluded from everything the agent is
 * allowed to stage.
 *
 * `todos.md` is the whole list, and the reason it is excluded got SHARPER when
 * runs moved into the main checkout rather than going away. It used to be a
 * stale-branch problem: a conversation's own copy, committed on a branch and
 * merged later, would write an out-of-date backlog back over the live one. Now
 * the daemon rewrites this file in the SAME tree the agent is working in, as
 * rows are added and verdicts close them — so committing whatever the file
 * happened to contain mid-run is a straight race with the daemon's own writes,
 * and the loser is whichever one the human did not mean.
 *
 * `spec.md` and `project.md` are deliberately NOT excluded. The spec is written
 * at the commit gate on purpose, so the claim and the code that earns it are one
 * commit and one revert; see `review.ts`.
 *
 * `:(top,...)` anchors the pattern to the repo root rather than to cwd.
 */
const AGENT_SCOPE = [".", `:(top,exclude)${STATE_DIR}/todos.md`] as const

/**
 * Same pathspec, appended after a `--`.
 *
 * Exported because the uncommitted-work indicator has to ask its question in
 * exactly this scope. An indicator that counted `todos.md` would be permanently
 * lit on any project aide manages, and nothing a human could do would put it
 * out — the daemon rewrites that file, and a commit is forbidden from taking it.
 */
export const scoped = (args: string[]): string[] => [...args, "--", ...AGENT_SCOPE]

// ---------------------------------------------------------------------------
// What the run did
// ---------------------------------------------------------------------------

export interface RunChanges {
  /** The patch the human reviews: exactly what the run changed. */
  diff: string
  /** `--stat` of the same. Cheap context for the drafter. */
  stat: string
  /** Repo-relative paths in `diff`. Exactly what a commit will stage. */
  paths: string[]
  /**
   * Paths that were ALREADY modified when the checkpoint was taken — the human's
   * own uncommitted work at the moment the run started.
   */
  preexisting: string[]
  /**
   * In both lists: the run edited a file the human had already changed.
   *
   * Git cannot separate two people's edits inside one file, so aide does not
   * pretend to. These are named in the review so the decision is the human's.
   */
  overlap: string[]
}

/**
 * Everything the run changed, measured against its checkpoint.
 *
 * `diff --cached <checkpoint-tree>` against a scratch index that reflects disk,
 * rather than the obvious `git diff <checkpoint-tree>`. The obvious form is
 * wrong in both directions and quietly so — measured on a tree with one
 * pre-existing untracked file and one file the run created, it reported the
 * human's untracked file as DELETED (it is in the checkpoint tree but not in the
 * real index) and omitted the run's new file entirely.
 *
 * It also replaces the `add -A -N` the worktree version used to run. Intent-to-
 * add was safe when the tree belonged to aide; against the human's own checkout
 * it changes what `git status` prints in their terminal, mid-review, for files
 * they never asked aide to touch.
 *
 * One pass for the patch, the stat and the paths: each is a read of the same
 * staged tree, and the `add -A` behind it is the expensive part.
 */
export async function runChanges(root: string, checkpoint: string): Promise<RunChanges> {
  const { diff, stat, paths } = await withWorkingTreeIndex(root, async (gitTemp) => ({
    diff: await gitTemp(scoped(["diff", "--cached", checkpoint])),
    stat: await gitTemp(scoped(["diff", "--cached", "--stat", checkpoint])),
    paths: splitZ(await gitTemp(scoped(["diff", "--cached", "--name-only", "-z", checkpoint]))),
  }))

  // Against the checkpoint's own PARENT rather than HEAD. They are the same
  // commit right now, but reading it off the checkpoint means this stays correct
  // if HEAD ever moves while a conversation is open — and it degrades to "no
  // pre-existing dirt" in a repo with no commits, where the checkpoint is
  // parentless and there is nothing it could have been dirty against.
  const preexisting = await gitOr([], async () =>
    splitZ(await git(root, scoped(["diff", "--name-only", "-z", `${checkpoint}^`, checkpoint]))),
  )

  const before = new Set(preexisting)
  return { diff, stat, paths, preexisting, overlap: paths.filter((p) => before.has(p)) }
}

/** `-z` output: NUL-terminated, so nothing is quoted and no path needs unescaping. */
const splitZ = (out: string): string[] => out.split("\0").filter(Boolean)

// ---------------------------------------------------------------------------
// Committing
// ---------------------------------------------------------------------------

/**
 * The last `n` commit subjects. Fed to the commit-message drafter as house
 * style: a repo that writes `fix(parser): ...` and a repo that writes
 * `Fix the parser` are both right, neither is guessable from the diff, and both
 * are obvious from the log.
 */
export async function recentSubjects(root: string, n = 10): Promise<string[]> {
  try {
    const out = await git(root, ["log", `-n${n}`, "--format=%s"])
    return out.split("\n").map((l) => l.trim()).filter(Boolean)
  } catch {
    // A repo with no commits yet has no house style to copy.
    return []
  }
}

/**
 * Commit exactly `paths`, and nothing else.
 *
 * Two things make this different from the `git add -A` the worktree version ran,
 * and both are consequences of the tree now belonging to the human:
 *
 * 1. **Staging is limited to the paths the human just reviewed.** A blanket
 *    `add -A` would sweep in every stray file in the project — a scratch script,
 *    an unignored build artefact, a half-written note — none of which appeared
 *    in the diff that was approved.
 * 2. **The commit names those paths too**, which is what stops it taking
 *    whatever the human had independently staged in their own index. Verified:
 *    with an unrelated file staged by hand, the commit carries the run's three
 *    paths and leaves the staged one staged.
 *
 * The message goes via a temp file rather than `-m`: commit messages are
 * multi-line by design, and a file is the one way to pass one that behaves the
 * same on every platform. `--cleanup=whitespace` trims blank edges but keeps `#`
 * lines, so a message referencing `#123` at the start of a line survives.
 *
 * Hooks are NOT skipped. A repo whose pre-commit hook rejects the agent's work
 * should reject it here too — that is the hook doing its job.
 */
export async function commitRun(
  root: string,
  paths: readonly string[],
  message: string,
): Promise<string> {
  if (!message.trim()) throw new Error("commit message is empty")
  if (paths.length === 0) {
    throw new Error("nothing to commit — the run left the working tree unchanged")
  }

  const specs = paths.map((p) => `:(top,literal)${p}`)
  // Chunked because a pathspec per file is a long command line and Windows caps
  // one at about 32k characters. A run that touched three hundred files is
  // unusual and must not fail at the last step.
  for (const chunk of chunked(specs)) {
    await git(root, ["add", "-A", "--", ...chunk])
  }

  const file = join(tmpdir(), `aide-commitmsg-${process.pid}-${Date.now()}`)
  await writeFile(file, message.endsWith("\n") ? message : `${message}\n`, "utf8")
  try {
    // One call, so the commit is atomic. If the pathspec list is too long for a
    // single command line this throws rather than committing a subset — a
    // partial commit of a reviewed change is worse than a failed one.
    await git(root, ["commit", "-F", file, "--cleanup=whitespace", "--", ...specs])
  } finally {
    await rm(file, { force: true })
  }
  return (await git(root, ["rev-parse", "HEAD"])).trim()
}

/** Pathspecs grouped so no single command line gets near the platform limit. */
function chunked(specs: readonly string[], maxChars = 6_000): string[][] {
  const out: string[][] = []
  let current: string[] = []
  let length = 0
  for (const spec of specs) {
    if (current.length > 0 && length + spec.length > maxChars) {
      out.push(current)
      current = []
      length = 0
    }
    current.push(spec)
    length += spec.length + 1
  }
  if (current.length > 0) out.push(current)
  return out
}

// ---------------------------------------------------------------------------
// Trailers
// ---------------------------------------------------------------------------

/**
 * `Aide-Session` is the durable one: a conversation outlives any single run, and
 * the session id is what finds its transcript under `~/.claude/projects/` later.
 * `Aide-Row` says which backlog line asked for the change — that line is deleted
 * when the work is closed, so the commit becomes the only place it survives.
 */
export function withRowTrailers(message: string, rowId: string | null, sessionId: string): string {
  return appendTrailers(message, [
    ...(rowId ? ([["Aide-Row", rowId]] as [string, string][]) : []),
    ["Aide-Session", sessionId],
  ])
}

/** Appends `Key: value` lines, unless the message already carries the first key. */
function appendTrailers(message: string, entries: readonly [string, string][]): string {
  const body = message.trimEnd()
  const first = entries[0]
  if (!first) return `${body}\n`
  if (new RegExp(`^${first[0]}:`, "m").test(body)) return `${body}\n`
  return `${body}\n\n${entries.map(([k, v]) => `${k}: ${v}`).join("\n")}\n`
}

/** The branch checked out in the project's working directory. */
export async function currentBranch(root: string): Promise<string> {
  return (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()
}
