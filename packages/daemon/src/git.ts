import { execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { copyFile, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { promisify } from "node:util"
import { sshConfigPath } from "@aide/protocol/node"

const run = promisify(execFile)

// Diffs can be large; the default 1MB buffer truncates real ones.
export const GIT_OPTS = { maxBuffer: 32 * 1024 * 1024, windowsHide: true } as const

/**
 * How long a REMOTE git call may take before it is given up on.
 *
 * Local git has no timeout and needs none: it either answers or fails, and a
 * repository on this disk cannot stop responding halfway. A network can, and
 * when it does `execFile` waits forever — which is not a hypothetical. A commit
 * on a remote project ran `git` against a path that did not exist on this
 * machine, hung on the first call, and held that project's lock for an hour with
 * one line in its log and no way to clear it from the UI: `interrupt` sets a
 * flag the stuck `await` never reaches.
 *
 * Generous, because a `git add -A` over ssh on a large tree is genuinely slow —
 * but finite, because the failure it prevents is a project wedged until the
 * daemon is restarted. A gate whose precondition can hang is not a gate.
 */
const REMOTE_GIT_TIMEOUT_MS = 90_000

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
 *
 * That has now happened three times, so it is worth saying what it costs rather
 * than only what it is. The type cannot catch it — a bare string has to stay
 * legal for every local caller — so the damage is decided by whether the call
 * site swallows the error. `ChatLane.#checkpoint` did NOT: it is awaited before
 * a turn may write, deliberately, so a remote project could not start a
 * conversation at all. `checkpointNotice` in `board.ts` DID, via a `.catch`, so
 * the same bug there showed up as a chat ticked off with no undo offered. When
 * you add a caller, grep for `project.root` beside a git call before assuming
 * this one is fine.
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
export const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

/**
 * `GIT_OPTS`, plus a timeout when the call goes over a network. See
 * `REMOTE_GIT_TIMEOUT_MS`. Local calls are left exactly as they were.
 */
const withRemoteTimeout = <T extends object>(ref: RepoRef, opts: T): T =>
  refHost(ref) ? { ...opts, timeout: REMOTE_GIT_TIMEOUT_MS } : opts

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
 *
 * `env` rides in front of every command in the batch, which is what lets reads
 * against a SCRATCH INDEX be batched at all — `withWorkingTreeIndex` sets
 * `GIT_INDEX_FILE`, and without this the three reads it wraps had to go one
 * connection each. It is applied per command rather than exported once for the
 * script, so a command list is still a list of independent commands rather than
 * a thing with shared state between its entries.
 */
export async function gitBatch(
  root: RepoRef,
  commands: string[][],
  env?: NodeJS.ProcessEnv,
): Promise<string[]> {
  if (!refHost(root)) {
    return Promise.all(commands.map((args) => gitOr("", () => git(root, args, env))))
  }

  const prefix = Object.entries(env ?? {})
    .map(([k, v]) => `${k}=${shellQuote(String(v))} `)
    .join("")
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
        `{ ${prefix}git -C ${shellQuote(refRoot(root))} ${args.map(shellQuote).join(" ")} 2>/dev/null || true; }; printf %s ${shellQuote(marker)}`,
    )
    .join("; ")

  const { stdout } = await run(
    "ssh",
    ["-o", "BatchMode=yes", "-F", sshConfigPath(), refHost(root)!, script],
    withRemoteTimeout(root, GIT_OPTS),
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
/**
 * Test seam: observe every `git()` invocation.
 *
 * `pnpm smoke:queue` uses it to count TREE WALKS on a send — the property "a
 * clean-tree send walks the tree exactly once" is invisible to every other kind
 * of assertion, because a second walk returns the same answer and only costs
 * time (on a remote project, an ssh connection). A mutable field rather than a
 * parameter because `git` has some fifty callers and this is for exactly one.
 */
export const gitSpy: { onCall: ((cwd: RepoRef, args: readonly string[]) => void) | null } = {
  onCall: null,
}

export async function git(
  cwd: RepoRef,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  gitSpy.onCall?.(cwd, args)
  const [file, argv] = gitCommand(cwd, args, env)
  try {
    // A remote call carries its env on the command line, so `process.env` is
    // merged only for a local one: inheriting this machine's environment on the
    // far side would be meaningless and occasionally wrong.
    const opts = env && !refHost(cwd) ? { ...GIT_OPTS, env: { ...process.env, ...env } } : GIT_OPTS
    const { stdout } = await run(file, argv, withRemoteTimeout(cwd, opts))
    return stdout
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string; killed?: boolean }
    // A killed process is the timeout above, and it has no stderr of its own —
    // without this it surfaces as an empty message, which is the least useful
    // thing a wedged pane can say.
    if (e.killed && refHost(cwd)) {
      throw new Error(
        `${refHost(cwd)} did not answer \`git ${args[0]}\` within ${REMOTE_GIT_TIMEOUT_MS / 1000}s`,
      )
    }
    const detail = `${e.stderr ?? ""}${e.stdout ?? ""}`.trim()
    if (detail) throw new Error(detail)
    // A remote call that failed with NOTHING on either stream did not reach git
    // at all — ssh itself gave up, which is what an exhausted connection table
    // looks like from here (sshd past `MaxStartups`, or this machine out of
    // process handles). `e.message` for that case is execFile's own, which is
    // the entire ssh command line including the config path and the remote
    // script: a wall of text in the rail that names everything except what went
    // wrong.
    if (refHost(cwd)) throw new Error(`could not reach ${refHost(cwd)} to run \`git ${args[0]}\``)
    throw new Error(e.message || `git ${args[0]} failed`)
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
    //
    // The remote delete is NOT awaited. It is a `/tmp` unlink that nothing later
    // depends on, and awaiting it spends a whole 1.4s ssh handshake making the
    // caller wait to throw a file away — a quarter of what a remote commit's
    // first step costs, for no answer anybody reads. Failing silently is the
    // same outcome as the local `.catch(() => {})` beside it: a stale scratch
    // index in `/tmp`, named with a UUID so it collides with nothing.
    if (host) void removeRemote(host, index)
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
 * A path inside the repository, spelled for the machine that HOLDS it.
 *
 * `join` is this machine's grammar, so on Windows it answers `C:\…\.aide\
 * project.md` — backslashes, handed to a POSIX shell. A remote root is always
 * POSIX, so it is built by hand. Same trap as `realIndexPath`, which is why that
 * one is local-only now.
 */
export const refPath = (ref: RepoRef, ...parts: string[]): string =>
  refHost(ref) ? [refRoot(ref), ...parts].join("/") : join(refRoot(ref), ...parts)

/**
 * Read a file out of the repository, wherever the repository is.
 *
 * Null when it is not there, which callers treat as "no such file" rather than
 * as an error — `.aide/project.md` is genuinely optional.
 *
 * `cat` over ssh for a remote project, because `node:fs` would be reading THIS
 * machine's disk for a path that only exists on the far one. That is not a
 * hypothetical difference: `readProjectDoc` did exactly this, missed every time
 * for a remote project, and returned the empty doc — so the agent ran without
 * the brief AND the commit gate ran without the `verify:` commands, both
 * silently, because a missing file is a legal answer here.
 */
export async function readRepoFile(ref: RepoRef, ...parts: string[]): Promise<string | null> {
  const path = refPath(ref, ...parts)
  const host = refHost(ref)
  if (!host) return await readFile(path, "utf8").catch(() => null)

  try {
    const { stdout } = await run(
      "ssh",
      ["-o", "BatchMode=yes", "-F", sshConfigPath(), host, `cat ${shellQuote(path)}`],
      withRemoteTimeout(ref, GIT_OPTS),
    )
    return stdout
  } catch {
    // Absent and unreachable are the same answer here on purpose: this is only
    // ever asked about optional files, and a host that cannot be reached will
    // fail loudly at the very next git call anyway.
    return null
  }
}

/**
 * One shell command on the machine a `RepoRef` names, with the timeout every
 * remote call needs.
 *
 * The timeout is the half that gets forgotten, which is why this exists rather
 * than another hand-built argv. `remoteFileSize` in `repo.ts` wrote its own
 * `execFile("ssh", …)` with `windowsHide` and nothing else, so `workingTree`
 * could wait forever on a host that had stopped answering — once per untracked
 * file, up to fifty times in one request — which is exactly the wedge
 * `REMOTE_GIT_TIMEOUT_MS` was added to close after it held a project's lock for
 * an hour. Keeping the argv and the timeout together means a caller cannot take
 * the first without the second.
 *
 * `command` is parsed by the REMOTE shell, so anything interpolated into it has
 * to go through `shellQuote` first. A local ref throws rather than shelling out:
 * every caller has a direct `node:fs` answer for that case, and quietly spawning
 * ssh to reach this machine's own disk would be a slower way to be wrong.
 */
export async function sshCommand(ref: RepoRef, command: string): Promise<string> {
  const host = refHost(ref)
  if (!host) throw new Error(`sshCommand needs a remote ref, got ${refRoot(ref)}`)
  const { stdout } = await run(
    "ssh",
    ["-o", "BatchMode=yes", "-F", sshConfigPath(), host, command],
    withRemoteTimeout(ref, GIT_OPTS),
  )
  return stdout
}

/**
 * A file holding `content`, ON THE MACHINE THAT RUNS GIT, for the duration of
 * `fn`.
 *
 * The same trap as `GIT_INDEX_FILE` in `withTempIndex`, and it bit in exactly
 * the same way: `commitRun` wrote the message with `writeFile(join(tmpdir(),
 * …))` and handed the result to `git commit -F`. Locally those are the same
 * disk. For a remote project the file is written HERE and read THERE, so the
 * commit died on `could not read log file
 * 'C:\\Users\\…\\Temp\\aide-commitmsg-…': No such file or directory` — a Windows
 * path quoted at a Linux box, after the diff had been read, the checks had run
 * and the message had been paid for.
 *
 * A file rather than `-m` because commit messages are multi-line by design, and
 * over ssh the argument would be parsed a second time by the remote shell.
 * Content goes over STDIN rather than interpolated into the command, so a
 * message containing quotes, backticks or a `$(…)` is bytes rather than
 * something the far shell evaluates — which for a model-written commit message
 * is the difference between a body and an injection.
 */
export async function withMessageFile<T>(
  ref: RepoRef,
  content: string,
  fn: (path: string) => Promise<T>,
): Promise<T> {
  const host = refHost(ref)
  const body = content.endsWith("\n") ? content : `${content}\n`
  const path = host
    ? `/tmp/aide-commitmsg-${randomUUID()}`
    : join(tmpdir(), `aide-commitmsg-${randomUUID()}`)

  if (host) await writeRemoteFile(host, path, body)
  else await writeFile(path, body, "utf8")

  try {
    return await fn(path)
  } finally {
    // Not awaited remotely, for the reason `withTempIndex`'s cleanup is not:
    // a `/tmp` unlink nothing depends on is not worth a 1.4s handshake.
    if (host) void removeRemote(host, path)
    else await rm(path, { force: true }).catch(() => {})
  }
}

/**
 * Write a file on the far side, with the content on stdin.
 *
 * `spawn` rather than the `execFile` everything else here uses, because
 * `execFile` cannot supply a stdin body — and stdin is the point: it is what
 * keeps the message out of the command line. Unlike the best-effort helpers
 * above this one THROWS, because a commit whose message never arrived must not
 * go on to write an empty one.
 */
function writeRemoteFile(host: string, path: string, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ssh",
      ["-o", "BatchMode=yes", "-F", sshConfigPath(), host, `cat > ${shellQuote(path)}`],
      { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] },
    )
    let stderr = ""
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString()
    })
    child.on("error", reject)
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(stderr.trim() || `could not write the commit message to ${host}`)),
    )
    child.stdin?.end(content)
  })
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
 *
 * The callback gets `batchTemp` beside `gitTemp`: several reads of the staged
 * tree in one round trip, which is what keeps a remote commit to two connections
 * instead of eight. Use it whenever the reads are independent — asking for the
 * patch, the stat and the paths one at a time is three handshakes for three
 * views of the same tree.
 */
