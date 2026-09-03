/**
 * `.aide/project.md` — one file with two readers.
 *
 * The frontmatter is configuration the daemon acts on; the prose below it is
 * context the agent reads. gray-matter strips the frontmatter from `content`, so
 * neither half ever sees the other's, and the file stays a single hand-editable
 * markdown document rather than a config file plus a doc file that drift apart.
 *
 * Frontmatter rather than a new `.aide/config.json` because `.aide/` being
 * markdown-only is what makes "if aide disappears, this directory is still a
 * readable description of the project" true.
 */

/** A git repository aide has been pointed at. */
export interface Project {
  id: string
  name: string
  /** Absolute path to the git repo root, ON ITS OWN MACHINE. */
  root: string
  /**
   * The machine it lives on: an alias in `~/.aide/ssh_config`.
   *
   * Absent means this one, which is what every project written before remote
   * ones existed means — so the registry needs no migration and a local project
   * keeps exactly the shape it had.
   */
  host?: string
  /** ISO 8601. */
  addedAt: string
}

/**
 * What the machine's own folder dialog came back with.
 *
 * Three outcomes in two fields, and a caller that collapses any two of them gets
 * it wrong. A path is a pick. Both null is a cancel, which is not an error and
 * must put nothing on screen. `unavailable` is "there was no dialog to open
 * here" — the only case where falling back to typing a path is the right answer,
 * and the reason it is a sentence rather than a boolean.
 */
export interface FolderPick {
  path: string | null
  unavailable: string | null
}

/**
 * Frontmatter keys aide used to act on and no longer does.
 *
 * `bootstrap` ran a project's setup command in each fresh worktree, because
 * `git worktree add` checks out tracked files only and left the agent with no
 * `node_modules`. Runs work the project's own checkout now, which already has
 * its dependencies, so there is nothing left for the command to do.
 *
 * Named rather than deleted, because silently ignoring a line someone wrote is
 * the failure mode this file's validation exists to prevent. A project.md that
 * still sets one gets a warning on the board until it is cleaned up.
 */
export const RETIRED_DOC_KEYS = ["bootstrap", "bootstrapTimeoutMs"] as const

export interface ProjectDoc {
  /** The prose below the frontmatter. This is what reaches the agent. */
  body: string
  /** Retired keys this file still sets. Empty for every up-to-date project. */
  retired: string[]
  /**
   * Commands that decide whether this project's tree is sound, run in order
   * before a commit is written.
   *
   * This is the half of "a gate on the code" that was missing. The agent already
   * runs a project's checks most of the time and then reports the result itself,
   * which makes the only evidence that a diff is sound a sentence written by the
   * thing being checked. These run outside the model, in aide, and what they
   * printed goes in the log — so "all four commands green" stops being a claim.
   *
   * Empty for a project that declares none, and an empty list means no gate
   * rather than a gate that always opens: nothing is asserted about a tree
   * nobody said how to check.
   *
   * Written WITHOUT an env prefix — `pnpm typecheck`, not `CI=true pnpm
   * typecheck`. `CONFIG.runEnv` supplies that to these the same way it supplies
   * it to an agent's shell, which is what keeps one command working on both a
   * POSIX shell and cmd.exe.
   */
  verify: VerifyCheck[]
}

/** One command the gate runs, and the diffs it has nothing to say about. */
export interface VerifyCheck {
  command: string
  /**
   * Paths this check is irrelevant to. Empty means it always runs.
   *
   * Stated as what a check does NOT cover rather than what it does, and the
   * asymmetry is the whole safety argument. Listing coverage would mean a file
   * nobody remembered to add is a file whose check silently stops running —
   * a gate eroding as the codebase grows, invisibly, which is the exact failure
   * `parseVerify` below exists to prevent. Listing irrelevance fails the other
   * way: anything unlisted counts as relevant, so a new file makes the check run
   * when it need not have. That costs seconds. The other costs correctness.
   *
   * A path or a directory, repo-relative. `packages/web` covers everything at or
   * under it.
   */
  unless: string[]
}

export const EMPTY_PROJECT_DOC: ProjectDoc = {
  body: "",
  retired: [],
  verify: [],
}

/**
 * Frontmatter's `verify:` into the list a commit runs.
 *
 * Throws rather than falling back, which is the rule this file's validation
 * exists for and the reason it is worth having at all: a mistyped key that
 * silently becomes an empty list is a gate that quietly stopped being one, and
 * the failure is invisible — every commit goes through, exactly as it did
 * before, and nothing on screen says the checks are no longer running.
 *
 * A throw surfaces where the file is read, which is the start of a run and the
 * press of a commit — both places a configuration mistake should appear.
 */
