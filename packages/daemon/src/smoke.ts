/**
 * End-to-end check of the git plumbing behind commit and land: `pnpm smoke`.
 *
 * It builds a throwaway repo in the temp directory and drives the real
 * functions against it — no mocks, no model calls, nothing to clean up in your
 * own projects. Worth running on any change to worktree.ts, because the failure
 * modes here are the expensive kind: a half-merged repo, a commit that silently
 * dropped its message body, a land that refuses forever, a shell policy that
 * lets through what it should not.
 *
 * It is deliberately not a test framework. One file, one command, plain output.
 */
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { writeJournalEntry } from "./journal.js"
import { checkBashCommand } from "./policy.js"
import {
  commitWorktree,
  currentBranch,
  ensureWorktree,
  mergeTaskBranch,
  recentSubjects,
  removeWorktree,
  withTrailers,
  workingTreeDirt,
  worktreeDiff,
  worktreeDiffStat,
} from "./worktree.js"
import { STATE_DIR } from "@aide/protocol"
import type { Project, RunEvent, Task } from "@aide/protocol"

const run = promisify(execFile)
const git = async (cwd: string, args: string[]) =>
  (await run("git", ["-C", cwd, ...args], { windowsHide: true })).stdout

let failures = 0
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures += 1
}

const root = await mkdtemp(join(tmpdir(), "aide-smoke-"))
console.log(`repo: ${root}\n`)

await git(root, ["init", "-b", "main"])
await git(root, ["config", "user.email", "smoke@aide.test"])
await git(root, ["config", "user.name", "aide smoke"])
await writeFile(join(root, "README.md"), "# smoke\n", "utf8")
await git(root, ["add", "-A"])
await git(root, ["commit", "-m", "Add a readme"])
await writeFile(join(root, "app.ts"), "export const n = 1\n", "utf8")
await git(root, ["add", "-A"])
await git(root, ["commit", "-m", "Add app entrypoint"])

console.log("worktree")
const { path: wt, created } = await ensureWorktree(root, "0001")
check("created", existsSync(wt), wt)
check("reports it created one", created, "this is what gates the bootstrap command")
check("second call reports NOT created", !(await ensureWorktree(root, "0001")).created)
check(
  "ignored via .git/info/exclude",
  (await readFile(join(root, ".git", "info", "exclude"), "utf8")).includes(".aide/worktrees/"),
)
check(
  "project .gitignore untouched",
  !existsSync(join(root, ".gitignore")),
  "aide must not dirty a tracked file",
)
check("repo still clean after a worktree", (await git(root, ["status", "--porcelain"])).trim() === "")

console.log("\nchanges")
await writeFile(join(wt, "app.ts"), "export const n = 2\n", "utf8")
await mkdir(join(wt, "lib"), { recursive: true })
await writeFile(join(wt, "lib/new.ts"), "export const added = true\n", "utf8")

const stat = await worktreeDiffStat(wt)
const diff = await worktreeDiff(wt)
check("stat sees the modified file", stat.includes("app.ts"), stat.trim().split("\n").at(-1) ?? "")
check("stat sees the CREATED file", stat.includes("new.ts"), "intent-to-add is load-bearing")
check("diff has hunks", diff.includes("+export const added = true"))

console.log("\nhouse style")
const subjects = await recentSubjects(root)
check("reads recent subjects", subjects.length === 2, JSON.stringify(subjects))

console.log("\ncommit")
const message = withTrailers("Bump n and add lib\n\nBecause the smoke test says so.", "0001", "run-abc")
check("trailer appended", message.includes("Aide-Task: 0001") && message.includes("Aide-Run: run-abc"))
check("trailer is idempotent", withTrailers(message, "0001", "run-abc") === message)

const sha = await commitWorktree(wt, message)
check("returns a sha", /^[0-9a-f]{40}$/.test(sha), sha)
const body = await git(wt, ["log", "-1", "--format=%B"])
check("multi-line message survived", body.includes("Because the smoke test says so."))
check("trailer is in the commit", body.includes("Aide-Task: 0001"))
check("worktree is now clean", (await git(wt, ["status", "--porcelain"])).trim() === "")

let threw = ""
try {
  await commitWorktree(wt, "nothing here")
} catch (err) {
  threw = err instanceof Error ? err.message : String(err)
}
check("refuses an empty commit", threw.includes("nothing to commit"), threw)

