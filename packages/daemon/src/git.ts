import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { copyFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { promisify } from "node:util"
import { sshConfigPath } from "@aide/protocol/node"

const run = promisify(execFile)

// Diffs can be large; the default 1MB buffer truncates real ones.
export const GIT_OPTS = { maxBuffer: 32 * 1024 * 1024, windowsHide: true } as const

/**
 * Where a repository is: a path, and optionally the machine holding it.
 *
 * Every git call in aide already took the root as its first argument, so making
 * THAT carry the host routes the whole of `changes.ts`, `checkpoint.ts` and
 * `repo.ts` to the right machine without any of them knowing there is more than
 * one. A bare string still works and still means "here", which is what keeps
 * every existing caller — and `pnpm smoke` — untouched.
 *
 * This is the alternative to reimplementing those three files for remote
 * projects, and the reason it is affordable: git's own `-C <root>` is already
 * the seam, and `ssh host git -C <root>` is that same command one hop further
 * out.
 */
export type RepoRef = string | { root: string; host: string }

export const refRoot = (ref: RepoRef): string => (typeof ref === "string" ? ref : ref.root)
export const refHost = (ref: RepoRef): string | null =>
  typeof ref === "string" ? null : ref.host

/**
 * A project's repository, wherever it is.
 *
 * The one call every caller of `repo.ts`, `changes.ts` and `checkpoint.ts` makes
 * instead of passing `project.root`. Passing the bare root still compiles — it
 * is a valid `RepoRef` — and silently means "on this machine", which is the
 * mistake this exists to make hard to write: for a remote project that is a
 * Linux path handed to Windows git, which is exactly the "cannot change to
 * '/root/code/…'" the rail showed.
 */
export const repoOf = (project: { root: string; host?: string }): RepoRef =>
  project.host ? { root: project.root, host: project.host } : project.root

/**
 * One argument, safe to hand to a POSIX shell.
 *
 * Needed because `ssh host <words>` joins its argv and lets the REMOTE shell
 * parse the result — so a path with a space in it, or a commit message, splits
 * into several arguments unless it is quoted for that second parse. See
 * `listRemoteDirectories` in `ssh.ts`, where getting this wrong silently listed
 * the wrong directory instead of failing.
 */
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

/**
 * The command for a git call, local or remote.
 *
 * Environment variables ride as a `VAR=value` prefix rather than through ssh's
 * `SendEnv`, which needs the far server to have accepted them in `sshd_config`
 * — a dependency on remote configuration whose failure mode is a silently
 * un-applied `GIT_INDEX_FILE`, which is to say a scratch index that quietly
 * becomes the real one.
 */
function gitCommand(
  ref: RepoRef,
  args: string[],
  env?: NodeJS.ProcessEnv,
): [file: string, argv: string[]] {
  const host = refHost(ref)
  if (!host) return ["git", ["-C", refRoot(ref), ...args]]

  const prefix = Object.entries(env ?? {}).map(([k, v]) => `${k}=${shellQuote(String(v))}`)
  const remote = [...prefix, "git", "-C", shellQuote(refRoot(ref)), ...args.map(shellQuote)]
  return ["ssh", ["-o", "BatchMode=yes", "-F", sshConfigPath(), host, remote.join(" ")]]
}

/**
 * Several independent git reads in ONE round trip.
 *
 * Locally this is a convenience and changes nothing — the calls run in
 * parallel, as they would anyway. Remotely it is the difference between a
 * usable pane and an unusable one: every ssh connection from this machine costs
 * about 1.4s (measured against `tg`, where Windows OpenSSH cannot multiplex
 * because it has no Unix sockets), and `overview` alone asks four questions.
 * Four connections is six seconds to draw a branch name; one is a second and a
 * half.
 *
 * Each command's output is delimited by a marker containing a UUID, so a
 * command whose own output happens to contain the marker text cannot split the
 * response — a diff of this file would otherwise do exactly that.
 *
 * A failing command yields "" rather than aborting the batch, matching the
 * `gitOr` these callers already wrap themselves in: the questions are
 * independent, and "no upstream" must not stop the branch name from arriving.
 */
export async function gitBatch(root: RepoRef, commands: string[][]): Promise<string[]> {
  if (!refHost(root)) {
    return Promise.all(commands.map((args) => gitOr("", () => git(root, args))))
  }

  const marker = `--aide-${randomUUID()}--`
  const script = commands
    .map(
      (args) =>
        // `|| true` so one failure does not end the script, and the marker is
        // printed AFTER each command so an empty answer still produces a
        // section.
        //
        // `printf` with no trailing newline, NOT `echo`. The separator has to
        // add nothing of its own: `git status -z` ends its output with a NUL
        // and no newline, so an `echo` here appends a byte that is neither the
        // command's nor the delimiter's — and stripping it afterwards cannot
        // tell it apart from a newline the command really did emit. Getting
        // this wrong splits `?? a.md\0?? b.md` one byte early and the file list
        // comes back mangled.
        `{ git -C ${shellQuote(refRoot(root))} ${args.map(shellQuote).join(" ")} 2>/dev/null || true; }; printf %s ${shellQuote(marker)}`,
    )
    .join("; ")

  const { stdout } = await run(
    "ssh",
    ["-o", "BatchMode=yes", "-F", sshConfigPath(), refHost(root)!, script],
    GIT_OPTS,
  ).catch(() => ({ stdout: "" }))

  // Each section is exactly what its command wrote, because the delimiter
  // contributes no bytes of its own — see the `printf` above. Nothing is
  // trimmed here: a caller that wants a bare branch name calls `.trim()`, and a
  // caller reading `-z` output needs its NULs intact.
  const parts = stdout.split(marker)
  return commands.map((_, i) => parts[i] ?? "")
}

/**
 * git says *why* it refused on stderr, and sometimes on stdout instead (merge
 * conflicts list the files there). execFile's own message is just the exit code,
 * so without this a failed commit surfaces in the UI as "Command failed" and the
 * actual reason — no user.email, a pre-commit hook, a conflict — is thrown away.
 */
export async function git(
  cwd: RepoRef,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const [file, argv] = gitCommand(cwd, args, env)
  try {
    // A remote call carries its env on the command line, so `process.env` is
    // merged only for a local one: inheriting this machine's environment on the
    // far side would be meaningless and occasionally wrong.
    const opts = env && !refHost(cwd) ? { ...GIT_OPTS, env: { ...process.env, ...env } } : GIT_OPTS
    const { stdout } = await run(file, argv, opts)
    return stdout
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string }
    const detail = `${e.stderr ?? ""}${e.stdout ?? ""}`.trim()
    throw new Error(detail || e.message || `git ${args[0]} failed`)
  }
}

