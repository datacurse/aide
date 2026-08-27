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
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { writeJournalEntry } from "./journal.js"
import { chatModeFromSdk } from "@aide/protocol"
import { checkBashCommand } from "./policy.js"
import { restartDecision, type Health } from "@aide/protocol"
import {
  buildGraph,
  commitDetail,
  isSha,
  log as readLog,
  overview,
  parseStatus,
  workingTree,
} from "./repo.js"
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

console.log("\ninherited chat mode")
{
  // The session store is shared with the CLI and the VS Code extension, and a
  // conversation carries the mode it was last driven at. Reading that back is
  // what stops a chat you were running on Auto elsewhere from quietly reverting
  // to Manual here and asking permission for the next command.
  check("default is what aide calls manual", chatModeFromSdk("default") === "manual")
  check("acceptEdits round-trips", chatModeFromSdk("acceptEdits") === "acceptEdits")
  check("plan round-trips", chatModeFromSdk("plan") === "plan")
  check("auto round-trips", chatModeFromSdk("auto") === "auto")
  // Null is the load-bearing case. It means "no opinion", and the browser keeps
  // whatever the human last picked — so an unknown mode can never widen one.
  check("dontAsk has no picker entry", chatModeFromSdk("dontAsk") === null, "what task runs use")
  check("bypassPermissions is never inherited", chatModeFromSdk("bypassPermissions") === null)
  check("a future mode is not guessed at", chatModeFromSdk("somethingNew") === null)
  check("junk is not a mode", chatModeFromSdk(undefined) === null && chatModeFromSdk(7) === null)
}

console.log("\nprotocol stays browser-safe")
{
  // The web bundle imports the @aide/protocol barrel. If anything reachable from
  // it pulls `node:*` or a Node-only library, Vite resolves it happily at dev
  // time, the browser refuses it at runtime, React never mounts, and you get a
  // blank white page with nothing in the terminal and nothing in the build.
  // Cheap to assert, miserable to diagnose.
  const src = fileURLToPath(new URL("../../protocol/src/", import.meta.url))
  const seen = new Set<string>()
  const offenders: string[] = []

  const walk = async (file: string): Promise<void> => {
    if (seen.has(file)) return
    seen.add(file)
    let body: string
    try {
      body = await readFile(join(src, file), "utf8")
    } catch {
      return
    }
    for (const m of body.matchAll(/from "([^"]+)"/g)) {
      const spec = m[1] ?? ""
      if (spec.startsWith("node:") || spec === "gray-matter") {
        offenders.push(`${file} imports ${spec}`)
      } else if (spec.startsWith("./")) {
        await walk(spec.slice(2).replace(/\.js$/, ".ts"))
      }
    }
  }
  await walk("index.ts")

  check(
    "the barrel reaches no Node-only module",
    offenders.length === 0,
    offenders.join("; ") || `${seen.size} modules checked`,
  )
  // The counterpart: the Node entry must still exist and still carry the
  // filesystem half, or the split has quietly collapsed back into one barrel.
  const nodeEntry = await readFile(join(src, "node.ts"), "utf8")
  check("the node entry still carries paths", nodeEntry.includes("./paths.js"))
}

