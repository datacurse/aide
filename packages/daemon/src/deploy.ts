/**
 * Put `aide-agent` on a machine, or bring the one that is there up to date.
 *
 * `pnpm deploy-agent <host>`, where `<host>` is an alias in
 * `~/.aide/ssh_config`.
 *
 * ## Why a file copy and an `npm install`, rather than a bundle
 *
 * The obvious shape is a single bundled `.mjs` — one artifact, nothing to
 * install. It was not chosen for two reasons, and the first is decisive:
 * bundling needs a bundler, and `packages/daemon` has four dependencies on
 * purpose. Adding esbuild to ship a file that `scp` can ship is a poor trade.
 *
 * The second is that the SDK could not be bundled anyway. It resolves a NATIVE
 * binary through optional dependencies — `claude-agent-sdk-linux-x64` on that
 * machine, `-win32-x64` on this one — so the far side has to run its own
 * install regardless. Since an install is happening, the source may as well
 * arrive as source: it is five files, and a stack trace from the remote agent
 * then points at code you can read.
 *
 * ## What actually goes
 *
 * The agent's runtime graph, and nothing else — verified by reading the
 * imports rather than by copying the package and hoping:
 *
 *   stdio.ts -> loop.ts -> agent.ts -> policy.ts
 *                       -> main.ts (types only)
 *
 * plus the protocol package, which is types and pure helpers. No Fastify, no
 * registry, no picker, no web bundle. `agent.ts` is the only file that imports
 * the SDK.
 */
