import { homedir } from "node:os"
import { join } from "node:path"
import { STATE_DIR } from "./names.js"



/** `<project>/.aide` */
export const stateDir = (root: string) => join(root, STATE_DIR)
/** `<project>/.aide/decisions` — later */
export const decisionsDir = (root: string) => join(stateDir(root), "decisions")

export const projectDocPath = (root: string) => join(stateDir(root), "project.md")
/** `<project>/.aide/todos.md` — the backlog, git-tracked */
export const todosPath = (root: string) => join(stateDir(root), "todos.md")
/** `<project>/.aide/spec.md` — what the app can and cannot do, git-tracked */
export const specPath = (root: string) => join(stateDir(root), "spec.md")
export const inboxPath = (root: string) => join(stateDir(root), "inbox.md")
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
 * `~/.aide/board.json` — row id to session id, per project.
 *
 * Outside the repo on purpose. It is the one fact about the board with nowhere
 * natural to live: it churns as chats start and close, and it names session ids
 * that only exist under `~/.claude/projects/` on this machine. Everything else
 * the board shows is either in `todos.md` or already known to git.
 */
export const boardPath = () => join(aideHome(), "board.json")
export const runsDir = () => join(aideHome(), "runs")
export const runLogPath = (runId: string) => join(runsDir(), `${runId}.ndjson`)