export function parseVerify(value: unknown): VerifyCheck[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new Error("`verify:` in .aide/project.md must be a list of shell commands")
  }
  return value.map((entry) => {
    // A bare string is the whole of the old form and still means what it always
    // meant: run this on every commit. Anything scoped opts in by naming itself.
    if (typeof entry === "string") {
      if (!entry.trim()) {
        throw new Error("every entry under `verify:` in .aide/project.md must be a command")
      }
      return { command: entry.trim(), unless: [] }
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error("every entry under `verify:` in .aide/project.md must be a command")
    }
    const { run, unless } = entry as { run?: unknown; unless?: unknown }
    if (typeof run !== "string" || !run.trim()) {
      throw new Error("a `verify:` entry with settings needs `run:` naming the command")
    }
    return { command: run.trim(), unless: parseUnless(unless, run.trim()) }
  })
}

/**
 * `unless:` into repo-relative prefixes.
 *
 * Throws on a path that could never match one — absolute, or reaching upwards.
 * It would be harmless at runtime, since a prefix that matches nothing just
 * means the check always runs, and that is the safe direction. It throws anyway
 * because this file is hand-edited and the author plainly meant something: a
 * scope silently doing nothing is how you end up believing a commit is fast for
 * a reason that was never true.
 */
function parseUnless(value: unknown, command: string): string[] {
  if (value === undefined || value === null) return []
  const list = Array.isArray(value) ? value : [value]
  return list.map((raw) => {
    if (typeof raw !== "string" || !raw.trim()) {
      throw new Error(`every path under \`unless:\` for \`${command}\` must be a path`)
    }
    const path = normalizePath(raw)
    if (!path || path.startsWith("/") || path === ".." || path.startsWith("../")) {
      throw new Error(
        `\`unless:\` for \`${command}\` takes repo-relative paths; \`${raw.trim()}\` is not one`,
      )
    }
    return path
  })
}

/**
 * One spelling of a path, so a comparison means something.
 *
 * Windows: paths out of git come back with forward slashes and paths off the
 * filesystem do not, and a hand-written `packages\web` would match neither. The
 * trailing slash goes for the same reason — `packages/web/` and `packages/web`
 * are the same directory to everyone except `startsWith`.
 */
function normalizePath(raw: string): string {
  return raw.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "")
}

/** A path is at or under a prefix. Both already normalized. */
function covers(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`)
}

export interface VerifyPlan {
  /** The checks to run, in the order they were declared. */
  run: VerifyCheck[]
  /** The ones this diff cannot break, and why they were left out. */
  skipped: Array<{ command: string; reason: string }>
}

/**
 * Which of a project's checks this particular diff is worth running.
 *
 * The gate used to run every declared check on every commit, which meant a
 * commit touching only React components spent twelve seconds re-proving git
 * plumbing that nothing had changed. That is not thoroughness, it is a tax that
 * teaches people to reach for "commit anyway".
 *
 * Skipped ONLY when every changed path is under one of the check's `unless`
 * paths. One path outside and it runs — including a path nobody anticipated,
 * which is the point of stating irrelevance rather than coverage.
 *
 * An empty diff runs everything. It should be unreachable, since a commit with
 * nothing in it is refused before this, but "we could not tell what changed" has
 * to mean "run the checks" or this function becomes a way to skip the gate.
 */
export function planChecks(
  checks: readonly VerifyCheck[],
  changed: readonly string[],
): VerifyPlan {
  const paths = changed.map(normalizePath).filter(Boolean)
  const plan: VerifyPlan = { run: [], skipped: [] }

  for (const check of checks) {
    if (check.unless.length === 0 || paths.length === 0) {
      plan.run.push(check)
      continue
    }
    // The prefixes that did the covering, not the whole `unless` list: naming a
    // directory the diff never went near would read as an explanation and be
    // noise.
    const used = check.unless.filter((prefix) => paths.some((path) => covers(prefix, path)))
    const allCovered = paths.every((path) => check.unless.some((prefix) => covers(prefix, path)))
    if (!allCovered) {
      plan.run.push(check)
      continue
    }
    plan.skipped.push({
      command: check.command,
      reason: `everything that changed is under ${used.join(", ")}`,
    })
  }
  return plan
}