console.log("\nrestarting a stale daemon")
{
  // The daemon loads its modules once, so every edit to packages/daemon/src
  // leaves a process running code that no longer exists. The dev server fixes
  // that by restarting it — and the previous version of this rule, chokidar
  // firing on a file write, killed a daemon three lines into a land and left the
  // task stranded at `committed` with an orphaned worktree. Hence a pure
  // function, and hence these.
  const QUIET = 1500
  const base: Health = {
    ok: true,
    taskModel: "claude-opus-5",
    maxConcurrentRuns: 2,
    maxBudgetUsd: 5,
    bootSourceId: "aaaaaaaaaaaa",
    sourceId: "bbbbbbbbbbbb",
    stale: true,
    supervised: true,
    busy: { runs: 0, chats: 0, writes: 0 },
    idleMs: 10_000,
  }
  const decide = (patch: Partial<Health>, previous = "bbbbbbbbbbbb" as string | null) =>
    restartDecision({ ...base, ...patch }, previous, QUIET)

  check("restarts a stale, quiet daemon", decide({}).restart, decide({}).reason)
  check("leaves a current daemon alone", !decide({ stale: false }).restart)

  // Each of these is a way to destroy work.
  check("not while a task run is in flight", !decide({ busy: { runs: 1, chats: 0, writes: 0 } }).restart)
  check("not while a run is merely QUEUED", !decide({ busy: { runs: 1, chats: 0, writes: 0 } }).restart, "shutdown cancels the queue")
  check("not mid chat turn", !decide({ busy: { runs: 0, chats: 1, writes: 0 } }).restart)
  check(
    "not mid land",
    !decide({ busy: { runs: 0, chats: 0, writes: 1 } }).restart,
    "a land is one request, and killing it strands the task at committed",
  )
  check(
    "and it says what it is waiting for",
    decide({ busy: { runs: 2, chats: 1, writes: 0 } }).reason === "2 runs, 1 chat turn in flight",
    decide({ busy: { runs: 2, chats: 1, writes: 0 } }).reason,
  )

  // The gap between two of the browser's requests is not a safe moment.
  check("not in the gap right after a write", !decide({ idleMs: 200 }).restart)
  check("but yes once it has been quiet", decide({ idleMs: QUIET }).restart)

  // A tree still being rewritten reports a different fingerprint every tick, and
  // restarting once per tick through a `git merge` helps nobody.
  check("not while the tree is still moving", !decide({}, "ccccccccccc").restart)
  check("not on the very first sighting", !decide({}, null).restart)

  // Unknown must never read as changed: a daemon with no source tree to compare
  // against is not stale, it is unknowable.
  check("never restarts on an unreadable source", !decide({ sourceId: null }, null).restart)
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

console.log("\nreading the repository")
{
  const view = await overview(root)
  check("knows the branch", view.branch === "main", view.branch ?? "(detached)")
  check("knows HEAD", view.head !== null && !view.unborn, view.head ?? "")
  check("invents no upstream", view.upstream === null, "this repo has no remote")

  const history = await readLog(root, 3)
  check("log honours the limit", history.commits.length === 3, `${history.commits.length}`)
  check("says there is more", history.more, "one extra is fetched so this is not a guess")
  check("newest first", history.commits[0]?.sha === landed.sha, history.commits[0]?.subject ?? "")
  // Read again unlimited rather than reusing the three above: this repo's
  // commits are all made inside the same second, so which of them `git log`
  // puts third is a tie-break, and an assertion about trailers must not depend
  // on it.
  const full = await readLog(root, 50)
  check(
    "reads the Aide-Task trailer",
    full.commits.some((c) => c.tasks.includes("0001")),
    "this is what links a commit back to the task that asked for it",
  )
  check("and leaves it off the commits without one", full.commits.some((c) => c.tasks.length === 0))
  check("no more history than there is", !full.more, `${full.commits.length} commits`)

  // The assertion this section exists for. `git show` on a cleanly resolved
  // merge prints an empty combined diff, and every landed task is a --no-ff
  // merge — so without `-m --first-parent` the whole point of the view, seeing
  // what landed, is a commit that appears to have changed nothing.
  const detail = await commitDetail(root, landed.sha)
  check("finds the merge commit", detail !== null)
  check("merge has a diff", detail?.diff.includes("+export const added = true") === true, "-m --first-parent")
  check("merge has a stat", detail?.stat.includes("lib/new.ts") === true)
  check("keeps the whole message", detail?.message.includes("Merge task 0001") === true)

  check("an option is not a sha", !isSha("--upload-pack=whatever"), "this value comes from the URL")
  check("a real sha is", isSha(landed.sha))
  check("and commitDetail refuses it", (await commitDetail(root, "--output=/tmp/x")) === null)

  // The `++i` that consumes a rename's second field is easy to get wrong in a
  // way that eats the NEXT entry rather than failing outright.
  const parsed = parseStatus("R  new name.txt\u0000old name.txt\u0000?? plain.txt\u0000")
  check("rename carries its old path", parsed[0]?.from === "old name.txt", parsed[0]?.from ?? "null")
  check("rename does not swallow the next entry", parsed.length === 2 && parsed[1]?.path === "plain.txt")

  await writeFile(join(root, "app.ts"), "export const n = 3\n", "utf8")
  await writeFile(join(root, "brand new.txt"), "untracked\n", "utf8")
  const tree = await workingTree(root)
  check("sees the edit", tree.files.some((f) => f.path === "app.ts" && f.unstaged === "modified"))
  check("edit is in the diff", tree.diff.includes("+export const n = 3"))
  const fresh = tree.files.find((f) => f.path === "brand new.txt")
  check("sees a new file whose name has a space", fresh?.code === "??", fresh?.path ?? "missing")
  check("new file's content is in the diff", tree.diff.includes("+untracked"), "--no-index against /dev/null")
  check("new file reads as new", tree.diff.includes("new file mode"))
  // The whole reason this view diffs new files the awkward way. `add -A -N` is
  // how the worktree routes do it, and doing that here would stage intent-to-add
  // across the human's own checkout because they opened a read-only page.
  check(
    "staged nothing to manage it",
    (await git(root, ["diff", "--cached", "--name-only"])).trim() === "",
    "read-only means read-only",
  )
  await rm(join(root, "brand new.txt"))
  await git(root, ["checkout", "--", "app.ts"])
}

console.log("\nthe drawn graph")
{
  // The half of the history view nobody can eyeball. A lane is a number, and a
  // wrong number is a line that goes somewhere the reader will believe. This
  // repo has the shape that matters by the time we get here: a branch that left
  // main and came back through a --no-ff merge, plus `rival`, which never did.
  const page = await readLog(root, 50)
  const rowFor = (sha: string) => page.graph.find((r) => r.sha === sha)

  check("a row per commit", page.graph.length === page.commits.length)
  check(
    "rows are in the same order as the commits",
    page.graph.every((r, i) => r.sha === page.commits[i]?.sha),
    "the UI pairs them by index; the sha is carried so this cannot drift silently",
  )

  check(
    "the newest commit has no line above it",
    rowFor(page.commits[0]?.sha ?? "")?.enters.length === 0,
    "nothing on the page points at it",
  )

  const merge = rowFor(landed.sha)
  check("the merge has two lines leaving it", merge?.leaves.length === 2, `${merge?.leaves.length}`)
  check(
    "and they leave in different lanes",
    merge?.leaves[0]?.lane !== merge?.leaves[1]?.lane,
    "both parents in one lane would draw a merge as a straight line",
  )
  check("the merge keeps its own lane for its first parent", merge?.leaves[0]?.lane === merge?.lane)

  const [firstParent, secondParent] = page.commits.find((c) => c.sha === landed.sha)?.parents ?? []
  check(
    "main keeps its colour across the merge",
    rowFor(firstParent ?? "")?.color === merge?.color,
    "a new colour at every merge is how a graph turns into spaghetti",
  )
  check(
    "the branch that landed runs beside it, not on top of it",
    rowFor(secondParent ?? "")?.lane !== merge?.lane,
  )
  check(
    "every lane drawn fits the width the page reports",
    page.lanes >= 2 &&
      page.graph.every((r) =>
        [r.lane, ...[...r.through, ...r.enters, ...r.leaves].map((l) => l.lane)].every(
          (l) => l < page.lanes,
        ),
      ),
    `${page.lanes} lanes wide`,
  )
  check(
    "nothing is drawn twice in one lane",
    page.graph.every(
      (r) =>
        new Set(r.leaves.map((l) => l.lane)).size === r.leaves.length &&
        new Set(r.enters.map((l) => l.lane)).size === r.enters.length,
    ),
    "two lines in one lane are one line as far as the reader is concerned",
  )

  // Where the branch left main. Every line still looking for this commit ends
  // here, and all but one of them is drawn joining in.
  const base = (await git(root, ["merge-base", firstParent ?? "", secondParent ?? ""])).trim()
  check(
    "the lines meet again at the fork point",
    (rowFor(base)?.enters.length ?? 0) >= 2,
    `${base.slice(0, 8)} — its own line plus at least one branch joining it`,
  )

  // Ref classification, which is the reason the log asks for --decorate=full.
  // aide names its own branches `aide/task-NNNN`, so "a slash means a remote"
  // would have labelled every branch aide made itself as somebody else's.
  const refs = page.commits.flatMap((c) => c.refs)
  const taskBranch = refs.find((r) => r.name === "aide/task-0001")
  check("a slashed local branch is a branch", taskBranch?.kind === "branch", taskBranch?.kind ?? "missing")
  check("the checked-out branch says so", refs.some((r) => r.name === "main" && r.head))
  check("and the others do not", refs.find((r) => r.name === "rival")?.head === false)
  check("no ref path leaks through", !refs.some((r) => r.name.startsWith("refs/")), "the UI prints these")

  const first = page.commits.find((c) => c.parents.length === 0)
  check("the first commit's line simply stops", rowFor(first?.sha ?? "")?.leaves.length === 0)

  // Synthetic, because the case that decides whether a long history stays
  // readable is one no throwaway repo makes by accident: a lane freed in the
  // middle of the page, with a line still running to the left of it, has to be
  // handed to the next tip that needs one.
  const commit = (sha: string, parents: string[]) => ({
    sha,
    parents,
    short: sha,
    author: "",
    authorEmail: "",
    date: "",
    refs: [],
    tasks: [],
    subject: "",
  })
  const synth = buildGraph([
    commit("d", ["c", "b"]),
    commit("c", ["a"]),
    commit("b", ["a"]),
    commit("a", ["a0"]),
    commit("z", []),
    commit("a0", []),
  ])
  check(
    "a commit in the middle of a branch is joined to the one above it",
    synth.graph[1]?.enters.length === 1 && synth.graph[1]?.enters[0]?.lane === synth.graph[1]?.lane,
    "without this every dot is drawn with a gap over it",
  )
  check("the merged-in branch takes the lane beside it", synth.graph[2]?.lane === 1, `${synth.graph[2]?.lane}`)
  check(
    "both lines land on the shared parent",
    synth.graph[3]?.enters.length === 2,
    "one is the lane it continues in, the other is the branch joining it",
  )
  check(
    "the freed lane is reused, not abandoned",
    synth.graph[4]?.lane === 1,
    "an unrelated tip must not push the graph one column further right forever",
  )
  check("so the whole page is two lanes wide", synth.lanes === 2, `${synth.lanes}`)
}

await removeWorktree(root, "0001")
check("worktree removed", !existsSync(wt))

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
