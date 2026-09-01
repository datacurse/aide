import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { basename, resolve } from "node:path"
import type { Project, ProjectDoc, SshHost } from "@aide/protocol"
import { EMPTY_PROJECT_DOC, STATE_DIR } from "@aide/protocol"
import {
  aideHome,
  parseProjectDoc,
  projectDocPath,
  registryPath,
  stateDir,
} from "@aide/protocol/node"
import { readRepoFile, refHost, refPath, type RepoRef } from "./git.js"
import { isGitRepo, repoRoot } from "./repo.js"
import { remoteRepoRoot, scaffoldRemoteState } from "./ssh.js"

/**
 * Stable across re-adds: the same path on the same machine always yields the
 * same project id.
 *
 * The host is part of the hash, and it has to be: `/root/code/app` exists on
 * more than one machine, and without this those collide into a single registry
 * entry — opening one would show the other's conversations and commit into the
 * wrong checkout.
 *
 * A LOCAL project hashes exactly as it always did, `host` contributing nothing,
 * so every id already in `registry.json` keeps its value. That is what makes
 * this change need no migration; changing the local form would rename every
 * project on disk and orphan its board entries.
 *
 * `resolve()` and `toLowerCase()` are for Windows path spelling and must not be
 * applied to a remote root — POSIX paths are case-sensitive, and `/root/code`
 * resolved against this machine becomes `C:\root\code`.
 */
export const projectIdFor = (root: string, host?: string) =>
  createHash("sha1")
    .update(host ? `${host}\u0000${root}` : resolve(root).toLowerCase())
    .digest("hex")
    .slice(0, 12)

export async function listProjects(): Promise<Project[]> {
  try {
    return JSON.parse(await readFile(registryPath(), "utf8")) as Project[]
  } catch {
    return []
  }
}

export async function getProject(id: string): Promise<Project | undefined> {
  return (await listProjects()).find((p) => p.id === id)
}

async function saveProjects(projects: Project[]): Promise<void> {
  await mkdir(aideHome(), { recursive: true })
  await writeFile(registryPath(), `${JSON.stringify(projects, null, 2)}\n`, "utf8")
}

/**
 * The frontmatter is scaffolded COMMENTED OUT, which is the opposite of what
 * `bootstrap` got and for a reason worth stating. Bootstrap was removed rather
 * than commented because worktrees went and there was nothing left for it to do
 * — scaffolding a setting for a step that no longer exists invites someone to
 * configure nothing. `verify` does something, but only the project's owner knows
 * what this repository's checks are called, and a guessed `pnpm test` that fails
 * on every commit would teach people to reach for "commit anyway" by reflex.
 * So it is shown, named, and inert until somebody fills it in.
 */
const PROJECT_DOC = `---
# Commands that have to pass before aide will write a commit, in order, run from
# the repo root. Uncomment and name this project's own. \`CI=true\` and NO_COLOR
# are supplied for you, so write \`pnpm typecheck\`, not \`CI=true pnpm typecheck\`.
#
# A check can name paths it has nothing to say about, and is then skipped when
# everything in the commit is under them — see the \`unless:\` line below.
#
# verify:
#   - pnpm typecheck
#   - run: pnpm test
#     unless: [docs]
---

# Project

<!--
Why this exists. Read by every agent that works here, as a standing constraint
rather than as part of any one task.

This is the WHY. For HOW to work in the codebase — commands, conventions, what
never to run — use a CLAUDE.md at the repo root instead: it is versioned with the
code it describes, and agents pick it up from the checkout they are working in.
-->

## Constraints

## Non-goals
`

const STATE_README = `# .aide

Project state for aide, kept as plain files so it stays readable, diffable, and
portable. If aide disappears, this directory is still a description of the project.

| Path | What |
| --- | --- |
| \`project.md\` | Why this exists, constraints, non-goals. Rarely changes. |

Agents read \`project.md\` on every turn, so it is where a constraint belongs.
Its frontmatter holds \`verify:\` — the commands that have to pass before aide
will write a commit. What is finished is decided by you alone — see the tick
beside a chat.
`

/**
 * Adding a project is `mkdir .aide`, not an import wizard. That is what makes
 * "works with any repo" real rather than aspirational.
 */
/**
 * What a fresh `.aide/` contains, as `[name, content]`.
 *
 * Shared with the remote add, which writes the same two files over ssh. A
 * remote project scaffolded from a second copy of this text would be a second
 * answer to "what is a project", and the brief is the first thing anybody
 * reads.
 */
export const STATE_SEED: Array<[string, string]> = [
  ["project.md", PROJECT_DOC],
  ["README.md", STATE_README],
]