export async function withWorkingTreeIndex<T>(
  root: RepoRef,
  fn: (
    gitTemp: (args: string[]) => Promise<string>,
    batchTemp: (commands: string[][]) => Promise<string[]>,
  ) => Promise<T>,
): Promise<T> {
  return withTempIndex(root, async (gitTemp, indexPath) => {
    const host = refHost(root)
    if (host) await prepareRemoteIndex(root, host, indexPath)
    else {
      const real = await realIndexPath(refRoot(root))
      // The copy happens where both files are. `copyFile` is this machine's
      // filesystem, so a remote project needs `cp` over there — copying the far
      // index down and back would be the stat cache's whole point thrown away,
      // plus two transfers of a file that can be megabytes.
      if (real) await copyFile(real, indexPath).catch(() => {})
      await gitTemp(["add", "-A"])
    }
    const batchTemp = (commands: string[][]) =>
      gitBatch(root, commands, { GIT_INDEX_FILE: indexPath })
    return fn(gitTemp, batchTemp)
  })
}

/**
 * Locate the real index, copy it, and stage the tree — in ONE ssh connection.
 *
 * The three steps are separate calls locally, where each costs about 30ms and
 * the clarity is free. Remotely each is a full connection at ~1.4s, because
 * Windows OpenSSH cannot multiplex, and they were the first three of the EIGHT
 * that `treeChanges` spent before the commit gate had read anything at all. That
 * is the step the rail reported as `did not answer \`git diff\` within 90s`:
 * eight serial handshakes against a host whose sshd drops connections past
 * `MaxStartups` while the rail is polling it 1500ms apart.
 *
 * Written as a shell script rather than a `gitBatch`, because the steps are NOT
 * independent — the `cp` must land before the `add` reads it, and `--git-dir` is
 * resolved on the far side by `$(…)` instead of being round-tripped here first.
 *
 * Entirely best effort, matching the local path: a missing index (a repo with no
 * commits) or a failed copy costs the stat cache and nothing else, so every step
 * is `|| true` and the whole thing swallows its error. What must not happen is
 * this throwing and taking a readable diff down with it.
 */
