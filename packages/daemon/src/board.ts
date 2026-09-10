import { mkdir, readFile, writeFile } from "node:fs/promises"
import type { ChatStatus, Project } from "@aide/protocol"
import { aideHome, boardPath } from "@aide/protocol/node"
import { readCheckpoint, restoreCommand } from "./checkpoint.js"
import { repoOf } from "./git.js"
import { NO_TURNS, type LiveChats } from "./sessions.js"

/**
 * Which conversations you have ticked off.
 *
 * The whole of aide's own bookkeeping about a chat, and it is one bit per
 * conversation. Everything else the list shows is derived on read: the title and
 * the timestamps come from the SDK's session store, and "working" comes from
 * asking the chat lane whether a turn is actually in flight. Nothing is written
 * when a chat starts thinking or stops, so there is no status field that can be
 * left saying `working` by a daemon that died.
 *
 * This used to be a board — a `todos.md` of rows, joined to the sessions working
 * them. It went because it was never load-bearing: not one commit in the
 * project's history carried the `Aide-Row` trailer that was supposed to tie a
 * row to its work, and the row table was empty. What the board was for, the
 * chat list already did, so the backlog became what it always was underneath —
 * a conversation you have written and not sent.
 *
 * It lives in `~/.aide/` rather than the repo because it churns and because it
 * names session ids that only exist under `~/.claude/projects/` on this machine.
 * Lose this file and you lose which chats were finished; the commits, the
 * checkpoints and the code are all still there.
 */

interface ProjectBoard {
  /** Session id to when it was ticked off. */
  done: Record<string, { at: number }>
  /**
   * This project's last auto-commit was refused by its own checks.
   *
   * Persisted so a daemon restart does not forget it: the pre-turn sweep reads
   * this to tell a red gate's leftover from the human's own edits, and an
   * in-memory-only marker meant one restart could sweep a failing tree into
   * history as "manual edits" — wrong label, right contents, but a label in the
   * permanent record. `runId` names the commit run whose gate refused, for
   * whoever goes reading; `at` is when.
   */
  redGate?: { runId: string; at: string }
}

/** `{ "<projectId>": { done } }` */
type LinkFile = Record<string, ProjectBoard>

/** Tolerant on every field: this file is machine-local and hand-editable. */
const boardFor = (links: LinkFile, projectId: string): ProjectBoard => {
  // An `autoCommit` key may still sit in the file, written by the release where
  // committing was opt-in. Ignored rather than migrated: committing is
  // unconditional now, so the key means nothing either way.
  const held = links[projectId] as (ProjectBoard & { verdicts?: unknown }) | undefined
  // Tolerant like everything else in this file: a hand-edited or stale-shaped
  // `redGate` reads as no marker, which fails toward one mislabelled sweep
  // rather than toward a sweep that never runs again.
  const redGate =
    held?.redGate && typeof held.redGate === "object" && typeof held.redGate.runId === "string"
      ? { redGate: { runId: held.redGate.runId, at: String(held.redGate.at ?? "") } }
      : {}
  if (held?.done && typeof held.done === "object") return { done: held.done, ...redGate }
  // Written by an older aide, which stored `{ verdict, at }` per session under
  // three vocabularies in turn. Any of them meant the human had settled it, so
  // they all read back as done rather than being dropped on the floor.
  const legacy = held?.verdicts
  if (legacy && typeof legacy === "object") {
    const done: Record<string, { at: number }> = {}
    for (const [sessionId, v] of Object.entries(legacy as Record<string, { at?: unknown }>)) {
      done[sessionId] = { at: typeof v?.at === "number" ? v.at : 0 }
    }
    return { done, ...redGate }
  }
  return { done: {}, ...redGate }
}

async function readLinks(): Promise<LinkFile> {
  try {
    const parsed: unknown = JSON.parse(await readFile(boardPath(), "utf8"))
    // Hand-editable and machine-local, so a corrupt file must degrade to
    // "nothing is ticked off" rather than take the daemon down on boot.
    return parsed && typeof parsed === "object" ? (parsed as LinkFile) : {}
  } catch {
    return {}
  }
}

async function writeLinks(links: LinkFile): Promise<void> {
  await mkdir(aideHome(), { recursive: true })
  await writeFile(boardPath(), `${JSON.stringify(links, null, 2)}\n`, "utf8")
}

// ---------------------------------------------------------------------------
// The red-gate marker
// ---------------------------------------------------------------------------

/** Every project whose marker is set, projectId → the refusing run. */
export async function readRedGates(): Promise<Record<string, string>> {
  const links = await readLinks()
  const out: Record<string, string> = {}
  for (const projectId of Object.keys(links)) {
    const gate = boardFor(links, projectId).redGate
    if (gate) out[projectId] = gate.runId
  }
  return out
}

