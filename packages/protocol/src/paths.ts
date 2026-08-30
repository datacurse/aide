import { homedir } from "node:os"
import { join } from "node:path"
import { STATE_DIR } from "./names.js"

/** `<project>/.aide` */
export const stateDir = (root: string) => join(root, STATE_DIR)
export const projectDocPath = (root: string) => join(stateDir(root), "project.md")
/**
 * Daemon-global state, outside any project: `~/.aide`.
 *
 * `AIDE_HOME` overrides it, and that is not a preference knob — it is what lets
 * `pnpm smoke` and `pnpm smoke:queue` run against a temp directory. Without it
 * they append run logs and board links to the real one, so the tests quietly
 * litter the state directory of whoever runs them.
 *
 * Read on every call rather than captured at module load, so a test can set it
 * after the import graph has been built.
 */
export const aideHome = () => process.env["AIDE_HOME"] ?? join(homedir(), STATE_DIR)
export const registryPath = () => join(aideHome(), "registry.json")
/**
 * `~/.aide/board.json` — which conversations you have ticked off, per project.
 *
 * Outside the repo on purpose. It is the one fact about a chat with nowhere
 * natural to live: it names session ids that only exist under
 * `~/.claude/projects/` on this machine. Everything else the list shows comes
 * from the session store or from git.
 */
export const boardPath = () => join(aideHome(), "board.json")
/**
 * `~/.aide/ssh_config` — the machines aide can add a project from.
 *
 * Beside the registry rather than inside a project, because a machine is not a
 * property of any one repository: the same host usually holds several.
 * Deliberately NOT `~/.ssh/config` — see `ssh.ts` for why aide reads its own.
 */
export const sshConfigPath = () => join(aideHome(), "ssh_config")
export const runsDir = () => join(aideHome(), "runs")
export const runLogPath = (runId: string) => join(runsDir(), `${runId}.ndjson`)

