import { access, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { git, gitOr, withWorkingTreeIndex } from "./git.js"

/**
 * What is uncommitted, what a run changed, and committing either.
 *
 * Two readings, and the difference between them is the whole of this file.
 *
 * `treeChanges` asks what is uncommitted in the project, full stop. That is what
 * a commit takes and what the rail lights on, and it needs nothing but the repo.
 *
 * `runChanges` asks what ONE conversation did, measured against the checkpoint
 * taken before it started. The unit used to be a worktree, which answered that
 * for free — the checkout started clean, so everything in it was the agent's
 * work by construction — and the checkpoint is what puts the answer back now
 * that runs work the project's own tree.
 *
 * Which reading belongs where took a bug to settle. The commit was measured
 * against a conversation while the block on starting a new one was measured
 * against the repository, so a tree dirtied by anything that is not a
 * conversation — your own editor, a formatter, an install that rewrote a
 * lockfile — blocked every new chat and had no button in aide that would clear
 * it. A gate whose precondition and whose release read two different objects can
 * wedge, and that one did. So the commit reads the tree, and the conversation
 * reading is for the diff you go and read.
 *
 * The invariant both share is the point of the review gate: the diff the human
 * reads and the paths the commit stages must be derived from the same
 * computation. If they disagree, the human approves one change and commits
 * another.
 */

// ---------------------------------------------------------------------------
// What is uncommitted
// ---------------------------------------------------------------------------

/** What a commit would take: everything uncommitted, however it got that way. */
export interface TreeChanges {
  /** The patch the human reviews. */
  diff: string
  /** `--stat` of the same. Cheap context for the drafter. */
  stat: string
  /** Repo-relative paths in `diff`. Exactly what a commit will stage. */
  paths: string[]
}

/**
 * Everything uncommitted in the working tree, measured against HEAD.
 *
 * The commit's own reading, and deliberately not a conversation's — see the
 * header for the wedge that came of measuring it against one.
 *
 * Same one-pass shape as `runChanges` below and for the same reason: the patch,
 * the stat and the paths are three reads of one staged tree, so what is reviewed
 * and what is staged cannot drift apart.
 *
 * This must agree with `repo.pending`, which is what the rail draws and what the
 * new-chat block reads. Both come off a scratch `add -A`/`git status` over the
 * same tree, so both honour `.gitignore` and both count a file the human staged
 * by hand — a file that could sit in the rail and not be committable would be a
 * block with no way out of it, which is the bug this function exists to close.
 *
 * One state they do not agree on, and it is nothing aide can reach: a hand-run
 * `git rm --cached` leaves a file that `status` reports twice, as a staged
 * deletion and as untracked, while the `add -A` here simply puts it back. The
 * commit then reports nothing to do. It is a legible refusal rather than a wrong
 * commit, and undoing it is the `git add` the human was already halfway through.
 */
export async function treeChanges(root: string): Promise<TreeChanges> {
  // Resolved to a sha rather than passed as the name `HEAD`, and omitted
  // entirely when it does not resolve. `diff --cached` with no revision is
  // git's own spelling of "against the empty tree", which is the only baseline
  // a repository with no commits has — naming HEAD there is a fatal rather than
  // an empty diff, so the first commit in a fresh repo could never be made.
  const head = await gitOr("", async () =>
    (await git(root, ["rev-parse", "--verify", "HEAD"])).trim(),
  )
  const base = head ? [head] : []

  return await withWorkingTreeIndex(root, async (gitTemp) => ({
    diff: await gitTemp(["diff", "--cached", ...base, "--"]),
    stat: await gitTemp(["diff", "--cached", "--stat", ...base, "--"]),
    paths: splitZ(await gitTemp(["diff", "--cached", "--name-only", "-z", ...base, "--"])),
  }))
}

// ---------------------------------------------------------------------------
// What the run did
// ---------------------------------------------------------------------------

export interface RunChanges extends TreeChanges {
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
    // The trailing `--` is not a leftover: it tells git the argument before it
    // is a revision, so a file whose name happens to look like the checkpoint
    // sha cannot turn this into "ambiguous argument".
    diff: await gitTemp(["diff", "--cached", checkpoint, "--"]),
    stat: await gitTemp(["diff", "--cached", "--stat", checkpoint, "--"]),
    paths: splitZ(await gitTemp(["diff", "--cached", "--name-only", "-z", checkpoint, "--"])),
  }))

  // Against the checkpoint's own PARENT rather than HEAD. They are the same
  // commit right now, but reading it off the checkpoint means this stays correct
  // if HEAD ever moves while a conversation is open — and it degrades to "no
  // pre-existing dirt" in a repo with no commits, where the checkpoint is
  // parentless and there is nothing it could have been dirty against.
  const preexisting = await gitOr([], async () =>
    splitZ(await git(root, ["diff", "--name-only", "-z", `${checkpoint}^`, checkpoint, "--"])),
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
    throw new Error("nothing to commit — the working tree matches the last commit")
  }

  // Where git can still see each path. A path list is read before the project's
  // checks run and committed after them, so it can name a file that has since
  // stopped existing anywhere git looks — and git answers a pathspec matching
  // nothing by refusing the whole command, which is how one already-landed
  // deletion took a commit of nine other files down with it.
  const inIndex = await matching(root, paths, ["ls-files", "-z"])
  const inHead = await gitOr(new Set<string>(), () =>
    matching(root, paths, ["ls-tree", "-r", "-z", "--name-only", "HEAD"]),
  )

  const stageable: string[] = []
  const committable: string[] = []
  for (const path of paths) {
    // On disk covers what the run created; in the index covers what it edited or
    // deleted without staging — an unstaged deletion still has its index entry,
    // and `add -A` is what turns that into a staged one. A path in neither is
    // one the run removed with `git rm`: the deletion is already staged exactly
    // right, and `add` would only fatal over it.
    const staged = inIndex.has(path) || (await exists(join(root, path)))
    if (staged) stageable.push(`:(top,literal)${path}`)
    // `commit` reaches one step further back: it can record a path that is gone
    // from the index and the worktree, as long as HEAD still has it to delete.
    // A path missing from all three is a deletion some EARLIER commit already
    // took — nothing about it is left to record, and naming it only makes git
    // refuse.
    if (staged || inHead.has(path)) committable.push(`:(top,literal)${path}`)
  }
  if (committable.length === 0) {
    throw new Error("nothing to commit — every path in the diff has already been committed")
  }

  // Chunked because a pathspec per file is a long command line and Windows caps
  // one at about 32k characters. A run that touched three hundred files is
  // unusual and must not fail at the last step.
  for (const chunk of chunked(stageable)) {
    await git(root, ["add", "-A", "--", ...chunk])
  }

  const file = join(tmpdir(), `aide-commitmsg-${process.pid}-${Date.now()}`)
  await writeFile(file, message.endsWith("\n") ? message : `${message}\n`, "utf8")
  try {
    // One call, so the commit is atomic. If the pathspec list is too long for a
    // single command line this throws rather than committing a subset — a
    // partial commit of a reviewed change is worse than a failed one.
    await git(root, ["commit", "-F", file, "--cleanup=whitespace", "--", ...committable])
  } finally {
    await rm(file, { force: true })
  }
  return (await git(root, ["rev-parse", "HEAD"])).trim()
}