console.log("\nagent scope — the agent may write specs, but not aide's own bookkeeping")
await mkdir(join(wt, STATE_DIR, "tasks"), { recursive: true })
await mkdir(join(wt, STATE_DIR, "specs"), { recursive: true })
await writeFile(join(wt, STATE_DIR, "tasks", "0009-stale.md"), "stale snapshot\n", "utf8")
await writeFile(join(wt, STATE_DIR, "specs", "queue.md"), "# Queue\n", "utf8")
const scopedDiff = await worktreeDiff(wt)
check("hides .aide/tasks", !scopedDiff.includes("0009-stale.md"), "daemon-owned")
check("shows .aide/specs", scopedDiff.includes("queue.md"), "agent output must be landable")
const scopedSha = await commitWorktree(wt, "Add a queue spec\n")
const shown = await git(wt, ["show", "--stat", "--format=", scopedSha])
check("commit matches the reviewed diff", !shown.includes("0009-stale.md") && shown.includes("queue.md"))
check("worktree still holds the untracked task file", existsSync(join(wt, STATE_DIR, "tasks", "0009-stale.md")))

console.log("\nbash policy")
{
  const allow = ["pnpm", "npm", "git status", "git diff"]
  const deny = ["pnpm dev", "pnpm probe", "npx"]
  const verdict = (cmd: unknown) => checkBashCommand(cmd, allow, deny)

  check("allows pnpm typecheck", verdict("pnpm typecheck").allow)
  check("allows a bare allowed word", verdict("pnpm").allow)
  check("allows git diff with args", verdict("git diff --stat").allow)
  check("denies an unlisted command", !verdict("curl https://example.com").allow)
  check("denies a near-miss prefix", !verdict("pnpmx run").allow, "prefix must end at a word")
  check("denies pnpm dev", !verdict("pnpm dev").allow, "it never exits")
  check("denies pnpm  dev with padding", !verdict("pnpm   dev").allow, "whitespace is collapsed")
  check("denies pnpm probe", !verdict("pnpm probe").allow, "it spends money")
  check("denies npx", !verdict("npx cowsay").allow)
  check("denies a pipe", !verdict("pnpm ls | head").allow)
  check("denies chaining", !verdict("cd packages && pnpm test").allow)
  check("denies substitution", !verdict("pnpm $(echo dev)").allow, "the payload hides in the arg")
  check("denies backticks", !verdict("pnpm `echo dev`").allow)
  check("denies redirection", !verdict("pnpm ls > /tmp/x").allow)
  check("denies a newline", !verdict("pnpm ls\nrm -rf /").allow)
  check("denies a non-string", !verdict(undefined).allow)
  check("denial says what to do instead", verdict("cd x && pnpm t").reason.includes("--filter"))
}

console.log("\njournal")
const project: Project = { id: "p1", name: "smoke", root, addedAt: new Date().toISOString() }
const task: Task = {
  id: "0001",
  title: "Bump n",
  status: "needs-review",
  branch: "aide/task-0001",
  worktree: ".aide/worktrees/task-0001",
  runs: ["run-abc"],
  commits: [],
  created: new Date().toISOString(),
  prompt: "Change n from 1 to 2 and add a lib file.",
  file: "0001-bump-n.md",
}
const events: RunEvent[] = [
  { runId: "run-abc", seq: 1, ts: Date.now(), type: "run.started", taskId: "0001", projectId: "p1", model: "claude-opus-5", cwd: wt, worktree: task.worktree, sessionId: "s1" },
  { runId: "run-abc", seq: 2, ts: Date.now(), type: "tool.start", toolUseId: "t1", name: "Read", input: {}, parentToolUseId: null },
  { runId: "run-abc", seq: 3, ts: Date.now(), type: "tool.start", toolUseId: "t2", name: "Read", input: {}, parentToolUseId: null },
  { runId: "run-abc", seq: 4, ts: Date.now(), type: "tool.start", toolUseId: "t3", name: "Edit", input: {}, parentToolUseId: null },
  { runId: "run-abc", seq: 5, ts: Date.now(), type: "assistant.text", text: "Bumped n and added the lib file.", parentToolUseId: null },
  { runId: "run-abc", seq: 6, ts: Date.now(), type: "run.finished", subtype: "success", status: "success", totalCostUsd: 0.1234, modelUsage: {}, numTurns: 7, durationMs: 95_000, permissionDenials: [{ tool: "Bash", reason: "not in this run's allowlist" }] },
]
const rel = await writeJournalEntry({ project, task, events, runId: "run-abc", sha, message, diffStat: stat })
const entry = await readFile(join(root, rel), "utf8")
check("entry written", existsSync(join(root, rel)), rel)
check("records the sha", entry.includes(sha))
check("tallies tools", entry.includes("Read ×2, Edit"), entry.split("\n").find((l) => l.startsWith("- Tools:")) ?? "")
check("quotes the agent", entry.includes("Bumped n and added the lib file."))
check("records the denial", entry.includes("`Bash`"))
check("marks cost an estimate", entry.includes("$0.12 (estimate)"))
check("duration is readable", entry.includes("1m 35s"))