export async function scaffoldState(root: string): Promise<void> {
  // Directories only where something actually lands. Empty ones are worse than
  // absent ones: they promise a structure that does not exist and quietly shame
  // you for not filling them, which is what `tasks/`, `specs/`, `journal/` and
  // `decisions/` did in every project aide ever touched.
  await mkdir(stateDir(root), { recursive: true })
  const seed: Array<[string, string]> = [
    [projectDocPath(root), PROJECT_DOC],
    [`${stateDir(root)}/README.md`, STATE_README],
  ]
  for (const [path, content] of seed) {
    if (!existsSync(path)) await writeFile(path, content, "utf8")
  }
}

/**
 * Read `.aide/project.md` from the project's MAIN checkout.
 *
 * The main tree, not the worktree, for two reasons: it is where the human edits
 * the file, and it is the only copy that exists when `.aide/` is untracked.
 * Reading the worktree's copy would hand the agent whatever the doc said at the
 * branch point.
 *
 * A missing file is normal — `.aide/` may predate this, or the human may have
 * deleted it — and means "no project context", not an error.
 *
 * Takes a `RepoRef` rather than a path, because for a remote project the file is
 * on the far machine and `node:fs` here would miss it every time. It did: the
 * agent ran with no brief and, worse, the commit gate read no `verify:` commands
 * and skipped every check — silently in both cases, since "absent" is a legal
 * answer. A bare string still compiles and still means "here".
 */
export async function readProjectDoc(ref: RepoRef): Promise<ProjectDoc> {
  const raw = await readRepoFile(ref, STATE_DIR, "project.md")
  if (raw === null) return EMPTY_PROJECT_DOC
  try {
    return parseProjectDoc(raw)
  } catch (err) {
    // Re-thrown with the path, because "bootstrap must be a string" is not
    // actionable without knowing which file said it — and for a remote project
    // it must name the machine, or it points at a path on the wrong one.
    const where = refHost(ref) ? `${refHost(ref)}:` : ""
    throw new Error(
      `${where}${refPath(ref, STATE_DIR, "project.md")}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

export async function addProject(inputPath: string): Promise<Project> {
  const abs = resolve(inputPath)
  if (!existsSync(abs)) throw new Error(`no such directory: ${abs}`)
  if (!(await isGitRepo(abs))) {
    throw new Error(
      `not a git repository: ${abs} (aide reviews work as a diff, and snapshots the tree before each run, so it needs git)`,
    )
  }

  // Normalize to the repo root so adding a subdirectory does not create a second
  // registry entry for the same project.
  const root = (await repoRoot(abs)) ?? abs
  const id = projectIdFor(root)

  const projects = await listProjects()
  const existing = projects.find((p) => p.id === id)
  if (existing) {
    await scaffoldState(root)
    return existing
  }

  const project: Project = {
    id,
    name: basename(root),
    root,
    addedAt: new Date().toISOString(),
  }
  await scaffoldState(root)
  await saveProjects([...projects, project])
  return project
}

/**
 * Add a project that lives on another machine.
 *
 * The same three steps the local add takes — is it a repository, normalize to
 * its root, scaffold `.aide/` — each done over ssh, because the answers are
 * facts about the far machine's disk and this one cannot see it.
 *
 * The agent is NOT checked for here. A machine with no `aide-agent` on it can
 * still be registered, browsed and read; what it cannot do is run a turn, and
 * that refusal comes from `SshRunner` with a sentence naming
 * `pnpm deploy-agent`. Refusing the add instead would mean you cannot put a
 * project in the rail until you have deployed to it, which inverts the order
 * anybody actually works in.
 */
export async function addRemoteProject(host: SshHost, inputPath: string): Promise<Project> {
  const root = await remoteRepoRoot(host, inputPath)
  if (!root) {
    throw new Error(
      `not a git repository: ${inputPath} on ${host.alias} (aide reviews work as a diff, and snapshots the tree before each run, so it needs git)`,
    )
  }

  const id = projectIdFor(root, host.alias)
  const projects = await listProjects()
  const existing = projects.find((p) => p.id === id)
  if (existing) {
    await scaffoldRemoteState(host, root, STATE_SEED)
    return existing
  }

  const project: Project = {
    id,
    // The directory name, and the host beside it: two machines with a `code`
    // checkout would otherwise put two identical rows in the rail.
    name: `${root.split("/").filter(Boolean).pop() ?? root} · ${host.alias}`,
    root,
    host: host.alias,
    addedAt: new Date().toISOString(),
  }
  await scaffoldRemoteState(host, root, STATE_SEED)
  await saveProjects([...projects, project])
  return project
}

export async function removeProject(id: string): Promise<void> {
  // Registry entry only. The project's own .aide/ stays on disk, because it is
  // the project's state and not aide's to delete.
  await saveProjects((await listProjects()).filter((p) => p.id !== id))
}
