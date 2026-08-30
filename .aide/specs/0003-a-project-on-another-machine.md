---
id: "0003"
status: proposed
created: 2026-08-30
---

# A project on another machine

Run the agent, and every git call, on the machine that holds the repository.
The daemon stops being the thing that runs a project and becomes the thing that
talks to whatever is running it — locally, that is still a forked worker; over
ssh, it is an `aide-agent` on the far side.

**Nothing reads this file.** Prose for humans, like `0001` and `0002`.

## Why not the other two options

Both were considered before this one, and both were measured rather than
reasoned about. Against `tg` (88.214.24.214) on 2026-08-30:

| | measured |
| --- | --- |
| round trip to the host | 92 ms |
| one ssh connection from this machine | 1.4 s |
| `git status` in `games42_mono`, run on the host | 0.09 s |
| `ControlMaster` multiplexing on Windows OpenSSH | unsupported |

**Mounting the remote filesystem (sshfs) is disqualified.** git stats thousands
of files per invocation, and over a mount each of those is a network round trip:
the 0.09s above becomes minutes. aide makes it worse than a normal editor would,
because `withWorkingTreeIndex` runs `git add -A` on *every turn* — checkpoint,
diff baseline, commit gate. The Windows half of the measurement is the part that
removes the escape hatch: sshfs is bearable elsewhere largely because
`ControlMaster` amortises the connection, and Windows OpenSSH has no Unix
sockets, so every operation pays the full 1.4s. There is also a correctness
argument independent of speed — git's locking and `mtime` assumptions over a
network filesystem are how an index gets corrupted.

**Running the SDK locally against a remote path is what the current code
already refuses**, in `RemotePicker`'s `onPick`. `cwd` cannot chdir to another
machine, and `execFile("git", ["-C", root])` reads a remote root as a local
path.

So the work goes where the files are. This is what VS Code Remote-SSH does, and
the reason it is fast is precisely that it does *not* mount: it ships a server
to the far side and moves events, not syscalls.

## What `tg` already has

Checked on 2026-08-30, and it is more than expected — the expensive
prerequisite was already met:

| | |
| --- | --- |
| Claude Code | `2.1.212`, at `/root/.local/bin/claude` |
| Credentials | `~/.claude/.credentials.json`, authenticated |
| Session store | `~/.claude/projects/-root-code` — it has run there before |
| git | 2.43.0 |
| OS | Ubuntu 24.04.4, amd64 |
| node | v22.23.2 at `/usr/bin/node` — INSTALLED for this, from NodeSource |

A headless run was verified end to end: `claude -p --output-format stream-json`
in `/root/code` answers, and the messages it emits are the same `system/init`,
`assistant` and `result` shapes `normalizeSdkMessage` already reads. So the
model, the credentials and the transcript format are not open questions.

**`claude` is NOT on the non-interactive PATH.** `ssh tg <command>` does not get
a login shell, so `/root/.local/bin` is absent and a bare `claude` is "not
found" — while the same command typed into an interactive session works. That
asymmetry is the kind that only fails in production, so `aide-agent` resolves
the binary by absolute path rather than trusting PATH. `node` at `/usr/bin/node`
does not have this problem, which is why the install location matters.

## What is built and proven

`runner.ts` holds both implementations, and the transport half is verified
against `tg` rather than reasoned about:

- `LocalRunner` — the existing fork. `pnpm smoke:queue` covers it unchanged.
- `SshRunner` — `ssh -T … <agent> --stdio`, newline-framed JSON both ways.
- `worker/loop.ts` — the agent loop, with no opinion about its transport.
  `worker/main.ts` binds it to IPC, `worker/stdio.ts` binds it to a pipe. ONE
  implementation, because two would drift and the drift would show up as a
  remote conversation rendering differently from a local one.

Driven end to end over a live connection to `tg`: `ready`, `start`, two events,
`done`, `close`, `closed` — all five messages, in order. A payload containing a
literal newline and quote characters came back byte-identical, which is the
framing bug that passes a unit test and fails on a pasted screenshot.

The timing confirms the one-connection-per-conversation decision: **2280ms to
connect, then ~100ms for every message after it.** The cost is the handshake,
paid once, exactly as a warm SDK session already amortises its boot.

Then the real thing, with the SDK behind it — `pnpm deploy-agent tg`, and a
turn driven from this daemon over ssh:

```
  4614ms ready — sending a real turn
  7594ms run.started — session 28b83542, cwd /root/code
  9190ms assistant.text — "WORKING"
  9207ms run.finished — success, $0.0814, 1 turn(s)
```

A real model turn, on the far machine, in `/root/code`, reported as the same
`RunEventBody` shapes the transcript already draws — including the cost.

### Deploying it: a copy and an `npm install`, not a bundle

`pnpm deploy-agent <host>` copies fifteen source files and runs `npm install`
over there. A single bundled artifact was the obvious alternative and is worse
on both counts. Bundling needs a bundler, and this package has four
dependencies on purpose. And it would not remove the install anyway: the SDK
resolves a NATIVE binary through optional dependencies, so the far side has to
run its own install to get `claude-agent-sdk-linux-x64` — confirmed, that is
exactly what npm placed there. Since an install happens regardless, the source
may as well arrive as source, and a remote stack trace then points at code you
can read.

What ships is the agent's runtime graph and nothing else — `stdio.ts` →
`loop.ts` → `agent.ts` → `policy.ts`, plus the browser-safe protocol files —
read off the imports rather than copied wholesale. No Fastify, no registry, no
web bundle. The file list is written out rather than globbed, because a glob
would silently start shipping whatever lands in `src/` next.

`@aide/protocol` is placed as a real package under `node_modules/`, AFTER the
install rather than before: npm prunes what it does not know about, so the
other order deletes it. The sources then say `from "@aide/protocol"` exactly as
they do here, and the deployed code is byte-identical to the repository.

### Version skew is refused on `ready`

The agent reports `{"type":"ready","protocol":1}` and `SshRunner` checks it
before the first turn goes out — the last moment at which a refusal has not yet
touched the repository. A mismatch retires the session with a sentence naming
the fix (`pnpm deploy-agent <host>`). An agent old enough to omit the field
reads as v0 and is refused the same way.

`AGENT_PROTOCOL` lives in `protocol/session.ts` and NOT beside the message types
it describes, because both files that could host it write to a stream when
imported: `deploy.ts` reading it from `stdio.ts` printed `{"type":"ready"}` onto
its own stdout and exited instead of deploying. A version number has to be
importable without starting an agent.

## What makes this cheaper than it looks

Three seams already exist, and none of them were built for this.

1. **The daemon does not call the SDK — it messages a child process.**
   `worker/main.ts` defines `ToWorker` and `FromWorker`, and `chat.ts` forks it
   (`chat.ts:837`). That union is already a transport-shaped protocol: `start`,
   `turn`, `interrupt`, `close`, `permission` going out; `ready`, `event`,
   `delta`, `permission`, `done`, `closed` coming back. A remote runner is a
   second implementation of that same conversation, over a pipe that happens to
   be ssh.

2. **`RunEventBody` is already the wire format.** The transcript, the event log,
   the profile and the commit gate all consume normalized events, never SDK
   messages — `normalizeSdkMessage` is the single reader of the SDK union, by
   an invariant `agent.ts` and `sessions.ts` both state. Whichever side
   normalizes, the browser is unchanged.

3. **git is already funnelled through one module.** Everything reaches the
   repository through `git()`, `gitDiffing()` and `withTempIndex()` in `git.ts`.
   The number of places that shell out is small and known.

## Decided

### 1. A project names where it runs

`Project` gains a `host`. Absent (or `"local"`) means what every project means
today, so the registry stays readable and every existing entry keeps working
without migration.

```ts
interface Project {
  id: string
  name: string
  root: string          // absolute ON ITS OWN MACHINE
  host?: string         // an alias in ~/.aide/ssh_config; absent = local
  addedAt: string
}
```

`projectId` currently hashes `resolve(root).toLowerCase()`. It must hash the
host too, or `/root/code/app` on two different machines collides into one
project. This is the one change that is not additive, and it only affects ids
for remote projects, which do not exist yet.

### 2. The seam is `Runner`, and it is the worker protocol

Not a new abstraction — a name for the one already in `worker/main.ts`:

```ts
interface Runner {
  send(msg: ToWorker): void
  on(handler: (msg: FromWorker) => void): void
  close(): Promise<void>
}
```

`LocalRunner` is the existing `fork`, unchanged. `SshRunner` spawns
`ssh <host> aide-agent --stdio` and speaks the same NDJSON over stdin/stdout.
`chat.ts` picks one by `project.host` and otherwise does not change: the lock,
`turnUnderHold`, the single-run rule and the interrupt path are all agnostic
about which side of a pipe the agent is on.