/**
 * Run git against a THROWAWAY index, so staging touches nothing the human owns.
 *
 * This is the one trick that makes working in the project's own checkout safe.
 * The obvious way to ask "what is on disk right now" is `git add -A` followed by
 * `write-tree` or `diff --cached` — but the project's index belongs to the
 * human. Staging their half-finished work because aide wanted to compute a diff
 * would mean a `git commit` they typed themselves picks up files they never
 * added, and there is no way to put an index back the way it was.
 *
 * `GIT_INDEX_FILE` points git at a scratch file instead. Everything inside the
 * callback stages into that, and the real `.git/index` is never opened for
 * writing — verified in `pnpm smoke`, which asserts `git status --porcelain` is
 * byte-identical either side of a checkpoint.
 *
 * The scratch file is named with a UUID rather than the pid: two of these can
 * overlap (a review draft reading a diff while a turn finishes), and a shared
 * name would have them stage into each other's index.
 */
export async function withTempIndex<T>(
  root: RepoRef,
  fn: (gitTemp: (args: string[]) => Promise<string>, indexPath: string) => Promise<T>,
): Promise<T> {
  const host = refHost(root)
  // In the system temp directory, OUTSIDE the working tree, and that is not
  // arbitrary: put the scratch index next to `.git` where it looks like it
  // belongs, and the `git add -A` that runs against it sweeps the index file and
  // its own lock into the tree as though they were project files.
  //
  // On the MACHINE THAT RUNS GIT, which for a remote project is not this one:
  // `GIT_INDEX_FILE` is interpreted by the far side, so a path from this
  // machine's `tmpdir()` would name a directory that does not exist over there
  // — and a Windows path at that. `/tmp` is assumed for the same reason
  // `listRemoteDirectories` assumes a POSIX shell.
  const index = host
    ? `/tmp/aide-index-${randomUUID()}`
    : join(tmpdir(), `aide-index-${randomUUID()}`)
  const env = { GIT_INDEX_FILE: index }
  try {
    return await fn((args) => git(root, args, env), index)
  } finally {
    // `force` because git may never have created it — a callback that threw on
    // its first command leaves no file, and that must not mask the real error.
    if (host) await removeRemote(host, index)
    else await rm(index, { force: true }).catch(() => {})
  }
}

