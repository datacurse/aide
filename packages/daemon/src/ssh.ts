/**
 * The machines in `~/.aide/ssh_config`, and looking around one of them.
 *
 * This file is the BROWSING half of "add a project over ssh": listing your
 * hosts, walking a remote filesystem, and saying whether a directory over there
 * is a git repository.
 *
 * It used to open by saying that running a project from another machine was not
 * possible, which was true when it was written and stopped being true three
 * changes later — see `addRemoteProject` at the bottom, which now records what
 * each of those three cost. A header that describes a limit the file itself has
 * since removed is worse than no header: it is read first and believed.
 *
 * Separated from `picker.ts` rather than folded into it because the two answer
 * different questions — that one opens a window on your screen, this one runs a
 * command on a machine somewhere else — and because a remote listing has a
 * failure mode the local dialog does not have: it can hang.
 */
import { execFile, spawn } from "node:child_process"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import type { SshHost, SshListing } from "@aide/protocol"
import {
  SSH_CONFIG_TEMPLATE,
  STATE_DIR,
  parseSshConfig,
  connectableHosts,
  sshTarget,
} from "@aide/protocol"
import { aideHome, sshConfigPath } from "@aide/protocol/node"

/**
 * The hosts aide knows about, creating the file on first read.
 *
 * Scaffolded rather than reported missing, for the same reason `addProject`
 * scaffolds `.aide/`: "no such file" as an answer to "which machines do I have"
 * leaves the person to create a file whose name and format they now have to look
 * up. An empty list plus a commented example is a thing they can edit.
 */
export async function listSshHosts(): Promise<SshHost[]> {
  let raw: string
  try {
    raw = await readFile(sshConfigPath(), "utf8")
  } catch {
    await mkdir(aideHome(), { recursive: true })
    // `wx` — never clobber. Two browsers asking at once both miss the read, and
    // without this the second write would erase a file the first one had already
    // scaffolded and the human may already be typing into.
    await writeFile(sshConfigPath(), SSH_CONFIG_TEMPLATE, { encoding: "utf8", flag: "wx" }).catch(
      () => {},
    )
    return []
  }
  return connectableHosts(parseSshConfig(raw))
}

/**
 * How long a remote command may take before aide gives up on it.
 *
 * A local dialog waits for a human and must never time out; a remote listing
 * waits for a NETWORK and must. The number is generous because the first
 * connection to a host pays key exchange and possibly a DNS lookup for a
 * `.local` name, and mean because a machine that is asleep or off — which is the
 * normal state of half the boxes in a config like this — otherwise leaves the
 * picker spinning with nothing to say.
 */
const SSH_TIMEOUT_MS = 15_000

/**
 * ssh's own connect timeout, in seconds, set BELOW the process timeout above.
 *
 * Both are needed and neither is redundant. `ConnectTimeout` covers a host that
 * is unreachable, and returns a real error message aide can show. The process
 * timeout covers everything ssh will happily wait forever for — a host key
 * prompt, a password prompt — where there is no message and nobody to type.
 */
const CONNECT_TIMEOUT_S = 10

/**
 * The options every ssh call gets, before the target.
 *
 * `BatchMode=yes` is the load-bearing one, and it is what makes this safe to run
 * from a daemon at all: it turns every interactive prompt into an immediate
 * failure. Without it, a host whose key is not yet known parks on "Are you sure
 * you want to continue connecting?" reading a stdin that is not a terminal, and
 * one whose key needs a passphrase parks on that — in both cases the HTTP
 * request hangs until the timeout and the reason never reaches the screen.
 *
 * Fail closed, in the brief's sense: a machine aide cannot reach without asking
 * somebody something is a machine aide does not reach, and the error says to run
 * `ssh <host>` once in a terminal, which is the step that fixes it.
 */