console.log("\naide's own bookkeeping is not dirt")
// This is the state every managed project is permanently in: adding a project
// scaffolds .aide/, creating a task writes into it, and setStatus("done")
// rewrites the task file the moment a land finishes. If this counted as dirt,
// nothing could ever land — which is exactly what happened before.
await mkdir(join(root, STATE_DIR, "tasks"), { recursive: true })
await writeFile(join(root, STATE_DIR, "tasks", "0002-next.md"), "---\nid: '0002'\n---\n", "utf8")
await writeFile(join(root, STATE_DIR, "project.md"), "# Project\n", "utf8")
check("scaffolding is not dirt", (await workingTreeDirt(root)) === "", "the land blocker")
check("but git still sees it", (await git(root, ["status", "--porcelain"])).includes(".aide"))
await writeFile(join(root, "real.txt"), "a real uncommitted change\n", "utf8")
check("a real change IS dirt", (await workingTreeDirt(root)).includes("real.txt"))
await rm(join(root, "real.txt"))

console.log("\nland refusals")
await writeFile(join(root, "dirty.txt"), "uncommitted\n", "utf8")
threw = ""
try {
  await mergeTaskBranch(root, "0001", "Merge task 0001")
} catch (err) {
  threw = err instanceof Error ? err.message : String(err)
}
check("refuses a dirty target", threw.includes("uncommitted changes"), threw.split("\n")[0] ?? "")
// Remove only the real dirt. `git clean -fd` would also sweep away the .aide/
// scaffolding, and landing over that scaffolding is what the final land check
// is here to prove.
await rm(join(root, "dirty.txt"))

console.log("\nconflict is aborted, not left half-merged")
await git(root, ["checkout", "-q", "-b", "rival"])
await writeFile(join(root, "app.ts"), "export const n = 999\n", "utf8")
// `add -A` here would also stage the .aide/ scaffolding onto `rival`, and
// checking main back out would then delete it — quietly removing the dirt the
// final land is supposed to prove it can land over.
await git(root, ["add", "app.ts"])
await git(root, ["commit", "-m", "Set n to 999"])
threw = ""
try {
  await mergeTaskBranch(root, "0001", "Merge task 0001")
} catch (err) {
  threw = err instanceof Error ? err.message : String(err)
}
check("reports the conflict", threw.includes("aborted"), threw.split("\n")[0] ?? "")
// Asserted through workingTreeDirt, not raw porcelain: .aide/ is legitimately
// present and untracked here, and the thing being proved is that no half-merged
// content survived the abort.
check("target left clean", (await workingTreeDirt(root)) === "", "no half-merge")
check("still on rival", (await currentBranch(root)) === "rival")

console.log("\nland")
await git(root, ["checkout", "-q", "main"])
// The assertion that matters: git considers this tree dirty, and landing works
// anyway, because the only thing dirtying it is aide's own bookkeeping.
check("git sees .aide/ dirt going in", (await git(root, ["status", "--porcelain"])).includes(".aide"))
const landed = await mergeTaskBranch(root, "0001", "Merge task 0001: Bump n")
check("merged into main", landed.into === "main", landed.into)
check("is a merge commit", (await git(root, ["log", "-1", "--format=%P"])).trim().split(" ").length === 2, "--no-ff held")
check("agent's file is in main", existsSync(join(root, "lib/new.ts")))
check("edit landed", (await readFile(join(root, "app.ts"), "utf8")).trim() === "export const n = 2")

await removeWorktree(root, "0001")
check("worktree removed", !existsSync(wt))

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