const exists = (path: string) => access(path).then(() => true, () => false)

/**
 * Which of `paths` the given lister still knows about.
 *
 * Chunked for the same reason the `add` below is: one pathspec per file is a
 * long command line, and Windows caps one at about 32k characters.
 */
async function matching(
  root: string,
  paths: readonly string[],
  lister: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>()
  for (const chunk of chunked(paths.map((p) => `:(top,literal)${p}`))) {
    for (const path of splitZ(await git(root, [...lister, "--", ...chunk]))) found.add(path)
  }
  return found
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
 * Stamp the commit with the conversation that produced it, if one did.
 *
 * One trailer, because there is one thing worth pointing back at. There used to
 * be an `Aide-Row` beside it naming a backlog row; in the whole history of this
 * project not one commit ever carried one, which is as clear a verdict on the
 * board as anything could be.
 *
 * Null is not a missing id, it is an honest answer: a commit can be pressed with
 * no conversation open, over work your editor made. Pointing that at whichever
 * chat happened to be on screen would be a lie in the permanent record, so it
 * points at nothing.
 */
export function withSessionTrailer(message: string, sessionId: string | null): string {
  if (!sessionId) return `${message.trimEnd()}\n`
  return appendTrailers(message, [["Aide-Session", sessionId]])
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
