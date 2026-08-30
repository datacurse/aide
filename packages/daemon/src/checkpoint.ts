import { git, gitOr, withWorkingTreeIndex, type RepoRef } from "./git.js"

/**
 * A snapshot of the working tree, taken before an agent is allowed to touch it.
 *
 * This is what replaces the worktree. A run used to be isolated by working on a
 * checkout of its own; now it works the project's own tree, and what makes that
 * survivable is that everything the tree contained a moment earlier is recorded
 * as a commit object you can restore from in one command.
 *
 * It does two jobs, and the second is the one that is easy to miss:
 *
 * 1. **Undo.** A run that went wrong is `git restore --source=<ref> --worktree`.
 * 2. **The diff baseline.** A worktree made "what did the agent do" free — the
 *    checkout started clean, so everything in it was the agent's. In the main
 *    checkout it is not free: `git diff HEAD` mixes the agent's work with
 *    whatever the human already had uncommitted. Diffing against the checkpoint
 *    is what separates them again, and without it the review gate would show one
 *    change and commit another.
 *
 * ## Why not `git stash`
 *
 * The porcelain `git stash` REVERTS the working tree. The human is watching a
 * dev server serve that tree; yanking their uncommitted work out from under it
 * to take a backup is the opposite of what a backup is for.
 *
 * `git stash create` does leave the tree alone — and silently omits untracked
 * files. Measured on a tree with one modified and one untracked file: it
 * captured one path, this captures both. An agent that overwrites a file you
 * created but had not added yet is exactly the case a checkpoint exists for, so
 * that omission is disqualifying rather than a detail.
 */

export interface Checkpoint {
  /** The snapshot commit. */
  sha: string
  /** `refs/aide/checkpoints/<key>` */
  ref: string
}

/**
 * Under `refs/aide/`, deliberately NOT `refs/heads/`.
 *
 * A checkpoint is not a branch and must not read as one: `refs/heads/` would put
 * it in `git branch`, and `repo.ts` logs `HEAD --branches`, so every snapshot
 * would draw itself into the graph the human reviews. Its own namespace is
 * invisible to both while still being a real ref, which is the part that
 * matters — an unreferenced commit object is garbage collectable, and a
 * checkpoint that evaporates is worse than none because you only find out when
 * you reach for it.
 */
const REF_PREFIX = "refs/aide/checkpoints/"

/**
 * Keys are run and session ids, which are UUIDs aide generates or the SDK does.
 * Checked anyway: this becomes a ref name, and `git update-ref` is happy to
 * create paths that later refuse to be deleted.
 */
const isKey = (key: string): boolean => /^[0-9a-fA-F-]{36}$/.test(key)

export function checkpointRef(key: string): string {
  if (!isKey(key)) throw new Error(`not a usable checkpoint key: ${key}`)
  return `${REF_PREFIX}${key}`
}

/**
 * Snapshot the working tree and record it under `key`.
 *
 * `-p HEAD` so the snapshot is diffable against the commit it came from, which
 * is what tells the review which files were ALREADY dirty when the run started.
 * A repo with no commits yet has no HEAD to parent to, and that is a real state
 * — a project added to aide before its first commit — so it snapshots parentless
 * rather than refusing.
 */
export async function takeCheckpoint(root: RepoRef, key: string): Promise<Checkpoint> {
  const ref = checkpointRef(key)

  const tree = await withWorkingTreeIndex(root, async (gitTemp) =>
    (await gitTemp(["write-tree"])).trim(),
  )

  const head = await gitOr<string | null>(null, async () =>
    (await git(root, ["rev-parse", "HEAD"])).trim(),
  )
  const sha = (
    await git(root, [
      "commit-tree",
      tree,
      ...(head ? ["-p", head] : []),
      "-m",
      `aide checkpoint ${key}`,
    ])
  ).trim()

  await git(root, ["update-ref", ref, sha])
  return { sha, ref }
}