/** Persist the marker. `ChatLane` keeps the hot copy; this is the restart's. */
export async function writeRedGate(projectId: string, runId: string): Promise<void> {
  const links = await readLinks()
  const board = boardFor(links, projectId)
  board.redGate = { runId, at: new Date().toISOString() }
  links[projectId] = board
  await writeLinks(links)
}

/** Drop it — a commit landed, so the tree's dirt is nobody's leftover. */
export async function dropRedGate(projectId: string): Promise<void> {
  const links = await readLinks()
  const board = boardFor(links, projectId)
  if (!board.redGate) return
  delete board.redGate
  links[projectId] = board
  await writeLinks(links)
}

// ---------------------------------------------------------------------------
// Ticking a conversation off
// ---------------------------------------------------------------------------

/**
 * The human says this chat served its purpose.
 *
 * This is the gate the whole design rests on. An agent may write the code and
 * the commit message; it may not decide that any of it is finished. Which is why
 * nothing here is reachable from a run — only from a person pressing a button.
 *
 * Nothing is deleted by it. The conversation is the record of the work, and a
 * "done" that removed something would make the tick the destructive step; as it
 * is, `reopenChat` genuinely undoes it.
 */
export async function closeChat(
  project: Project,
  sessionId: string,
): Promise<{ warning: string | null }> {
  const warning = await checkpointNotice(project, sessionId)

  const links = await readLinks()
  const board = boardFor(links, project.id)
  board.done[sessionId] = { at: Date.now() }
  links[project.id] = board
  await writeLinks(links)

  return { warning }
}

/**
 * Where this conversation's undo lives, said out loud as it closes.
 *
 * The snapshot taken before the conversation started is still there, and this is
 * the moment worth saying so: ticking a chat off is the point at which someone
 * decides whether the work was any good, and "not good" wants a command rather
 * than a shrug.
 *
 * The ref is KEPT, deliberately, and not cleaned up here. A checkpoint is a few
 * bytes of ref plus objects git already had; deleting it the moment someone
 * presses a button would make the one irreversible thing in this flow the button
 * labelled "done".
 */
async function checkpointNotice(project: Project, sessionId: string): Promise<string | null> {
  // `repoOf`, not the bare root — which compiles, means "on this machine", and
  // for a remote project fails into the `.catch` below. That failure is silent
  // by design here, so the symptom would not be an error but a chat ticked off
  // with no undo offered at exactly the moment somebody decides the work was bad.
  const found = await readCheckpoint(repoOf(project), sessionId).catch(() => null)
  if (!found) return null
  return `the tree as it was before this conversation is kept at ${found.ref} — undo with \`${restoreCommand(found.ref)}\``
}

/**
 * Untick it — for when it was the wrong button, and for when it stopped being
 * true.
 *
 * Two callers, and the second is the interesting one. The `reopen` route is the
 * undo. The chat route calls it too, on any send into a conversation: the tick
 * says "this served its purpose", and a message in it is the human saying it has
 * not, so a tick that survived would be a claim the list keeps making about work
 * that is visibly still going — and it would leave the archived group as the
 * place your live conversation was hiding.
 *
 * That is not the agent reaching the gate above. Both callers are a person
 * acting: one presses a button, the other types a message. What no run can do is
 * SET the bit, and the commit gate's one repair attempt does not come through
 * the chat route at all — it builds its own `SendOptions` and goes straight to
 * the lane — so the one turn nobody typed cannot overturn a human verdict.
 */
export async function reopenChat(project: Project, sessionId: string): Promise<void> {
  const links = await readLinks()
  const board = boardFor(links, project.id)
  if (!board.done[sessionId]) return
  delete board.done[sessionId]
  links[project.id] = board
  await writeLinks(links)
}

/**
 * A status per conversation, for the chat list.
 *
 * Three states and no more: it is running, it is finished, or it is just sitting
 * there. A chat that is sitting there reports `state: null` and gets no badge,
 * because a badge on every row buries the one that means something.
 */
export async function chatStatuses(
  project: Project,
  sessions: readonly { sessionId: string }[],
  /** The lock — the same view the session reader gets, so the two cannot disagree. */
  live: LiveChats = NO_TURNS,
): Promise<Record<string, ChatStatus>> {
  const board = boardFor(await readLinks(), project.id)

  const out: Record<string, ChatStatus> = {}
  for (const { sessionId } of sessions) {
    const done = board.done[sessionId] != null
    // A turn in flight IS "working" — there is no separate flag to read, which is
    // what the `{working, blocked}` projection this used to take was hiding: it
    // could be built with `working: false` over a live turn, and nothing would
    // have caught it.
    const turn = live.turnForSession(sessionId)
    out[sessionId] = {
      // Working outranks done: a chat you ticked off and then asked one more
      // thing of is running, whatever the tick says.
      state: turn ? "working" : done ? "closed" : null,
      blocked: turn?.blocked ?? false,
      done,
    }
  }
  return out
}
