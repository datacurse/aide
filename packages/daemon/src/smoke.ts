/**
 * End-to-end check of the git plumbing behind commit and land: `pnpm smoke`.
 *
 * It builds a throwaway repo in the temp directory and drives the real
 * functions against it — no mocks, no model calls, nothing to clean up in your
 * own projects. Worth running on any change to worktree.ts, because the failure
 * modes here are the expensive kind: a half-merged repo, a commit that silently
 * dropped its message body, a land that refuses forever.
 *
 * It is deliberately not a test framework. One file, one command, plain output.
 */
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { writeJournalEntry } from "./journal.js"
import {
  commitWorktree,
  currentBranch,
  ensureWorktree,
  mergeTaskBranch,
  recentSubjects,
  removeWorktree,
  withTrailers,
  worktreeDiff,
  worktreeDiffStat,
} from "./worktree.js"
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
const wt = await ensureWorktree(root, "0001")
check("created", existsSync(wt), wt)
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

console.log("\nland refusals")
await writeFile(join(root, "dirty.txt"), "uncommitted\n", "utf8")
threw = ""
try {
  await mergeTaskBranch(root, "0001", "Merge task 0001")
} catch (err) {
  threw = err instanceof Error ? err.message : String(err)
}
check("refuses a dirty target", threw.includes("uncommitted changes"), threw.split("\n")[0] ?? "")
await run("git", ["-C", root, "clean", "-fd"], { windowsHide: true })

console.log("\nconflict is aborted, not left half-merged")
await git(root, ["checkout", "-q", "-b", "rival"])
await writeFile(join(root, "app.ts"), "export const n = 999\n", "utf8")
await git(root, ["add", "-A"])
await git(root, ["commit", "-m", "Set n to 999"])
threw = ""
try {
  await mergeTaskBranch(root, "0001", "Merge task 0001")
} catch (err) {
  threw = err instanceof Error ? err.message : String(err)
}
check("reports the conflict", threw.includes("aborted"), threw.split("\n")[0] ?? "")
check("target left clean", (await git(root, ["status", "--porcelain"])).trim() === "", "no half-merge")
check("still on rival", (await currentBranch(root)) === "rival")

console.log("\nland")
await git(root, ["checkout", "-q", "main"])
const landed = await mergeTaskBranch(root, "0001", "Merge task 0001: Bump n")
check("merged into main", landed.into === "main", landed.into)
check("is a merge commit", (await git(root, ["log", "-1", "--format=%P"])).trim().split(" ").length === 2, "--no-ff held")
check("agent's file is in main", existsSync(join(root, "lib/new.ts")))
check("edit landed", (await readFile(join(root, "app.ts"), "utf8")).trim() === "export const n = 2")

await removeWorktree(root, "0001")
check("worktree removed", !existsSync(wt))

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
