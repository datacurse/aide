/**
 * Supervisor semantics: `pnpm smoke:queue`.
 *
 * Separate from `smoke.ts` because it tests a different thing — the queue, not
 * git — and because every case here is a bug that cost real Opus money to find
 * by hand. It forks the real worker path against a stub (see smoke-worker.ts),
 * so no model is ever contacted and nothing outside a temp directory is touched.
 *
 * Run it after any change to supervisor.ts. The failures it guards against are
 * silent ones: two workers in one worktree, a queued run nobody can cancel, an
 * unhandled rejection with no stack anyone will read.
 */
import { execFile } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { promisify } from "node:util"
import type { Project, Task } from "@aide/protocol"
import { STATE_DIR } from "@aide/protocol"

// Point the supervisor at the stub and keep runs short, BEFORE importing it —
// both are read at module load.
process.env["AIDE_WORKER"] = fileURLToPath(new URL("./smoke-worker.ts", import.meta.url))
process.env["AIDE_SMOKE_WORK_MS"] ??= "400"
process.env["AIDE_MAX_CONCURRENT"] ??= "2"

const { EventLog } = await import("./eventlog.js")
const { Supervisor } = await import("./supervisor.js")
const { createTask, getTask } = await import("./tasks.js")

const run = promisify(execFile)
const git = (cwd: string, args: string[]) =>
  run("git", ["-C", cwd, ...args], { windowsHide: true })

let failures = 0
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures += 1
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

const root = await mkdtemp(join(tmpdir(), "aide-queue-"))
await git(root, ["init", "-b", "main"])
await git(root, ["config", "user.email", "smoke@aide.test"])
await git(root, ["config", "user.name", "aide smoke"])
await writeFile(join(root, "README.md"), "# queue smoke\n", "utf8")
await git(root, ["add", "-A"])
await git(root, ["commit", "-m", "init"])

const project: Project = {
  id: "p1",
  name: "queue-smoke",
  root,
  addedAt: new Date().toISOString(),
}

const log = new EventLog()
const supervisor = new Supervisor(log)

const makeTask = (title: string): Promise<Task> => createTask(project, title, "do nothing")

console.log(`repo: ${root}\n`)

// ---------------------------------------------------------------------------
console.log("concurrency cap")
const tasks = [await makeTask("one"), await makeTask("two"), await makeTask("three")]
const ids = tasks.map((t) => supervisor.enqueue(project, t))
await wait(150)

let view = supervisor.runs()
check("all three are known", view.length === 3, `${view.length}`)
check("two running", view.filter((r) => r.phase === "running").length === 2)
check("one queued", view.filter((r) => r.phase === "queued").length === 1)
check(
  "the queued one has a position",
  view.find((r) => r.phase === "queued")?.position === 1,
  "a queued run used to be an anonymous closure",
)

// ---------------------------------------------------------------------------
console.log("\ndouble-enqueue is refused")
// The guard the HTTP route uses. It used to search running runs only, and
// #active was populated after a slot was won — so two POSTs in one tick both
// passed and forked two workers into the same worktree.
check("running task reports in flight", supervisor.runIdForTask(tasks[0]!.id) !== undefined)
check(
  "QUEUED task reports in flight",
  supervisor.runIdForTask(tasks[2]!.id) !== undefined,
  "this is the fix",
)

// Exactly what POST /run does: guard, then admit. Called twice in one tick with
// no await between, which is the shape that used to slip through — enqueue
// awaited a file write before registering, so both calls saw an idle task.
const t4 = await makeTask("same-tick")
const routeEnqueue = (task: Task): string | null =>
  supervisor.runIdForTask(task.id) ? null : supervisor.enqueue(project, task)

const first = routeEnqueue(t4)
const second = routeEnqueue(t4)
check("the first is admitted", first !== null)
check(
  "the second in the SAME TICK is refused",
  second === null,
  "two workers in one worktree on one branch",
)
check(
  "only one run exists for it",
  supervisor.runs().filter((r) => r.taskId === t4.id).length === 1,
)
await supervisor.cancelForTask(t4.id)

// ---------------------------------------------------------------------------
console.log("\ncancelling a queued run")
const queued = supervisor.runs().find((r) => r.phase === "queued")
const cancelled = queued ? await supervisor.interrupt(queued.runId) : false
check("interrupt resolves true for a queued run", cancelled, "it used to 404")
if (queued) {
  const events = log.read(queued.runId)
  const terminal = events.at(-1)
  check(
    "its log ends in run.finished",
    terminal?.type === "run.finished" && terminal.status === "cancelled",
    "every consumer assumes exactly one terminal event",
  )
  check("no worker was ever forked", !events.some((e) => e.type === "run.started"))
  const task = await getTask(project, queued.taskId)
  check("task filed cancelled", task?.status === "cancelled", task?.status)
}

// ---------------------------------------------------------------------------
console.log("\nrunning runs still finish")
await wait(1200)
const done = await getTask(project, tasks[0]!.id)
check("a completed run lands on needs-review", done?.status === "needs-review", done?.status)
check("nothing left in flight", supervisor.runs().length === 0, `${supervisor.runs().length}`)
check("the run recorded a start", log.read(ids[0]!).some((e) => e.type === "run.queued"))

// ---------------------------------------------------------------------------
console.log("\nshutdown ends everything")
const t5 = await makeTask("shutdown me")
const t6 = await makeTask("queued at shutdown")
supervisor.enqueue(project, t5)
supervisor.enqueue(project, t6)
await wait(100)
await supervisor.shutdown()
check("no runs survive shutdown", supervisor.runs().length === 0)
for (const t of [t5, t6]) {
  const after = await getTask(project, t.id)
  check(
    `${t.title} is not left running`,
    after?.status !== "running" && after?.status !== "queued",
    after?.status,
  )
}

// ---------------------------------------------------------------------------
console.log("\nreconciliation")
// Hand-file a task as running with a run that never finished — exactly what a
// killed daemon leaves behind.
const { reconcileStrandedTasks } = await import("./reconcile.js")
const orphan = await makeTask("stranded")
const orphanRun = "run-orphan"
log.append(orphanRun, { type: "run.queued", taskId: orphan.id, projectId: project.id, position: 1 })
const { patchTask } = await import("./tasks.js")
await patchTask(project, orphan.id, { status: "running", addRun: orphanRun })

const registry = join(process.env["USERPROFILE"] ?? process.env["HOME"] ?? root, STATE_DIR)
console.log(`  (reconcile reads the real registry at ${registry}; this project is not in it)`)
const recovered = await reconcileStrandedTasks(log)
check(
  "unregistered projects are skipped",
  !recovered.some((r) => r.taskId === orphan.id),
  "reconciliation walks the registry, not the filesystem",
)

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