import { execFile, spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
// From the protocol package, NOT from `worker/stdio.js` — importing that file
// starts an agent and writes to stdout. See `AGENT_PROTOCOL`.
import { AGENT_PROTOCOL, connectableHosts, parseSshConfig } from "@aide/protocol"
import { sshConfigPath } from "@aide/protocol/node"

const run = promisify(execFile)

/** Where the agent lives on the far side. Under `~/.aide/`, like everything else. */
const REMOTE_DIR = "~/.aide/agent"

const HERE = dirname(fileURLToPath(import.meta.url))
const DAEMON_SRC = HERE
const PROTOCOL_SRC = join(HERE, "..", "..", "protocol", "src")

/**
 * The files the agent needs, as `[local, remote]`.
 *
 * Listed rather than globbed. A glob would quietly start shipping whatever
 * lands in `src/` next — `server.ts` and its Fastify dependency included — and
 * the failure would be an install that pulls a web framework onto a machine
 * that only ever needed to run one agent.
 */
/**
 * The protocol's browser-safe half, READ OFF `index.ts` rather than listed here.
 *
 * `node.ts`, `paths.ts` and `project-io.ts` are excluded for free by that: the
 * barrel is browser-safe by its own rule, so what it re-exports is exactly what
 * has no `node:*` import and no gray-matter — and nothing the agent runs reads
 * `project.md` anyway, the daemon does that and sends the prose in the job.
 *
 * Hand-listed once, and it drifted the moment the package changed: `todo.ts`
 * was deleted with the backlog file and eight modules were added after it, so a
 * deploy died on `stat local todo.ts` AFTER the remote install had run — and had
 * that one name still existed, the failure would instead have been a remote
 * agent crashing on its first turn with `cannot find module ./gates.js`, which is
 * the same drift arriving somewhere far more expensive. The barrel cannot go
 * stale the same way, because the web bundle stops building when it is wrong.
 */
async function protocolFiles(): Promise<string[]> {
  const barrel = await readFile(join(PROTOCOL_SRC, "index.ts"), "utf8")
  // The emitted specifiers are `./name.js` (verbatimModuleSyntax means the
  // source says what the runtime resolves), and the files on disk are `.ts`.
  const names = [...barrel.matchAll(/^export \* from "\.\/([\w-]+)\.js"/gm)].map((m) => m[1])
  if (names.length === 0) throw new Error("no exports found in protocol/src/index.ts")
  return ["index.ts", ...names.map((n) => `${n}.ts`)]
}

export const filesToShip = async (): Promise<Array<[string, string]>> => [
  [join(DAEMON_SRC, "agent.ts"), "src/agent.ts"],
  [join(DAEMON_SRC, "policy.ts"), "src/policy.ts"],
  [join(DAEMON_SRC, "worker", "loop.ts"), "src/worker/loop.ts"],
  [join(DAEMON_SRC, "worker", "main.ts"), "src/worker/main.ts"],
  [join(DAEMON_SRC, "worker", "stdio.ts"), "src/worker/stdio.ts"],
  // The protocol lands as a real package under `node_modules/@aide/protocol`,
  // NOT as a loose directory with the imports rewritten. The copied sources say
  // `from "@aide/protocol"` exactly as they do here, so what runs on the far
  // side is byte-identical to what is in the repository — which is what makes a
  // remote stack trace mean something, and what stops a deploy step from
  // becoming a place where behaviour can differ.
  ...(await protocolFiles()).map(
    (name) =>
      [join(PROTOCOL_SRC, name), `node_modules/@aide/protocol/${name}`] as [string, string],
  ),
]

/**
 * The far side's `package.json`.
 *
 * `@aide/protocol` is a real directory under `node_modules/` rather than a
 * workspace link, because there is no pnpm workspace over there — and npm must
 * not try to fetch it from the registry, where it does not exist. Placing the
 * files directly and never listing it as a dependency is what keeps `npm
 * install` looking only for the SDK.
 *
 * The SDK version is pinned to whatever this checkout resolved, so the two ends
 * run the same agent rather than "whatever npm felt like today".
 */
const remotePackageJson = (sdkVersion: string) =>
  `${JSON.stringify(
    {
      name: "aide-agent",
      version: "0.0.0",
      private: true,
      type: "module",
      dependencies: { "@anthropic-ai/claude-agent-sdk": sdkVersion },
      devDependencies: { tsx: "^4.23.12" },
    },
    null,
    2,
  )}\n`

/** The protocol package's own manifest, so `@aide/protocol` resolves. */
const PROTOCOL_PACKAGE_JSON = `${JSON.stringify(
  {
    name: "@aide/protocol",
    version: "0.0.0",
    private: true,
    type: "module",
    // Bare `.` and `./node`, matching how the daemon imports it here. `node`
    // maps to the same browser-safe index: the agent never calls the two
    // filesystem helpers that entry point adds, and shipping them would drag
    // gray-matter along for nothing.
    exports: { ".": "./index.ts", "./node": "./index.ts" },
  },
  null,
  2,
)}\n`

/**
 * The entry point, as a shell script.
 *
 * `tsx` rather than a build step, matching how the daemon runs its own source —
 * and `--stdio` is passed through so the binary reads the same either side.
 *
 * `exec` so the ssh session's process IS node, not a shell holding a child:
 * without it, closing stdin kills the shell and leaves the agent orphaned,
 * which is exactly the case `SshRunner.kill()` relies on working.
 */
const LAUNCHER = `#!/bin/sh
# Written by aide's deploy-agent. Do not edit; it is overwritten on each deploy.
cd "$(dirname "$0")" || exit 1
exec ./node_modules/.bin/tsx src/worker/stdio.ts "$@"
`

const ssh = (host: string, command: string) =>
  run("ssh", ["-o", "BatchMode=yes", "-F", sshConfigPath(), host, command], {
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  })

async function main(): Promise<void> {
  const alias = process.argv[2]
  if (!alias) {
    console.error("usage: pnpm deploy-agent <host>   (a Host in ~/.aide/ssh_config)")
    process.exit(1)
  }

  const hosts = connectableHosts(parseSshConfig(await readFile(sshConfigPath(), "utf8")))
  if (!hosts.some((h) => h.alias === alias)) {
    console.error(`no host named ${alias} in ${sshConfigPath()}`)
    console.error(`known: ${hosts.map((h) => h.alias).join(", ") || "(none)"}`)
    process.exit(1)
  }

  // The version this checkout actually resolved, so both ends agree.
  const sdkVersion = JSON.parse(
    await readFile(join(HERE, "..", "package.json"), "utf8"),
  ).dependencies["@anthropic-ai/claude-agent-sdk"] as string

  console.log(`deploying to ${alias} (protocol v${AGENT_PROTOCOL}, sdk ${sdkVersion})`)

  // Resolved BEFORE anything is done to the far side. A missing source used to
  // surface as a failed `scp` after the remote install had already run, which
  // leaves the machine holding a half-deployed agent: new package.json, new
  // launcher, installed SDK, and sources from the previous deploy.
  const files = await filesToShip()
  for (const [local] of files) {
    await readFile(local).catch(() => {
      throw new Error(`cannot ship ${local}: no such file`)
    })
  }

  console.log("  writing package.json and launcher")
  // Through stdin rather than as an argument, so a JSON document full of braces
  // and quotes never has to survive a shell. `spawn` and not `execFile`: the
  // latter has no way to supply stdin at all.
  const write = (path: string, content: string) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(
        "ssh",
        ["-o", "BatchMode=yes", "-F", sshConfigPath(), alias, `cat > ${REMOTE_DIR}/${path}`],
        { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] },
      )
      let stderr = ""
      child.stderr?.on("data", (b: Buffer) => {
        stderr += b.toString()
      })
      child.on("error", reject)
      child.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(stderr.trim() || `ssh exited ${code}`)),
      )
      child.stdin?.end(content)
    })
  await ssh(alias, `mkdir -p ${REMOTE_DIR}`)
  await write("package.json", remotePackageJson(sdkVersion))
  await write("aide-agent", LAUNCHER)
  await ssh(alias, `chmod +x ${REMOTE_DIR}/aide-agent`)

  // BEFORE the sources are copied, and the order is load-bearing: npm prunes
  // packages it does not know about, so a hand-placed `node_modules/@aide`
  // written first is deleted by the install that follows it. Installing first
  // and copying second leaves the tree npm built untouched.
  console.log("  npm install (this pulls the platform SDK binary)")
  const { stdout } = await ssh(
    alias,
    `cd ${REMOTE_DIR} && npm install --no-audit --no-fund 2>&1 | tail -3`,
  )
  console.log(
    stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => `    ${l}`)
      .join("\n"),
  )

  console.log("  preparing directories")
  await ssh(alias, `mkdir -p ${REMOTE_DIR}/src/worker ${REMOTE_DIR}/node_modules/@aide/protocol`)

  // One scp per file rather than a tarball: `tar` is not on every minimal
  // image, and a handful of small transfers is a second or two. Correctness
  // over cleverness for a step that runs rarely.
  console.log(`  copying ${files.length} files`)
  for (const [local, remote] of files) {
    await run(
      "scp",
      ["-o", "BatchMode=yes", "-F", sshConfigPath(), local, `${alias}:${REMOTE_DIR}/${remote}`],
      { windowsHide: true },
    )
  }
  await write("node_modules/@aide/protocol/package.json", PROTOCOL_PACKAGE_JSON)

  console.log(`\ndeployed to ${alias}:${REMOTE_DIR}`)
}

// Only when RUN, never when imported. `pnpm smoke` imports this module for
// `filesToShip` — the manifest is the thing that drifted — and a bare top-level
// `main()` would make that import deploy to whatever `process.argv[2]` happened
// to hold.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main()