export async function readCheckpoint(root: RepoRef, key: string): Promise<Checkpoint | null> {
  let ref: string
  try {
    ref = checkpointRef(key)
  } catch {
    return null
  }
  const sha = await gitOr("", async () => (await git(root, ["rev-parse", "--verify", ref])).trim())
  return sha ? { sha, ref } : null
}

/**
 * Hand a checkpoint taken under one key to another, without overwriting one that
 * is already there.
 *
 * This exists because a brand new conversation has no session id until the SDK
 * names it, which happens after the agent has started — and the snapshot has to
 * be taken BEFORE that or it is not a snapshot of anything useful. So the first
 * turn checkpoints under its run id and moves the ref across once the session
 * has a name.
 *
 * "Without overwriting" is the load-bearing half. A conversation's baseline is
 * the tree as it was when the conversation STARTED, not when its latest turn
 * did; re-pointing it every turn would make the review show only the last
 * message's work and silently drop everything the earlier turns wrote.
 */
export async function adoptCheckpoint(
  root: RepoRef,
  fromKey: string,
  toKey: string,
): Promise<Checkpoint | null> {
  const from = await readCheckpoint(root, fromKey)
  if (!from) return readCheckpoint(root, toKey)

  const existing = await readCheckpoint(root, toKey)
  if (!existing) {
    await git(root, ["update-ref", checkpointRef(toKey), from.sha])
  }
  await dropCheckpoint(root, fromKey)
  return existing ?? { sha: from.sha, ref: checkpointRef(toKey) }
}

/** Deleting the ref is all it takes: the commit object becomes unreachable. */
export async function dropCheckpoint(root: RepoRef, key: string): Promise<void> {
  const found = await readCheckpoint(root, key)
  if (!found) return
  await gitOr(null, async () => {
    await git(root, ["update-ref", "-d", found.ref])
    return null
  })
}

// ---------------------------------------------------------------------------
// Turn boundaries
// ---------------------------------------------------------------------------

/**
 * A restore point per turn, under `refs/aide/turns/<session>/<n>`.
 *
 * The conversation's checkpoint is taken once and deliberately never moves —
 * moving it would fold each turn's own work into the next turn's baseline, and
 * the review at the end would show only whatever the last message happened to
 * change. That is right for the diff and too coarse for undo: a five-turn
 * conversation whose third turn went wrong has exactly one place to rewind to,
 * and it is three turns further back than you wanted.
 *
 * So the baseline stays where it is and turn boundaries get a namespace of their
 * own. They are the same machinery — a tree written from a scratch index, a
 * commit object, a ref outside `refs/heads/` — and they are nearly free: the
 * trees share every unchanged blob with the checkpoint, so what a turn actually
 * costs is one ref and one commit.
 *
 * Chained, `<n>` parenting `<n-1>` and `1` parenting the conversation
 * checkpoint, so `git diff <n-1> <n>` is exactly what that one turn did rather
 * than something you subtract two conversation-wide diffs to get.
 */
const TURN_PREFIX = "refs/aide/turns/"

export interface TurnCheckpoint extends Checkpoint {
  /** 1-based, in the order the conversation's turns landed. */
  n: number
  /**
   * The tree this boundary recorded.
   *
   * Carried rather than looked up, because "did this turn change anything" is
   * a tree comparison and the alternative is another `rev-parse` per turn. On
   * Windows what this file costs is very nearly the number of git processes it
   * starts, and this runs while a conversation is holding its project's lock.
   */
  tree: string
}

export function turnRef(session: string, n: number): string {
  if (!isKey(session)) throw new Error(`not a usable checkpoint key: ${session}`)
  if (!Number.isInteger(n) || n < 1) throw new Error(`not a usable turn number: ${n}`)
  return `${TURN_PREFIX}${session}/${n}`
}