function sshArgs(host: SshHost, remoteCommand: string[]): string[] {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${CONNECT_TIMEOUT_S}`,
    ...(host.port ? ["-p", String(host.port)] : []),
    // The config file is aide's, so ssh must be told to read it: without this it
    // reads ~/.ssh/config, where the alias may not exist at all, and resolves the
    // name through DNS instead. `-F` replaces the user file rather than adding to
    // it, which is what keeps the picker's list and the connection in agreement.
    "-F",
    sshConfigPath(),
    sshTarget(host),
    ...remoteCommand,
  ]
}

/**
 * One argument, safe to hand to a POSIX shell.
 *
 * Single quotes, because inside them a shell expands nothing at all — no `$`, no
 * backtick, no glob. The body is the only escape sequence that works there:
 * there is no way to write a single quote INSIDE single quotes, so the string is
 * closed, an escaped quote is emitted, and it is reopened.
 */
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

/** stdout, or a thrown Error carrying what ssh said on stderr. */
function ssh(host: SshHost, remoteCommand: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "ssh",
      sshArgs(host, remoteCommand),
      { windowsHide: true, timeout: SSH_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout)
        // A killed process is the timeout, which has no stderr of its own and
        // would otherwise surface as an empty message.
        const killed = (error as { killed?: boolean }).killed
        const detail = stderr.trim() || error.message
        reject(
          new Error(
            killed
              ? `${host.alias} did not answer within ${SSH_TIMEOUT_MS / 1000}s`
              : cleanSshError(detail, host),
          ),
        )
      },
    )
  })
}

/**
 * ssh's stderr, made into something worth showing.
 *
 * The two failures that actually happen here are both ones BatchMode causes, and
 * both of them read as a bug in aide unless the message says otherwise: a host
 * whose key is unknown, and a key that needs a passphrase or an agent. Neither
 * is fixable from this UI — they are fixed by connecting once in a terminal — so
 * the message says that rather than restating ssh's.
 */
export function cleanSshError(stderr: string, host: SshHost): string {
  // A CHANGED key first, because it also says "Host key verification failed"
  // and the advice for the unknown case — connect once and accept it — does
  // nothing here: ssh refuses again, identically, until the stale line is
  // removed. Telling someone to run a command that cannot work sends them round
  // a loop, so the two are separated even though ssh's final line is the same.
  //
  // Deliberately NOT offering to fix it. This is the one ssh failure that is
  // also what a machine-in-the-middle looks like, and a dashboard that quietly
  // runs `keygen -R` on your behalf has removed the check that was doing its
  // job. aide says which line, in which file, and leaves the decision.
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|key has changed/i.test(stderr)) {
    const offending = /Offending [A-Z0-9]+ key in (\S+):(\d+)/i.exec(stderr)
    const where = offending ? ` The old key is ${offending[1]} line ${offending[2]}.` : ""
    return `${host.alias}: the host key CHANGED since you last connected.${where} That is what a rebuilt machine looks like — and also what an interception looks like, so aide will not clear it for you. If you are sure the machine was rebuilt, remove that line and try again.`
  }
  if (/host key verification failed|no matching host key|not known/i.test(stderr)) {
    return `${host.alias}: unknown host key. Run \`ssh ${sshTarget(host)}\` once in a terminal to accept it, then try again.`
  }
  if (/permission denied|no supported authentication|agent refused/i.test(stderr)) {
    return `${host.alias}: ssh refused the key. aide never asks for a password — set up key authentication (or add the key to your agent) and try again.`
  }
  return `${host.alias}: ${stderr.split(/\r?\n/).filter(Boolean).join(" ")}`
}

/**
 * A remote directory's subdirectories, and which of them are git repositories.
 *
 * One command rather than one per directory, because each ssh call is a whole
 * connection and a listing of thirty folders would be thirty of them. So the
 * remote script answers three questions in one round trip — where am I, what is
 * in here, which of these hold a `.git` — separated by `---` lines, and "which
 * of these can I add" is marked by the same trip that draws the list.
 *
 * POSIX shell on the far side. That is an assumption, and it is the reason this
 * says "no Windows hosts" rather than pretending: a Windows box over ssh gets
 * cmd.exe and every line of this fails. Naming it here beats a listing that
 * comes back mysteriously empty.
 */
