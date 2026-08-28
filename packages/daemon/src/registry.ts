import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { basename, resolve } from "node:path"
import type { Project, ProjectDoc } from "@aide/protocol"
import { DEFAULT_TODOS, EMPTY_PROJECT_DOC } from "@aide/protocol"
import {
  aideHome,
  parseProjectDoc,
  projectDocPath,
  registryPath,
  stateDir,
  todosPath,
} from "@aide/protocol/node"
import { isGitRepo, repoRoot } from "./repo.js"

/** Stable across re-adds: the same path always yields the same project id. */
const projectId = (root: string) =>
  createHash("sha1").update(resolve(root).toLowerCase()).digest("hex").slice(0, 12)

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
 * No frontmatter, because there is no longer anything in it aide acts on.
 *
 * There used to be a `bootstrap` command, run once in each fresh worktree
 * because `git worktree add` checks out tracked files only and left the agent
 * without `node_modules`. Runs work the project's own checkout now, which is
 * already installed, so scaffolding a commented-out setting for a step that no
 * longer exists would be inviting someone to configure nothing.
 */
const PROJECT_DOC = `# Project

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
| \`todos.md\` | The backlog. One line per row; aide numbers them. |
| \`spec.md\` | What this project can and cannot do. Agents keep it current. |

Both \`todos.md\` and \`spec.md\` are written by agents as well as by you. What
is finished is decided by you alone — see the verdict buttons in a chat.
`

/**
 * Adding a project is `mkdir .aide`, not an import wizard. That is what makes
 * "works with any repo" real rather than aspirational.
 */
export async function scaffoldState(root: string): Promise<void> {
  // Directories only where something actually lands. Empty ones are worse than
  // absent ones: they promise a structure that does not exist and quietly shame
  // you for not filling them, which is what `tasks/`, `specs/`, `journal/` and
  // `decisions/` did in every project aide ever touched.
  await mkdir(stateDir(root), { recursive: true })
  const seed: Array<[string, string]> = [
    [projectDocPath(root), PROJECT_DOC],
    [todosPath(root), DEFAULT_TODOS],
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
 */
export async function readProjectDoc(root: string): Promise<ProjectDoc> {
  let raw: string
  try {
    raw = await readFile(projectDocPath(root), "utf8")
  } catch {
    return EMPTY_PROJECT_DOC
  }
  try {
    return parseProjectDoc(raw)
  } catch (err) {
    // Re-thrown with the path, because "bootstrap must be a string" is not
    // actionable without knowing which file said it.
    throw new Error(
      `${projectDocPath(root)}: ${err instanceof Error ? err.message : String(err)}`,
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
  const id = projectId(root)

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

export async function removeProject(id: string): Promise<void> {
  // Registry entry only. The project's own .aide/ stays on disk, because it is
  // the project's state and not aide's to delete.
  await saveProjects((await listProjects()).filter((p) => p.id !== id))
}