**One connection per conversation, not per call.** The 1.4s cost is *per
connection*; a warm session already outlives its turns, so the ssh process
lives exactly as long as the worker it replaces. This is the same reasoning
that made chats hold the SDK session open, and it is why the connection cost
does not land on each message.

### 3. git and `.aide/` move to the far side, together

Both are the same decision: whoever runs the agent runs everything that touches
the tree. `checkpoint.ts`, `changes.ts`, `review.ts`'s checks and
`readProjectDoc` all execute where the files are, at 0.09s, using the code that
exists today unmodified. Only their *results* cross the wire.

This is what keeps the brief's constraints intact rather than reimplemented:
one agent has the repo, the checkpoint is taken before the run, the temp-index
trick still never touches the human's index. A remote project is the same
machine underneath — it is simply not this one.

### 4. Read-only views cost a round trip, and are cached

The rail (`pending`), the history and the branch are polled. Each becomes one
ssh call, which at 92ms is fine per press and not fine on a loop. So: the
poll's remote half backs off, and a run in flight refreshes the rail from the
events it is already streaming rather than by asking again.

### 5. The deny list grows a second category, for remote hosts only

Today's `deniedBash` says of itself: "Each one is a way a run ends badly rather
than a way it does damage." That is an accurate scope decision and the right one
locally — a laptop checkout has a checkpoint behind it and a human at the
keyboard, so the list only has to stop a run wasting its budget or its money.

A remote root shell has neither of those properties for anything OUTSIDE the
repository. The checkpoint covers the working tree; it does not cover `/etc`,
a package manager, or a disk at 85%. So the list gains a second category that
applies when `project.host` is set — destructive-outside-the-repo rather than
ends-badly — and it is per-host rather than global, because widening the local
list to match would be paying a remote machine's cost on a laptop where the
checkpoint already answers it.

This is the compensating control for running as root, and the reason that
decision above is recorded as settled rather than as a risk to worry about
later: the mitigation is a list, and the list is reviewable in a diff.

### 6. The remote half is a separate program

`aide-agent` is its own binary, versioned with the daemon and deployed
deliberately. It is not this package with a flag: it has no Fastify, no
browser, no registry — a stdio loop, the Linux SDK, and the git modules.

The daemon must refuse a version it does not recognise, out loud. A protocol
skew that half-works is the failure mode that produces a corrupted checkpoint,
which is the one thing recoverability rests on.

## Consequences worth stating

- **Credentials live on the far machine.** The SDK authenticates there, with
  its own `~/.claude`. The brief's "no login flow" holds — aide still inherits
  whatever that machine has — but it is a second machine to have set up.
- **Sessions are read where they are written.** `sessions.ts` reads
  `~/.claude/projects/` off local disk; for a remote project that store is over
  there. Listing conversations becomes a remote call.
- **A dropped connection mid-turn is new.** A local worker dies with the
  daemon; an ssh pipe can drop while the agent keeps running. The turn must
  reconcile on reconnect rather than being assumed dead — the run is still
  holding that project's lock.
- **The agent runs as root on `tg`, and that is decided.** `~/.aide/ssh_config`
  says `User root` and the repositories are under `/root/code`. A non-root user
  was raised and declined: this is one person's own box, which is the same
  premise the whole product rests on. Written down so it is not re-litigated —
  but two things follow from it and belong in the build rather than in a
  warning. A checkpoint is taken before every run exactly as it is locally, so
  the safety net is unchanged. And `deniedBash` is the list that matters more
  here than it does on a laptop, because there is no second user to be stopped
  by: `rm -rf /`, a package manager, anything touching `/etc` or `systemd` is a
  command with no undo on a machine you reach over the network.
- **Disk.** `tg` is at 85% (19G free). The SDK binary and a node runtime are
  not free.

## Not doing

- **sshfs, or any mount.** See the table above.
- **A remote project that runs locally.** There is no such thing: `chat.ts`
  picks the runner off `project.host`, so a remote project's agent is always on
  its own machine.
- **Windows hosts.** `listRemoteDirectories` assumes a POSIX shell already.
- **Parallel agents on one remote machine.** Unchanged from the brief:
  parallelism is several projects, not several agents in one.