export async function listRemoteDirectories(
  host: SshHost,
  path: string,
): Promise<SshListing> {
  // `cd` first, so a path that does not exist fails as itself rather than as an
  // empty listing of the home directory. The quoting is the remote shell's, and
  // a directory named `it's` would otherwise end the string and run the rest of
  // the path as commands.
  const dir = path.trim() || "."
  const quoted = shellQuote(dir)

  // Two passes over the same directory: the folders themselves, then the ones
  // holding a `.git`. `-maxdepth 1` on the first and `-maxdepth 2` on the second
  // means one connection answers both. `2>/dev/null` on the git pass alone,
  // because a permission error there is normal — an unreadable subdirectory must
  // not blank the whole listing — while one on the first pass is the answer.
  const script = [
    `cd ${quoted} || exit 1`,
    `pwd`,
    `echo ---`,
    `find . -maxdepth 1 -type d -not -name '.' -not -name '.*' | sort`,
    `echo ---`,
    `find . -maxdepth 2 -name .git -not -path './.git' 2>/dev/null | sort`,
  ].join("; ")

  // Quoted ONCE, and the count is the whole subtlety. `ssh` does not pass an
  // argv to the far side: it joins the words with spaces and hands the resulting
  // STRING to the login shell, which parses it again. So the script needs the
  // one level of quoting that survives that parse — and needs it even though
  // `execFile` is already passing this as a single argument.
  //
  // Measured both ways against a POSIX shell, because getting it wrong is quiet
  // rather than loud. Unquoted, the join splits the script at its first space and
  // `cd <path>` becomes a separate command from the `find` that follows: the
  // listing comes back successful, non-empty, and OF THE HOME DIRECTORY instead
  // of the one that was asked for. Quoted twice — the bug this replaced — the
  // path arrives as `'''/home/pi'''` and the `cd` fails.
  const out = await ssh(host, ["sh", "-c", shellQuote(script)])
  const [pwdPart = "", dirsPart = "", gitPart = ""] = out.split(/^---$/m)

  const absolute = pwdPart.trim().split(/\r?\n/)[0]?.trim() || dir
  // `./name` from find — the leading `./` is noise in a picker.
  const strip = (line: string) => line.trim().replace(/^\.\//, "")

  const repos = new Set(
    gitPart
      .split(/\r?\n/)
      .map(strip)
      .filter(Boolean)
      // `a/.git` names the repository `a`; a bare `.git` is this directory
      // itself, which the find above already excluded.
      .map((line) => line.replace(/\/?\.git$/, ""))
      .filter(Boolean),
  )

  const directories = dirsPart
    .split(/\r?\n/)
    .map(strip)
    .filter(Boolean)
    .map((name) => ({ name, isRepo: repos.has(name) }))

  return { host: host.alias, path: absolute, directories }
}

/**
 * The repo root at or above a remote path, and whether there is one at all.
 *
 * `--show-toplevel` rather than testing for a `.git` directory, for the same
 * reason `addProject` does it locally: adding a subdirectory must land the same
 * registry entry as adding the root, or one project becomes two.
 *
 * Returns null when the path is not in a repository, which the caller turns
 * into the same refusal a local non-repo gets.
 */
export async function remoteRepoRoot(host: SshHost, path: string): Promise<string | null> {
  try {
    const out = await ssh(host, [
      "git",
      "-C",
      shellQuote(path),
      "rev-parse",
      "--show-toplevel",
    ])
    return out.trim().split(/\r?\n/)[0]?.trim() || null
  } catch {
    // A non-repository exits non-zero, which is an answer rather than a fault.
    // A genuinely broken connection has already been reported by the listing
    // that got us here.
    return null
  }
}

/**
 * `mkdir .aide` on the far side, and the same two seed files a local add writes.
 *
 * The content comes from `registry.ts` rather than being duplicated here: a
 * remote project whose `project.md` differed from a local one would be a second
 * source of truth for what a project is, and the scaffold is the first thing
 * anybody reads.
 *
 * Written through stdin, so a document full of quotes and backticks never has
 * to survive a shell. `test -f ||` keeps it non-destructive — a project already
 * carrying a brief must not have it overwritten by being re-added.
 */
export async function scaffoldRemoteState(
  host: SshHost,
  root: string,
  files: Array<[name: string, content: string]>,
): Promise<void> {
  const dir = `${root}/${STATE_DIR}`
  await ssh(host, ["mkdir", "-p", shellQuote(dir)])
  for (const [name, content] of files) {
    const path = shellQuote(`${dir}/${name}`)
    await sshWithInput(host, `test -f ${path} || cat > ${path}`, content)
  }
}

/** One ssh call with a body on stdin. `execFile` cannot supply one. */
function sshWithInput(host: SshHost, remoteCommand: string, input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", sshArgs(host, ["sh", "-c", shellQuote(remoteCommand)]), {
      windowsHide: true,
      stdio: ["pipe", "ignore", "pipe"],
    })
    let stderr = ""
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString()
    })
    child.on("error", reject)
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(cleanSshError(stderr.trim() || `ssh exited ${code}`, host))),
    )
    child.stdin?.end(input)
  })
}

/**
 * A remote project works, and this is what each of its three halves cost.
 *
 * This block used to say "not implemented", listing three structural
 * assumptions in the way. All three have been paid, and the note is kept rather
 * than deleted because each answer is the reason the next person should not
 * reach for the shortcut that was rejected.
 *
 * 1. **The agent runs where the daemon runs** — no longer. `runAgent` passed
 *    `cwd: project.root` to a `claude` binary for THIS platform, so a remote
 *    path did not move the process, it failed to chdir. The fix was an agent
 *    process on the far side: `runner.ts` names the seam, `SshRunner` speaks it
 *    over `ssh <host> aide-agent --stdio`, and `pnpm deploy-agent` puts it
 *    there. The daemon stopped being the thing that runs the agent and became
 *    the thing that talks to one.
 *
 * 2. **Every git call assumed a local binary and a local path** — now `RepoRef`
 *    carries the host, and `-C <root>` was already the seam that made that
 *    affordable. `withTempIndex` was the hard part, since `GIT_INDEX_FILE` is
 *    interpreted by whichever machine runs git; it puts the scratch index in
 *    `/tmp` over there. The general rule that came out of it — a path handed to
 *    git must exist on the machine that RUNS git — then caught the commit
 *    message file, which was being written here and read there.
 *
 * 3. **`.aide/` was read with `node:fs`** — `readProjectDoc` takes a `RepoRef`
 *    and reads through `readRepoFile`, which is `cat` over ssh. This one was the
 *    worst of the three to leave, because it failed SILENTLY: a missing brief is
 *    a legal answer, so the agent ran with no project context and the commit
 *    gate skipped every check, neither of them saying so. `scaffoldRemoteState`
 *    above is the write half.
 *
 * Mounting the remote filesystem (sshfs) was the tempting shortcut throughout
 * and is still worse than it looks: git over a network filesystem is slow enough
 * to change how the tool feels, and the checkpoint machinery runs on every turn.
 * The measured cost of the road actually taken is a connection, ~1.4s, which is
 * why so much here is batched.
 */