/** `rm -f` on the far side, for the scratch index. Never throws: see above. */
async function removeRemote(host: string, path: string): Promise<void> {
  await run(
    "ssh",
    ["-o", "BatchMode=yes", "-F", sshConfigPath(), host, `rm -f ${shellQuote(path)}`],
    GIT_OPTS,
  ).catch(() => {})
}

/**
 * `withTempIndex`, with the scratch index already reflecting everything on disk.
 *
 * Every question aide asks about the working tree — what is in it now, what has
 * the run changed — is really a question about a tree object, and you cannot
 * have a tree object without staging. This is that staging, done somewhere the
 * human will never see it.
 *
 * The real index is COPIED rather than rebuilt with `read-tree`, and that is a
 * performance decision with teeth: a freshly read tree carries no stat
 * information, so `git add -A` cannot tell which files are unchanged and
 * re-hashes the entire repository. Copying brings the stat cache along, so the
 * add only hashes what actually differs — the difference between this costing
 * milliseconds and costing seconds on every turn of every conversation.
 *
 * The copy is best effort. With no index to copy the scratch one starts empty,
 * which makes the add slower and the resulting tree identical, so a failure here
 * costs time and never correctness.
 */
export async function withWorkingTreeIndex<T>(
  root: RepoRef,
  fn: (gitTemp: (args: string[]) => Promise<string>) => Promise<T>,
): Promise<T> {
  return withTempIndex(root, async (gitTemp, indexPath) => {
    const host = refHost(root)
    const real = await realIndexPath(root)
    if (real) {
      // The copy happens where both files are. `copyFile` is this machine's
      // filesystem, so a remote project needs `cp` over there — copying the far
      // index down and back would be the stat cache's whole point thrown away,
      // plus two transfers of a file that can be megabytes.
      if (host) await copyRemote(host, real, indexPath)
      else await copyFile(real, indexPath).catch(() => {})
    }
    await gitTemp(["add", "-A"])
    return fn(gitTemp)
  })
}

/** `cp` on the far side. Best effort, exactly like the local `copyFile`. */
async function copyRemote(host: string, from: string, to: string): Promise<void> {
  await run(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      "-F",
      sshConfigPath(),
      host,
      `cp ${shellQuote(from)} ${shellQuote(to)}`,
    ],
    GIT_OPTS,
  ).catch(() => {})
}

/**
 * The real index, so its stat cache can be reused. Null when there is none —
 * a repository with no commits and nothing staged has no index file yet.
 *
 * `--git-dir` rather than `<root>/.git`, because the latter is a FILE when the
 * project is itself a worktree, and the index lives in the directory it points
 * at rather than beside it.
 */
async function realIndexPath(root: RepoRef): Promise<string | null> {
  const dir = await gitOr("", async () => (await git(root, ["rev-parse", "--git-dir"])).trim())
  if (!dir) return null
  // `join` is this machine's path grammar, which on Windows means backslashes —
  // fine for a local repo and wrong for a remote one, where the result is handed
  // straight back to a POSIX shell. A remote path is always POSIX, so it is
  // built by hand.
  if (refHost(root)) {
    return dir.startsWith("/") ? `${dir}/index` : `${refRoot(root)}/${dir}/index`
  }
  return isAbsolute(dir) ? join(dir, "index") : join(refRoot(root), dir, "index")
}

/**
 * The same, for the diff commands that exit 1 to mean "there were differences".
 *
 * `git diff --no-index` uses its exit status as an answer rather than as an
 * error, so the wrapper above would turn every non-empty diff into a thrown
 * "Command failed" carrying the patch as its message — every new file in the
 * working tree would have vanished from the view with no way to tell that from
 * "there are no new files". Exit 1 with output is success here; anything else
 * still throws.
 */
export async function gitDiffing(cwd: RepoRef, args: string[]): Promise<string> {
  const [file, argv] = gitCommand(cwd, args)
  try {
    const { stdout } = await run(file, argv, GIT_OPTS)
    return stdout
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string }
    if (e.code === 1 && typeof e.stdout === "string") return e.stdout
    const detail = `${e.stderr ?? ""}${e.stdout ?? ""}`.trim()
    throw new Error(detail || e.message || `git ${args[0]} failed`)
  }
}

/** Runs `fn`, answering `fallback` rather than throwing. */
export async function gitOr<T>(fallback: T, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch {
    return fallback
  }
}