/** Every turn boundary a conversation has, oldest first. */
export async function listTurnCheckpoints(
  root: RepoRef,
  session: string,
): Promise<TurnCheckpoint[]> {
  if (!isKey(session)) return []
  const prefix = `${TURN_PREFIX}${session}/`
  const out = await gitOr("", () =>
    git(root, ["for-each-ref", "--format=%(objectname) %(tree) %(refname)", prefix]),
  )

  const found: TurnCheckpoint[] = []
  for (const line of out.split("\n")) {
    const [sha, tree, ref] = line.trim().split(" ")
    if (!sha || !tree || !ref?.startsWith(prefix)) continue
    const n = Number(ref.slice(prefix.length))
    if (!Number.isInteger(n) || n < 1) continue
    found.push({ sha, ref, n, tree })
  }

  // Sorted numerically rather than trusting `for-each-ref`, which sorts refnames
  // LEXICOGRAPHICALLY — 10 lands between 1 and 2. The last element is what the
  // next turn numbers itself from, so taking git's order would have a
  // conversation start renumbering from 2 on its tenth turn, over refs it
  // already had.
  return found.sort((a, b) => a.n - b.n)
}

/**
 * Mark where the tree stands now as the end of this conversation's next turn.
 *
 * Null when the tree is byte-identical to the previous boundary, which is the
 * ordinary outcome of asking a question: a conversation is mostly reading, and a
 * restore point per "what does this function do?" would bury the handful that
 * can actually be returned to.
 */
export async function takeTurnCheckpoint(
  root: RepoRef,
  session: string,
): Promise<TurnCheckpoint | null> {
  const turns = await listTurnCheckpoints(root, session)
  const last = turns.at(-1)
  const n = (last?.n ?? 0) + 1
  const ref = turnRef(session, n)

  // The conversation's own checkpoint is the parent of turn 1. It is normally
  // there — the snapshot is taken before the first message reaches an agent —
  // but a turn that somehow ends before its checkpoint was handed over to the
  // session id snapshots parentless rather than refusing, because a restore
  // point with an odd history still restores.
  const previous = last ?? (await baselineOf(root, session))

  const tree = await withWorkingTreeIndex(root, async (gitTemp) =>
    (await gitTemp(["write-tree"])).trim(),
  )

  if (previous?.tree === tree) return null

  const sha = (
    await git(root, [
      "commit-tree",
      tree,
      ...(previous ? ["-p", previous.sha] : []),
      "-m",
      `aide turn ${n} of ${session}`,
    ])
  ).trim()

  await git(root, ["update-ref", ref, sha])
  return { sha, ref, n, tree }
}

/**
 * The conversation checkpoint, with its tree, for turn 1 to parent and compare
 * against.
 *
 * Both out of ONE `rev-parse` rather than a `readCheckpoint` followed by a
 * `rev-parse ^{tree}`. Two names for two objects reads better and costs a second
 * process on the path that holds the lock.
 */
async function baselineOf(
  root: RepoRef,
  session: string,
): Promise<{ sha: string; tree: string } | null> {
  const ref = checkpointRef(session)
  const out = await gitOr("", () => git(root, ["rev-parse", ref, `${ref}^{tree}`]))
  const [sha, tree] = out.split("\n").map((l) => l.trim())
  return sha && tree ? { sha, tree } : null
}

/**
 * What to type to put the tree back. Shown rather than run: restoring over the
 * tree the human is looking at is their call, not a button aide presses.
 *
 * It restores what the run CHANGED and what it DELETED. It does not remove what
 * the run created — verified, and stated here rather than left to be discovered,
 * because "undo" that silently leaves half a dozen new files behind is worse
 * than a narrower promise. Deleting them would mean `git clean`, which also
 * takes ignored files and anything else untracked in the tree, and pointing
 * someone at that to tidy up after a bad run is how you lose an `.env`.
 *
 * The files a run added are listed in the review diff, which is where removing
 * them one by one is an informed decision rather than a blind sweep.
 */
export const restoreCommand = (ref: string): string =>
  `git restore --source=${ref} --worktree -- .`
