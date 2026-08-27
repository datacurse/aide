import { fork, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import type { Attachment, ChatMode, EffortLevel, Project, RunDelta } from "@aide/protocol"
import type { RunAgentOptions } from "./agent.js"
import { CONFIG } from "./config.js"
import type { EventLog } from "./eventlog.js"
import { killTree, relayWorkerOutput } from "./proc.js"
import { readProjectDoc } from "./registry.js"
import type { FromWorker, ToWorker } from "./worker/main.js"

const WORKER =
  process.env["AIDE_WORKER"] ?? fileURLToPath(new URL("./worker/main.ts", import.meta.url))

/**
 * Chat turns.
 *
 * Deliberately NOT the Supervisor. Three things differ, and each of them is
 * load-bearing:
 *
 * 1. **No task, so no task lifecycle.** A chat has no worktree, no branch, no
 *    `.aide/tasks/*.md` and no status to transition. Everything the Supervisor
 *    does after a run ends is about a task file that does not exist here.
 *
 * 2. **No shared concurrency cap.** Chats do not queue behind agent tasks.
 *    Making an interactive message wait for two Opus runs to finish is the wrong
 *    trade — the cap exists to limit how many diffs you have to review, and a
 *    chat produces none.
 *
 * 3. **It runs in the project root, not a worktree.** That breaks aide's
 *    isolation invariant on purpose: a chat is one-at-a-time with a human
 *    watching every edit, which is a different risk profile from parallel
 *    headless agents, and it is what makes a chat useful rather than a task
 *    wearing a chat's clothes. The cost is real and worth stating: a chat's
 *    edits dirty the working tree, which will correctly block landing a task
 *    until they are committed.
 *
 * One turn per session at a time, because two concurrent turns appending to one
 * transcript would interleave into nonsense.
 */

export interface ChatTurn {
  runId: string
  projectId: string
  /** null until the SDK reports one — a brand new conversation has no id yet. */
  sessionId: string | null
  startedAt: number
}

interface TurnRecord extends ChatTurn {
  child: ChildProcess
  interrupted: boolean
  /** Tool calls the human has not answered yet. */
  pending: Set<string>
}

export interface SendOptions {
  project: Project
  /** null starts a new conversation. */
  sessionId: string | null
  text: string
  attachments: Attachment[]
  mode: ChatMode
  effort: EffortLevel
}

export class ChatLane {
  #turns = new Map<string, TurnRecord>()
  /**
   * Live delta listeners, per run. Separate from the EventLog on purpose: these
   * are thousands of token-sized messages per turn, and the log is an
   * append-only file replayed in full to every new subscriber.
   */
  #watchers = new Map<string, Set<(d: RunDelta) => void>>()

  /** Returns an unsubscribe. A run with no watchers simply drops its deltas. */
  watchDeltas(runId: string, fn: (d: RunDelta) => void): () => void {
    const set = this.#watchers.get(runId) ?? new Set()
    set.add(fn)
    this.#watchers.set(runId, set)
    return () => {
      set.delete(fn)
      if (set.size === 0) this.#watchers.delete(runId)
    }
  }

  constructor(private readonly log: EventLog) {}

  turns(): ChatTurn[] {
    return [...this.#turns.values()].map(({ runId, projectId, sessionId, startedAt }) => ({
      runId,
      projectId,
      sessionId,
      startedAt,
    }))
  }

  /** The in-flight turn for a conversation, if any. */
  turnForSession(sessionId: string): ChatTurn | undefined {
    return this.turns().find((t) => t.sessionId === sessionId)
  }

  async send(opts: SendOptions): Promise<string> {
    const { project } = opts
    if (opts.sessionId && this.turnForSession(opts.sessionId)) {
      throw new Error("this conversation already has a turn in flight")
    }

    const runId = randomUUID()
    const doc = await readProjectDoc(project.root)

    const job: RunAgentOptions = {
      runId,
      taskId: "",
      projectId: project.id,
      // A chat turn is the message, with no title composed in front of it.
      title: opts.text,
      prompt: "",
      projectDoc: doc.body,
      cwd: project.root,
      worktree: project.root,
      model: CONFIG.taskModel,
      // Read-only tools only. Edit, Write and Bash deliberately fall through to
      // canUseTool, because a bare name here auto-approves the tool before the
      // callback runs — which would make "Manual" promise a prompt it never gave.
      allowedTools: [...CONFIG.chatAutoAllowTools],
      allowedBash: [...CONFIG.allowedBash],
      deniedBash: [...CONFIG.deniedBash],
      env: CONFIG.runEnv,
      maxBudgetUsd: CONFIG.maxBudgetUsd,
      chatMode: opts.mode,
      effort: opts.effort,
      attachments: opts.attachments,
      trackContext: true,
      ...(opts.sessionId ? { resume: opts.sessionId } : {}),
    }

    // The human's own words go in first, before the SDK is even contacted, so a
    // turn that fails to spawn still shows what it was answering.
    this.log.append(runId, { type: "user.message", text: opts.text })

    const child = fork(WORKER, [], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    })

    const record: TurnRecord = {
      runId,
      projectId: project.id,
      sessionId: opts.sessionId,
      startedAt: Date.now(),
      child,
      interrupted: false,
      pending: new Set(),
    }
    this.#turns.set(runId, record)

    // Forward the worker's own output. Without this the pipes opened above are
    // never drained: everything the worker or the SDK writes is swallowed, and a
    // chatty child eventually BLOCKS on a full pipe buffer (64KB on Windows)
    // with no indication why. Prefixed because several workers share this stream.
    relayWorkerOutput(child, runId)

    child.on("message", (raw: unknown) => {
      const msg = raw as FromWorker
      if (msg.type === "ready") {
        child.send({ cmd: "start", job } satisfies ToWorker)
        return
      }
      if (msg.type === "delta") {
        const watchers = this.#watchers.get(runId)
        if (watchers) for (const fn of watchers) fn(msg.body)
        return
      }
      if (msg.type === "permission") {
        record.pending.add(msg.requestId)
        this.log.append(runId, {
          type: "permission.request",
          requestId: msg.requestId,
          name: msg.name,
          input: msg.input,
        })
        return
      }
      if (msg.type === "event") {
        // A new conversation learns its id from the SDK's init message; capture
        // it so the browser can switch from "new chat" to a real conversation
        // without waiting for the turn to finish.
        if (msg.body.type === "run.started" && msg.body.sessionId) {
          record.sessionId = msg.body.sessionId
        }
        if (msg.body.type === "run.finished") {
          this.log.append(runId, {
            ...msg.body,
            status: record.interrupted ? "cancelled" : msg.body.status,
          })
          return
        }
        this.log.append(runId, msg.body)
        return
      }
      if (msg.type === "done") {
        this.#turns.delete(runId)
        this.#watchers.delete(runId)
      }
    })

    child.on("error", (err) => {
      this.log.append(runId, { type: "run.error", message: `worker error: ${err.message}` })
      this.#turns.delete(runId)
    })

    child.on("exit", (code, signal) => {
      if (this.#turns.has(runId)) {
        this.log.append(runId, {
          type: "run.error",
          message: `the turn ended without a result (code ${code}, signal ${signal ?? "none"})`,
        })
        this.#turns.delete(runId)
      }
    })

    return runId
  }

  /** Answer a pending permission request. Returns false if it is already gone. */
  resolvePermission(runId: string, requestId: string, allowed: boolean): boolean {
    const record = this.#turns.get(runId)
    if (!record || !record.pending.has(requestId)) return false
    record.pending.delete(requestId)
    record.child.send({ cmd: "permission", requestId, allowed } satisfies ToWorker)
    this.log.append(runId, {
      type: "permission.resolved",
      requestId,
      allowed,
      reason: allowed ? "you allowed it" : "you declined it",
    })
    return true
  }

  interrupt(runId: string): boolean {
    const record = this.#turns.get(runId)
    if (!record) return false
    record.interrupted = true
    // The worker denies anything outstanding on interrupt; recording it here
    // keeps the transcript honest about why those calls did not run.
    for (const requestId of record.pending) {
      this.log.append(runId, {
        type: "permission.resolved",
        requestId,
        allowed: false,
        reason: "the turn was interrupted",
      })
    }
    record.pending.clear()
    record.child.send({ cmd: "interrupt" } satisfies ToWorker)
    return true
  }

  /** Ends every turn. Called from the daemon's shutdown path. */
  shutdown(): void {
    for (const record of this.#turns.values()) {
      record.child.send({ cmd: "interrupt" } satisfies ToWorker)
      killTree(record.child)
    }
    this.#turns.clear()
  }
}
