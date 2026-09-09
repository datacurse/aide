#!/usr/bin/env node
// Force-commit a project's working tree over a red gate, through the daemon.
//
// Usage: pnpm commit-force <project name | id | root path>
//
// This is the ESCAPE HATCH, deliberately absent from the UI: aide commits each
// turn's work itself, and a tree the checks keep refusing is supposed to be
// fixed, not landed. When it genuinely must land anyway — a failure that was
// already there, a check this machine cannot pass — this asks the daemon to
// run the same commit path with the gate's refusal overridden. The subject
// gets a `WIP:` prefix when a check failed, so the state is visible in
// `git log`. The daemon still does the committing; this script only asks.

const target = process.argv[2]
if (!target) {
  console.error("usage: pnpm commit-force <project name | id | root path>")
  process.exit(1)
}

const port = Number(process.env["AIDE_PORT"] ?? 4317)
const base = `http://127.0.0.1:${port}`

const answer = async (res) => {
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    console.error(body.message ?? `HTTP ${res.status}`)
    process.exit(1)
  }
  return body
}

let projects
try {
  projects = await answer(await fetch(`${base}/api/projects`))
} catch {
  console.error(`no daemon answering on ${base} — is aide running?`)
  process.exit(1)
}

const project = projects.find((p) => p.id === target || p.name === target || p.root === target)
if (!project) {
  console.error(`no project matches "${target}". Known projects:`)
  for (const p of projects) console.error(`  ${p.name}  (${p.id})  ${p.root}`)
  process.exit(1)
}

const { runId } = await answer(
  await fetch(`${base}/api/projects/${project.id}/commit?force=true`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }),
)
console.log(
  `force commit started on ${project.name} (run ${runId}) — watch it in the transcript; ` +
    "a failed check lands with a WIP: subject",
)
