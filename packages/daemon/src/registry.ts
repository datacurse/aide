import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { basename, resolve } from "node:path"
import type { Project, ProjectDoc } from "@aide/protocol"
import { EMPTY_PROJECT_DOC } from "@aide/protocol"
import {
  aideHome,
  decisionsDir,
  inboxPath,
  journalDir,
  parseProjectDoc,
  projectDocPath,
  registryPath,
  specsDir,
  stateDir,
  tasksDir,
} from "@aide/protocol/node"
import { isGitRepo, repoRoot } from "./worktree.js"

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
 * The frontmatter is commented out on purpose. aide manages arbitrary repos, and
 * guessing a package manager is worse than doing nothing — a wrong bootstrap
 * command fails every run until someone notices.
 */
const PROJECT_DOC = `---
# Uncomment and set this to whatever makes a fresh checkout of this project
# buildable. It runs ONCE in each new task worktree, before the agent starts,
# because \`git worktree add\` checks out tracked files only — no node_modules,
# no vendor/, no venv.
#
# aide already sets CI=true, NO_COLOR=1 and GIT_TERMINAL_PROMPT=0 for you.
# Inline VAR=value prefixes are not portable here; the command runs through the
# platform shell.
#
# bootstrap: pnpm install --frozen-lockfile
# bootstrapTimeoutMs: 600000
---

# Project

<!--
Why this exists. Read by every agent that works here, as a standing constraint
rather than as part of any one task.

This is the WHY. For HOW to work in the codebase — commands, conventions, what
never to run — use a CLAUDE.md at the repo root instead: it is versioned with the
code it describes, and agents read it from their own worktree.
-->

## Constraints

## Non-goals
`

const STATE_README = `# .aide

Project state for aide, kept as plain files so it stays readable, diffable, and
portable. If aide disappears, this directory is still a description of the project.

| Path | What |
| --- | --- |
| \`project.md\` | Why this exists, constraints, non-goals. You write it. |
| \`tasks/\` | One markdown file per unit of work. Body is the agent prompt. |
| \`inbox.md\` | Freeform dump zone. Consumed by the intake pass. |
| \`specs/\` | One file per feature area. |
| \`roadmap.md\` | Generated, ordered, references spec ids. |
| \`journal/\` | What agents did, written automatically. |
| \`decisions/\` | ADRs. |
| \`worktrees/\` | Per-task git worktrees. Gitignored. |
`

/**
 * Adding a project is `mkdir .aide`, not an import wizard. That is what makes
 * "works with any repo" real rather than aspirational.
 */
export async function scaffoldState(root: string): Promise<void> {
  for (const dir of [tasksDir(root), specsDir(root), journalDir(root), decisionsDir(root)]) {
    await mkdir(dir, { recursive: true })
  }
  const seed: Array<[string, string]> = [
    [projectDocPath(root), PROJECT_DOC],
    [inboxPath(root), ""],
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
    throw new Error(`not a git repository: ${abs} (aide runs each task in a git worktree)`)
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