async function prepareRemoteIndex(root: RepoRef, host: string, indexPath: string): Promise<void> {
  const dir = `$(git -C ${shellQuote(refRoot(root))} rev-parse --git-path index)`
  const script = [
    // `--git-path index` rather than `--git-dir` plus a join: it answers with the
    // index's own path, already absolute-or-relative-to-root the way git means
    // it, so the worktree case (`.git` is a FILE pointing elsewhere) needs no
    // special handling here.
    `cd ${shellQuote(refRoot(root))} || exit 0`,
    `cp ${dir} ${shellQuote(indexPath)} 2>/dev/null || true`,
    `GIT_INDEX_FILE=${shellQuote(indexPath)} git -C ${shellQuote(refRoot(root))} add -A || true`,
  ].join("; ")

  await run(
    "ssh",
    ["-o", "BatchMode=yes", "-F", sshConfigPath(), host, script],
    withRemoteTimeout(root, GIT_OPTS),
  ).catch(() => {})
}

/**
 * The real index, so its stat cache can be reused. Null when there is none —
 * a repository with no commits and nothing staged has no index file yet.
 *
 * `--git-dir` rather than `<root>/.git`, because the latter is a FILE when the
 * project is itself a worktree, and the index lives in the directory it points
 * at rather than beside it.
 *
 * LOCAL only: `join` is this machine's path grammar, which on Windows means
 * backslashes, and the result would be handed to a POSIX shell. The remote side
 * resolves its own index inside `prepareRemoteIndex`, where `$(git rev-parse
 * --git-path index)` answers on the machine that has the file.
 */
async function realIndexPath(root: string): Promise<string | null> {
  const dir = await gitOr("", async () => (await git(root, ["rev-parse", "--git-dir"])).trim())
  if (!dir) return null
  return isAbsolute(dir) ? join(dir, "index") : join(root, dir, "index")
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
    const { stdout } = await run(file, argv, withRemoteTimeout(cwd, GIT_OPTS))
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
