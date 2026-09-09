import { access } from "node:fs/promises"
import { join } from "node:path"
import {
  git,
  gitOr,
  refHost,
  refRoot,
  withMessageFile,
  withWorkingTreeIndex,
  type RepoRef,
} from "./git.js"

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
export async function treeChanges(root: RepoRef): Promise<TreeChanges> {
  // Resolved to a sha rather than passed as the name `HEAD`, and omitted
  // entirely when it does not resolve. `diff --cached` with no revision is
  // git's own spelling of "against the empty tree", which is the only baseline
  // a repository with no commits has — naming HEAD there is a fatal rather than
  // an empty diff, so the first commit in a fresh repo could never be made.
  const head = await gitOr("", async () =>
    (await git(root, ["rev-parse", "--verify", "HEAD"])).trim(),
  )
  const base = head ? [head] : []

  // One round trip for all three, not three. They are three readings of the same
  // staged tree, so batching them cannot make them disagree — and on a remote
  // project each one was its own ssh handshake at ~1.4s. This is the commit
  // gate's FIRST step, which is where `did not answer \`git diff\` within 90s`
  // came from: eight serial connections against a host that starts refusing them
  // past `MaxStartups` while the rail polls it every 1500ms.
  return await withWorkingTreeIndex(root, async (_gitTemp, batchTemp) => {
    const [diff, stat, names] = await batchTemp([
      ["diff", "--cached", ...base, "--"],
      ["diff", "--cached", "--stat", ...base, "--"],
      ["diff", "--cached", "--name-only", "-z", ...base, "--"],
    ])
    return { diff: diff ?? "", stat: stat ?? "", paths: splitZ(names ?? "") }
  })
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
export async function runChanges(root: RepoRef, checkpoint: string): Promise<RunChanges> {
  // Batched for the same reason as `treeChanges` above: one round trip for three
  // readings of one staged tree.
  const { diff, stat, paths } = await withWorkingTreeIndex(root, async (_gitTemp, batchTemp) => {
    const [d, s, names] = await batchTemp([
      // The trailing `--` is not a leftover: it tells git the argument before it
      // is a revision, so a file whose name happens to look like the checkpoint
      // sha cannot turn this into "ambiguous argument".
      ["diff", "--cached", checkpoint, "--"],
      ["diff", "--cached", "--stat", checkpoint, "--"],
      ["diff", "--cached", "--name-only", "-z", checkpoint, "--"],
    ])
    return { diff: d ?? "", stat: s ?? "", paths: splitZ(names ?? "") }
  })

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
export async function recentSubjects(root: RepoRef, n = 10): Promise<string[]> {
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
  root: RepoRef,
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
  // "is it on disk", asked of the machine that HAS the disk. Locally this is a
  // `stat` per path; remotely a `stat` here would be answering about a path that
  // does not exist on this machine and would call every file deleted. One git
  // call answers it for the whole list, and `--others` plus `--cached` is
  // exactly "tracked, or present and untracked" — which is what being on disk
  // means to the staging decision below.
  const onDisk = refHost(root)
    ? await matching(root, paths, ["ls-files", "-z", "--cached", "--others"])
    : null

  const stageable: string[] = []
  const committable: string[] = []
  for (const path of paths) {
    // On disk covers what the run created; in the index covers what it edited or
    // deleted without staging — an unstaged deletion still has its index entry,
    // and `add -A` is what turns that into a staged one. A path in neither is
    // one the run removed with `git rm`: the deletion is already staged exactly
    // right, and `add` would only fatal over it.
    const staged =
      inIndex.has(path) || (onDisk ? onDisk.has(path) : await exists(join(refRoot(root), path)))
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

  // The message file is written wherever git will READ it, which for a remote
  // project is not this machine — see `withMessageFile`, and the commit that
  // died on a Windows temp path quoted at a Linux box.
  await withMessageFile(root, message, (file) =>
    // One call, so the commit is atomic. If the pathspec list is too long for a
    // single command line this throws rather than committing a subset — a
    // partial commit of a reviewed change is worse than a failed one.
    git(root, ["commit", "-F", file, "--cleanup=whitespace", "--", ...committable]),
  )
  return (await git(root, ["rev-parse", "HEAD"])).trim()
}

/**
 * Send this branch to its upstream.
 *
 * A separate act from committing, deliberately. Committing is the gate — you
 * read the diff and decide — and pushing is what happens to a decision that has
 * already been made, so collapsing them into one button would put an outward
 * step behind the review's own press. They are two buttons, and the checkbox
 * that chains them is a choice made per press rather than a setting.
 *
 * `--set-upstream` on the CURRENT branch name when there is no upstream yet,
 * which is the first push of a new branch and the case where a bare `git push`
 * says "fatal: The current branch has no upstream branch" and tells you to type
 * exactly this. Doing it for you is the difference between a button and a
 * suggestion.
 *
 * Not `--force`, not `--force-with-lease`, not ever. A push that needs force is
 * a history rewrite, which is a decision with no undo — the checkpoint refs are
 * local, so they cannot recover somebody else's clone. That one stays in a
 * terminal, where the person doing it has to type what they mean.
 */
export async function pushBranch(
  root: RepoRef,
  /** From `GitPending.ahead`: null means no upstream, so this sets one. */
  hasUpstream: boolean,
): Promise<{ branch: string; pushed: number }> {
  const branch = await currentBranch(root)
  if (!branch || branch === "HEAD") {
    throw new Error("HEAD is detached — check out a branch before pushing")
  }

  // Counted BEFORE the push, because afterwards the answer is always zero and
  // the run's own log would have nothing to say about what it did.
  const ahead = await gitOr(0, async () => {
    const out = await git(root, ["rev-list", "--count", "HEAD", "--not", "--remotes"])
    return Number(out.trim()) || 0
  })

  await git(root, hasUpstream ? ["push"] : ["push", "--set-upstream", "origin", branch])
  return { branch, pushed: ahead }
}

/**
 * The message a squash writes: the first auto-commit's subject on top, every
 * subject underneath, and the conversations they came from as trailers.
 *
 * The FIRST subject and not the last, because with one-commit-per-turn the
 * first is the turn that started the piece of work and the ones after it are
 * fixes and follow-ups — the same reason a PR takes its title from the branch's
 * opening commit. Every subject survives in the body, so nothing the
 * auto-commits said is lost to the squash; the `Aide-Session` trailers are
 * collected the same way, or squashing would cut the one link from history back
 * to the transcripts that explain it.
 *
 * Pure and exported for `pnpm smoke`.
 */
export function squashMessage(
  subjects: readonly string[],
  sessionIds: readonly string[],
): string {
  const first = subjects[0]?.trim() || "squashed work"
  const subject = first.length > 72 ? `${first.slice(0, 71).trimEnd()}…` : first
  const body = subjects.map((s) => `- ${s}`).join("\n")
  return appendTrailers(
    `${subject}\n\n${body}`,
    sessionIds.map((id) => ["Aide-Session", id] as [string, string]),
  )
}

/**
 * Fold everything ahead of the upstream into one commit, then push it.
 *
 * The push button's second option, for a branch that accumulated one
 * auto-commit per turn: land it upstream as one change instead of a dozen
 * steps. No force and no rewrite of anything published — only commits that
 * have never left this machine are folded, and the result is a fast-forward
 * for the remote exactly as the original stack was.
 *
 * The fold is built OFF TO THE SIDE and only then swapped in. `commit-tree`
 * writes the squashed commit — HEAD's own tree, parented on the upstream —
 * without touching HEAD, the index or the working files, and `update-ref` with
 * the old value as its third argument is a compare-and-swap: if anything moved
 * the branch in between, the swap fails and NOTHING has changed. The previous
 * version did `reset --soft` in place, which had a window where the branch was
 * rewound and the squash commit did not exist yet; a hook refusing the commit
 * in that window needed an ORIG_HEAD rollback, and a crash in it lost the
 * branch position outright. Nothing here needs rolling back because nothing is
 * ever half-done.
 *
 * A dirty working tree is refused outright. The tree's files would survive a
 * squash untouched, but a squash under uncommitted work is exactly where "what
 * happened to my changes" confusion starts — and with auto-commit sweeping the
 * tree every turn, dirty-at-push is the exceptional case, not the normal one.
 *
 * With one commit ahead there is nothing to fold, and with none this is a plain
 * push; both fall through rather than refusing, because the button says "push"
 * first and "squash" second.
 */
export async function squashAndPush(
  root: RepoRef,
  /** Test seam: runs between building the squash commit and the ref swap. */
  hooks?: { beforeSwap?: () => Promise<void> },
): Promise<{ branch: string; pushed: number; squashed: number }> {
  const branch = await currentBranch(root)
  if (!branch || branch === "HEAD") {
    throw new Error("HEAD is detached — check out a branch before squashing")
  }
  if ((await git(root, ["status", "--porcelain"])).trim()) {
    throw new Error(
      "the working tree has uncommitted changes — a squash rewrites the branch, so it " +
        "waits until the next turn's auto-commit has swept them",
    )
  }

  const range = "@{upstream}..HEAD"
  const subjects = (await git(root, ["log", "--reverse", "--pretty=%s", range]))
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
  if (subjects.length < 2) {
    return { ...(await pushBranch(root, true)), squashed: 0 }
  }

  const sessionIds = [
    ...new Set(
      (await git(root, ["log", "--pretty=%(trailers:key=Aide-Session,valueonly)", range]))
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ]

  // HEAD's tree by name, not `write-tree` from the index: the porcelain check
  // above makes the two identical, and naming HEAD's removes the index from the
  // dependency list entirely.
  const oldHead = (await git(root, ["rev-parse", "HEAD"])).trim()
  const upstream = (await git(root, ["rev-parse", "@{upstream}"])).trim()
  const tree = (await git(root, ["rev-parse", "HEAD^{tree}"])).trim()
  const squashed = (
    await withMessageFile(root, squashMessage(subjects, sessionIds), (file) =>
      git(root, ["commit-tree", tree, "-p", upstream, "-F", file]),
    )
  ).trim()

  await hooks?.beforeSwap?.()

  // The swap. `<old>` as the third argument means "only if the branch still
  // points where I read it" — a commit that landed concurrently fails this
  // rather than being silently discarded, and the squash commit it strands is
  // an unreferenced object git will collect.
  await git(root, ["update-ref", `refs/heads/${branch}`, squashed, oldHead])

  return { ...(await pushBranch(root, true)), squashed: subjects.length }
}

/**
 * Commit the human's own edits, before a turn begins — the pre-turn sweep.
 *
 * A turn's auto-commit takes the whole working tree, so edits made in an editor
 * between turns would land inside the next turn's commit, attributed to work
 * that never made them. Sweeping them into a commit of their own first keeps
 * the attribution exact: the turn's commit contains the turn's work.
 *
 * Deliberately NOT gated on the project's checks and carrying no session
 * trailer. The gate exists to stop a model landing broken code; these edits are
 * the human's, already on disk and already true, and refusing to record them
 * would only smear them into the next commit anyway. The subject is fixed and
 * the body is the file list, because there is no turn to lend a headline and
 * nothing here is worth a model call.
 *
 * Null when the tree is clean, which is the common case.
 *
 * `known` is the caller's own answer to "is the tree dirty", when it has one —
 * a conversation's first send learns it from the checkpoint's tree capture, so
 * paying a `git status` (an ssh connection, on a remote project) to re-ask
 * would be the second walk that capture exists to remove. `false` returns
 * immediately, `true` skips the status and goes straight to reading what is
 * dirty, and absent falls back to asking git.
 */
export async function sweepManualEdits(
  root: RepoRef,
  known?: boolean,
): Promise<{ sha: string; paths: string[] } | null> {
  if (known === false) return null
  if (known === undefined && !(await git(root, ["status", "--porcelain"])).trim()) return null
  // The same reading a commit takes — scratch index, renames and untracked
  // handled — so the sweep and the rail can never disagree about what "dirty"
  // means.
  const changes = await treeChanges(root)
  if (changes.paths.length === 0) return null
  const message = ["manual edits", "", ...changes.paths.map((p) => `  ${p}`)].join("\n")
  const sha = await commitRun(root, changes.paths, `${message}\n`)
  return { sha, paths: [...changes.paths] }
}

const exists = (path: string) => access(path).then(() => true, () => false)

/**
 * Which of `paths` the given lister still knows about.
 *
 * Chunked for the same reason the `add` below is: one pathspec per file is a
 * long command line, and Windows caps one at about 32k characters.
 */
async function matching(
  root: RepoRef,
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
export async function currentBranch(root: RepoRef): Promise<string> {
  return (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()
}
