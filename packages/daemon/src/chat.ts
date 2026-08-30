import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import type {
  Attachment,
  ChatMode,
  EffortLevel,
  ModelSpend,
  Project,
  RunDelta,
  RunEventBody,
  RunStatus,
} from "@aide/protocol"
import { sshConfigPath } from "@aide/protocol/node"
import type { FollowUpTurn, RunAgentOptions } from "./agent.js"
import {
  adoptCheckpoint,
  readCheckpoint,
  restoreCommand,
  takeCheckpoint,
  takeTurnCheckpoint,
  type TurnCheckpoint,
} from "./checkpoint.js"
import { CONFIG } from "./config.js"
import type { EventLog } from "./eventlog.js"
import { git, gitOr, refRoot, repoOf, type RepoRef } from "./git.js"
import { readProjectDoc } from "./registry.js"
import { LocalRunner, SshRunner, type Runner } from "./runner.js"
import { currentSourceId, staleSince } from "./source.js"
import type { FromWorker, ToWorker } from "./worker/main.js"

const WORKER =
  process.env["AIDE_WORKER"] ?? fileURLToPath(new URL("./worker/main.ts", import.meta.url))

/**
 * Where `pnpm deploy-agent` puts the agent on a remote machine.
 *
 * An absolute path with `~` expanded by the remote shell. NOT a bare name:
 * `ssh host <command>` gets no login shell, so `~/.local/bin` and friends are
 * not on PATH — a lesson from `claude` itself, which is installed there on `tg`
 * and is "not found" over ssh while working when typed by hand.
 */
const REMOTE_AGENT = process.env["AIDE_REMOTE_AGENT"] ?? "$HOME/.aide/agent/aide-agent"

/**
 * Chat turns, and the lock that keeps them to one at a time.
 *
 * ## One agent has the repo
 *
 * Every run works the project's own checkout. There is no worktree, no branch
 * per conversation and nothing to merge, because the isolation those bought was
 * measuring the wrong thing: a worktree isolates COMMITTED state, while the real
 * state of a project lives uncommitted in the tree you are looking at. A run
 * branched from HEAD is working against a version of the repo that has not been
 * true for hours, and it shows up as an agent confidently editing code that was
 * deleted this morning. It also meant the dev server — which serves the main
 * checkout — could never show you what a run had done, so no visual change was
 * ever reviewable.
 *
 * Parallelism moved up a level: several projects, one agent each.
 *
 * The lock is therefore per PROJECT, and it is derived rather than stored — it
 * is exactly "is a turn in flight for this project", which is a question this
 * class can already answer. A lock file would be the one piece of state in aide
 * that needs reconciling on boot, and a daemon killed mid-run would leave a
 * repository that looks permanently held by a process that no longer exists.
 *
 * It REFUSES rather than queueing. A queued turn would start against a tree the
 * previous run had just rewritten and nobody had reviewed yet — which is the
 * staleness this whole design exists to remove, reintroduced one level up.
 *
 * Also still one turn per session, because two concurrent turns appending to one
 * transcript would interleave into nonsense. That check comes first, so the
 * common mistake gets the specific message rather than the lock's.
 *
 * ## The worker outlives the turn
 *
 * A conversation keeps one worker, and a follow-up is a message into a session
 * that is still open. The old shape forked a worker per turn, which meant every
 * message paid for a fork (~540ms on Windows), a CLI boot (~850ms) and a replay
 * of the transcript from disk before the model saw a token — to rebuild state
 * the previous turn had already had in memory a second earlier.
 *
 * Everything that made that shape safe is still here, because a warm worker is
 * an optimisation and never a requirement: the cold path is unchanged and is
 * what runs whenever there is no live session — the first message, after an
 * eviction, after a crash, after a daemon restart. `resume` still carries the
 * conversation in that case. If reuse is ever wrong, deleting `#reusable` puts
 * the daemon back to fork-per-turn with no other change.
 */

export interface ChatTurn {
  runId: string
  projectId: string
  /** null until the SDK reports one — a brand new conversation has no id yet. */
  sessionId: string | null
  startedAt: number
  /** The message that opened this turn, so a conversation with no transcript on
   * disk yet can still be named. */
  text: string
  /**
   * A tool call is waiting on a human.
   *
   * Exposed on the turn rather than left inside the record because the board
   * needs it: "an agent is blocked on you right now" is the one thing that
   * outranks everything else in the sort, and it is not derivable from anything
   * else the lane publishes.
   */
  blocked: boolean
}

/**
 * How an agent turn run inside a held run ended. See `turnUnderHold`.
 *
 * It carries the spend because the run it happened inside is the one that has to
 * report it: a commit that spent four minutes of Opus fixing a failing check and
 * then billed itself for the commit message alone would under-report every
 * profile that adds these up.
 */
export interface HeldTurnOutcome {
  status: RunStatus
  costUsd: number
  modelUsage: Record<string, ModelSpend>
  /** What went wrong, when something did. Empty on success. */
  errors: string[]
}

/** The turn in flight inside a held run, and where its outcome is going. */
interface NestedTurn {
  settle: (outcome: HeldTurnOutcome) => void
  costUsd: number
  modelUsage: Record<string, ModelSpend>
  status: RunStatus | null
  errors: string[]
}

/**
 * `blocked` is omitted rather than stored: it is exactly `pending.size > 0`, and
 * a copy of it here would be a second source of truth to forget to update.
 */
interface TurnRecord extends Omit<ChatTurn, "blocked"> {
  /**
   * Null for the moment between the turn being registered and its worker being
   * forked. That gap used to be minutes — a worktree checkout and a dependency
   * install — and is now the duration of a `fork`, but the turn is still
   * registered first so the browser can subscribe and the stop button works
   * before the worker exists.
   */
  worker: SessionWorker | null
  interrupted: boolean
  /** Tool calls the human has not answered yet. */
  pending: Set<string>
  /**
   * The daemon's own source fingerprint when this turn was admitted.
   *
   * Kept so the end of the turn can tell "this run left the daemon behind" from
   * "it was already behind when you pressed send". Without it the transcript
   * would blame a run that only read files for an edit the human made by hand
   * ten minutes earlier, on every turn until something restarted the process.
   *
   * Null when it could not be read, which reads as "say nothing" downstream —
   * an unknown fingerprint must never be reported as a change.
   */
  sourceIdAtStart: string | null
  /**
   * The turn's restore point being written, between the agent stopping and the
   * turn being let go of.
   *
   * Held on the record rather than awaited inline because two IPC messages
   * arrive for the end of a turn — the outcome event, then `done` — and both
   * have to wait for the same snapshot: one so the log still ends in its
   * terminal event, the other so the project's lock is not released over a tree
   * that has not been recorded yet. Null except during that window.
   */
  settling: Promise<void> | null
  /**
   * An agent turn running INSIDE this held run, or null for almost every turn.
   *
   * Set only by `turnUnderHold`. Its presence changes three things about how the
   * worker's messages are handled, and each one is a way the held run would
   * otherwise be destroyed by the turn it asked for: the SDK's `run.started` is
   * not appended (this log already has one), `run.finished` is not appended
   * either — the first terminal event SEALS a log, so everything the commit
   * still has to say, its own outcome included, would be silently dropped — and
   * `done` frees the worker without deleting the record, which is the thing
   * holding the project.
   */
  nested: NestedTurn | null
}

/**
 * A live SDK session and the process holding it.
 *
 * `mode`, `effort`, `thinking` and `model` are what the session was last told,
 * not what the composer currently shows: a follow-up only spends a control
 * request when its setting actually changed.
 */
interface SessionWorker {
  /**
   * Where this session's agent is running, and how to talk to it.
   *
   * A `Runner` rather than a `ChildProcess` so that the lane below is agnostic
   * about which machine that is — see `runner.ts`. Everything in this file
   * treats it as a mailbox with a kill switch, which is all it ever needed.
   */
  runner: Runner
  projectId: string
  /**
   * The project's repository, which is also where the agent runs.
   *
   * A `RepoRef` rather than a path, so the checkpoints this file takes go to the
   * machine holding the files. A bare root here would be a Linux path handed to
   * Windows git for every remote turn.
   */
  root: RepoRef
  /** null until the SDK's init message names it. */
  sessionId: string | null
  mode: ChatMode
  effort: EffortLevel
  thinking: boolean
  model: string
  /**
   * The project brief this session's system prompt was built from. A brief that
   * has since been edited forces a cold start, because the system prompt is
   * fixed for the life of a query — reusing the session would quietly run under
   * the old rules with nothing on screen to say so.
   */
  projectDoc: string
  /** The turn in flight. Null means the session is warm and idle. */
  turn: TurnRecord | null
  /** Told to close: no further turn may be handed to it. */
  closing: boolean
  idle: ReturnType<typeof setTimeout> | null
}

export interface SendOptions {
  project: Project
  /** null starts a new conversation. */
  sessionId: string | null
  text: string
  attachments: Attachment[]
  mode: ChatMode
  effort: EffortLevel
  /**
   * Whether the model may think before it answers.
   *
   * Not optional, unlike the SDK's own version of this: every caller in here
   * sends a turn a human is waiting on, and a default hidden behind `?? true`
   * is one the compiler stops asking anybody about.
   */
  thinking: boolean
}

export class ChatLane {
  #turns = new Map<string, TurnRecord>()
  #workers = new Set<SessionWorker>()
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

  #idleMs: number
  #closeGraceMs: number

  /**
   * The timeouts are constructor arguments rather than reads of CONFIG so
   * `pnpm smoke:queue` can watch an eviction happen in under a second instead of
   * waiting ten minutes or asserting nothing about it.
   */
  constructor(
    private readonly log: EventLog,
    opts: { idleMs?: number; closeGraceMs?: number } = {},
  ) {
    this.#idleMs = opts.idleMs ?? CONFIG.chatIdleMs
    this.#closeGraceMs = opts.closeGraceMs ?? CONFIG.chatCloseGraceMs
  }

  turns(): ChatTurn[] {
    return [...this.#turns.values()].map((t) => ({
      runId: t.runId,
      projectId: t.projectId,
      sessionId: t.sessionId,
      startedAt: t.startedAt,
      text: t.text,
      blocked: t.pending.size > 0,
    }))
  }

  /** The in-flight turn for a conversation, if any. */
  turnForSession(sessionId: string): ChatTurn | undefined {
    return this.turns().find((t) => t.sessionId === sessionId)
  }

  /**
   * The conversation holding this project's checkout, or null if it is free.
   *
   * The whole of the lock. Derived on every read from whether a turn is actually
   * in flight, so there is no held/free flag that a crash could leave saying
   * "held" forever — and nothing to reconcile when the daemon comes back.
   */
  holderFor(projectId: string): ChatTurn | null {
    return this.turns().find((t) => t.projectId === projectId) ?? null
  }

  /**
   * How many conversations are holding a session open.
   *
   * Deliberately NOT part of `busy` in `/api/health`: an idle warm session is a
   * process, not work in progress, and counting it as busy would block the dev
   * server's restart-on-change for as long as a chat tab sits open.
   */
  liveSessions(): number {
    return this.#workers.size
  }

  /**
   * The warm session for a conversation, if one can take this message.
   *
   * Every condition here is a way reuse would be wrong rather than merely
   * suboptimal: a busy worker would interleave two turns into one transcript, a
   * closing one is on its way out, and a stale brief means the system prompt no
   * longer matches `project.md`.
   */
  #reusable(opts: SendOptions, projectDoc: string): SessionWorker | null {
    if (!opts.sessionId) return null
    for (const worker of this.#workers) {
      if (worker.sessionId !== opts.sessionId) continue
      if (worker.closing || worker.turn) return null
      // `refRoot`, because `worker.root` is now a ref and comparing an object
      // to a string is always false — every warm session would be discarded and
      // every message would pay a cold start.
      if (worker.projectId !== opts.project.id || refRoot(worker.root) !== opts.project.root)
        return null
      if (worker.projectDoc !== projectDoc) return null
      return worker
    }
    return null
  }

  async send(opts: SendOptions): Promise<string> {
    const { project } = opts
    // The narrower check first, so the common mistake — pressing send twice on
    // one conversation — gets the message that describes it rather than the
    // lock's, which would be true but confusing about a chat you are looking at.
    if (opts.sessionId && this.turnForSession(opts.sessionId)) {
      throw new Error("this conversation already has a turn in flight")
    }
    const holder = this.holderFor(project.id)
    if (holder) throw new Error(lockRefusal(holder))

    const runId = randomUUID()

    // Registered SYNCHRONOUSLY, in the same tick as the check above, and that is
    // what turns the check into a lock rather than a guess.
    //
    // `holderFor` reads `#turns`, so until this line the lock is held by nobody:
    // two requests arriving together would both see a free project, both await
    // the reads below, and both start an agent in the same checkout — the lock
    // failing at exactly the moment it exists for. Everything that can suspend
    // happens after this point.
    const record: TurnRecord = {
      runId,
      projectId: project.id,
      sessionId: opts.sessionId,
      startedAt: Date.now(),
      text: opts.text,
      worker: null,
      interrupted: false,
      pending: new Set(),
      settling: null,
      nested: null,
      sourceIdAtStart: null,
    }
    this.#turns.set(runId, record)

    try {
      // Together, because they are independent and this is the path a human is
      // waiting on. The fingerprint is read AFTER admission like everything else
      // that can suspend — the lock above is taken synchronously and nothing may
      // run in front of it.
      const [doc, sourceIdAtStart] = await Promise.all([
        readProjectDoc(project.root),
        currentSourceId(),
      ])
      record.sourceIdAtStart = sourceIdAtStart

      // The human's own words go in first, before the SDK is even contacted, so
      // a turn that fails to spawn still shows what it was answering. The pasted
      // screenshots go in with them: a message that is half a sentence and a
      // picture reads as half a sentence without them, and the session file that
      // will hold the other copy does not exist yet at this point in the turn.
      const images = opts.attachments.map((a) => ({ mediaType: a.mediaType, data: a.data }))
      this.log.append(runId, {
        type: "user.message",
        text: opts.text,
        // Omitted rather than empty, so a turn with no screenshots logs the same
        // line it always did.
        ...(images.length ? { images } : {}),
        // Written only when thinking was OFF, for the same reason: every log in
        // `~/.aide/runs` predates the toggle, and a turn that says nothing about
        // thinking is a turn that thought. This is the only record of it — the
        // profile is where the toggle gets judged, and it reads this line.
        ...(opts.thinking ? {} : { thinking: false }),
      })

      // AWAITED, before anything can write. This is the one ordering constraint
      // in the file that is not negotiable: the snapshot has to be of the tree as
      // it was BEFORE the agent touched it, or it is a snapshot of the damage. It
      // throws rather than continuing, because a run with no checkpoint has no
      // undo and no diff baseline — exactly the two things that make working in
      // the human's own checkout survivable.
      await this.#checkpoint(project, opts.sessionId, runId)

      const warm = this.#reusable(opts, doc.body)
      if (warm) {
        this.#followUp(warm, record, opts)
        return runId
      }

      void this.#coldStart(record, opts, doc.body).catch((err) => {
        this.log.append(runId, {
          type: "run.error",
          message: err instanceof Error ? err.message : String(err),
        })
        this.#turns.delete(runId)
      })
      return runId
    } catch (err) {
      // Nothing has a worker yet, so nothing else will ever clear this record —
      // and a record left behind holds the project's lock against a turn that is
      // never going to finish.
      this.#turns.delete(runId)
      throw err
    }
  }

  /**
   * Run something that needs the checkout but is not an agent, as a run of its
   * own.
   *
   * The commit is the only caller and probably always will be, but it goes
   * through the lane rather than straight at git for reasons that are all the
   * lane's: committing underneath a working agent races its next write, a commit
   * mid-turn would be a half-finished diff, and the browser has exactly one way
   * to watch something happen — subscribe to a run id. Registering a record is
   * also what makes the project show as held while it runs, so the "new chat"
   * button does not offer to start a conversation on top of a commit in flight.
   *
   * It starts with none of what the agent path has — no worker, no checkpoint
   * (nothing here edits the tree except by committing it), no permissions. What
   * `work` gets is an `emit` for progress, a `delta` for text still arriving,
   * and a `stopped` it can check before it writes anything; the terminal event
   * is appended here so the invariant every reader depends on — a log ends in
   * exactly one — cannot be broken by a caller that forgot.
   *
   * It can acquire an agent part way through, though, and exactly once: see
   * `turnUnderHold`, which is how a refused commit hands the failing check back
   * to the conversation without giving up the checkout in between.
   */
  hold(opts: {
    project: Project
    /**
     * The conversation this run is attributed to, or null for none.
     *
     * Null is a real case, not a gap: a commit can be pressed with no chat open,
     * over work an editor made, and it still needs the project's lock and a run
     * id to watch. What it does not get is a session — `spendBySession` reads
     * `run.started` and skips a run with none, which is the honest answer, since
     * there is no conversation for its cost to belong to.
     */
    sessionId: string | null
    /** What this run is, for the lock refusal the next chat would get. */
    text: string
    /** Named in `run.started` so a profile bills it to something. */
    model: string
    work: (run: {
      runId: string
      emit: (body: RunEventBody) => void
      /** Live-only, never logged — the same channel a turn's tokens go down. */
      delta: (d: RunDelta) => void
      stopped: () => boolean
    }) => Promise<{ costUsd: number; modelUsage: Record<string, ModelSpend> }>
  }): string {
    const { project, sessionId } = opts
    if (sessionId && this.turnForSession(sessionId)) {
      throw new Error("this conversation already has a turn in flight")
    }
    const holder = this.holderFor(project.id)
    if (holder) throw new Error(lockRefusal(holder))

    const runId = randomUUID()
    // Registered synchronously, for the same reason `send` does it: until this
    // line the project reads as free, and two presses arriving together would
    // both be admitted.
    const record: TurnRecord = {
      runId,
      projectId: project.id,
      sessionId,
      startedAt: Date.now(),
      text: opts.text,
      worker: null,
      interrupted: false,
      pending: new Set(),
      settling: null,
      nested: null,
      // A commit stages and writes history; it cannot edit the daemon's source,
      // so there is nothing for the end of it to compare against.
      sourceIdAtStart: null,
    }
    this.#turns.set(runId, record)

    // `run.started` carries the session id, and it is the ONLY event that does.
    // A log without it is a log nothing can attribute to a conversation — which
    // is right here when there is no conversation, and a profile billing this
    // run to nobody is the truth about a commit nobody asked for in a chat.
    this.log.append(runId, {
      type: "run.started",
      taskId: "",
      projectId: project.id,
      model: opts.model,
      cwd: project.root,
      sessionId,
    })

    // An async wrapper rather than `.then(ok, err).finally(...)`, so that a
    // `work` which throws before it returns a promise is caught here too. It
    // would otherwise throw out of `hold` with the record already registered,
    // and a record nothing will ever clear holds the project for good.
    const settle = async () => {
      try {
        const spend = await opts.work({
          runId,
          emit: (body) => {
            this.log.append(runId, body)
          },
          delta: (d) => {
            const watchers = this.#watchers.get(runId)
            if (watchers) for (const fn of watchers) fn(d)
          },
          stopped: () => record.interrupted,
        })
        const cancelled = record.interrupted
        this.log.append(runId, {
          type: "run.finished",
          subtype: cancelled ? "cancelled" : "success",
          status: cancelled ? "cancelled" : "success",
          totalCostUsd: spend.costUsd,
          modelUsage: spend.modelUsage,
          // Not an agent: there are no SDK steps to count, and inventing one
          // would put a turn in a profile that never happened.
          numTurns: 0,
          durationMs: Date.now() - record.startedAt,
          permissionDenials: [],
        })
      } catch (err) {
        this.log.append(runId, {
          type: "run.error",
          message: err instanceof Error ? err.message : String(err),
        })
      } finally {
        // A turn still running inside this one is settled rather than orphaned.
        // `work` awaits it, so reaching here with one outstanding means `work`
        // threw around it — and the record is about to go, which would leave
        // whoever asked for the turn holding a promise nothing can resolve.
        this.#settleNested(record, { errors: ["the run it was inside ended"] })
        // Deleting the record is what releases the project. There is no snapshot
        // to wait for here — the tree after a commit is the tree the commit
        // made, and the conversation's checkpoint still points where it did.
        this.#turns.delete(runId)
        this.#watchers.delete(runId)
      }
    }
    void settle()

    return runId
  }

  /**
   * Run one agent turn INSIDE a run that already holds this project.
   *
   * The commit is the only caller: when a project's own check refuses a commit,
   * the gate hands that failure back to the conversation and waits for one
   * attempt at fixing it, then checks again. See `commitWorkingTree`.
   *
   * Why not just send a normal turn. `send` would be refused by the lock, and
   * rightly — the commit IS holding the checkout. Releasing it first and sending
   * afterwards would open a window for another chat to be admitted into the tree
   * halfway through a commit, and would need the retry to re-acquire a lock it
   * had just given away. So the fix runs inside the hold, which is also what
   * keeps the whole thing one run: one thing to watch, one thing to stop, one
   * terminal event at the end of it.
   *
   * Everything the turn emits is logged under the HELD run's id, not one of its
   * own. That is what makes it visible: the browser is already subscribed to the
   * commit it pressed, and a fix streaming into a run id nobody is watching
   * would only surface on the next reload.
   *
   * No checkpoint is taken. The conversation's own is the baseline its diff is
   * measured against, and moving it to just before the fix would hide the work
   * the fix was repairing.
   */
  async turnUnderHold(opts: {
    /** The held run. Its record is what holds the project, and it survives this. */
    runId: string
    project: Project
    /** The conversation to append the turn to. A hold with none cannot use this. */
    sessionId: string
    text: string
    effort: EffortLevel
  }): Promise<HeldTurnOutcome> {
    const record = this.#turns.get(opts.runId)
    if (!record) throw new Error("that run is not holding this project any more")
    if (record.projectId !== opts.project.id) throw new Error("that run holds another project")
    if (record.nested) throw new Error("that run already has a turn inside it")

    const doc = await readProjectDoc(opts.project.root)

    // Stopped while the brief was being read. Answered here rather than left to
    // the worker, because `#coldStart` would file an interrupt as the HELD run's
    // terminal event and take the commit's own outcome with it.
    if (record.interrupted) {
      return { status: "cancelled", costUsd: 0, modelUsage: {}, errors: [] }
    }

    // In the log before the worker exists, so the transcript shows what aide
    // asked for in aide's own words. A fix that appeared with no request in
    // front of it would read as the agent having done something unbidden.
    this.log.append(opts.runId, { type: "user.message", text: opts.text })

    const settled = new Promise<HeldTurnOutcome>((resolve) => {
      record.nested = {
        settle: resolve,
        costUsd: 0,
        modelUsage: {},
        status: null,
        errors: [],
      }
    })

    const send: SendOptions = {
      project: opts.project,
      sessionId: opts.sessionId,
      text: opts.text,
      attachments: [],
      // Auto, and not a choice anybody gets to make. Nobody typed this turn and
      // nobody is promised a question by it, so a mode that asks would block it
      // on a prompt with no one to answer — with the project's checkout held for
      // as long as it waited.
      mode: "auto",
      effort: opts.effort,
      // On, and not a choice anybody gets to make either. The toggle is a thing
      // you flip for a small ask you can read the answer to; this turn is the
      // one nobody reads before it runs, it gets exactly one attempt, and what
      // it is being handed is a check that already failed once.
      thinking: true,
    }

    // The warm session if there is one, and that is not only for the ~1.4s: a
    // second SDK session opened over a conversation whose own is still live
    // means two processes appending to one transcript file, and a human's next
    // message landing in whichever of them `#reusable` happened to pick.
    //
    // It costs something, once, and the cost is worth naming. `fastBashSettings`
    // is fixed at query creation, so a conversation that was being driven in
    // Plan has no `Bash(*)` rule to inherit — this turn is Auto and acts, but
    // each command is classified by the CLI at seconds apiece instead of being
    // allowed outright. Slower, never blocked, and only for the fix that follows
    // a Plan session.
    const warm = this.#reusable(send, doc.body)
    if (warm) {
      this.#followUp(warm, record, send)
    } else {
      void this.#coldStart(record, send, doc.body).catch((err) => {
        // The record belongs to the commit, so a worker that never started must
        // settle this promise rather than leave the commit awaiting a turn that
        // will never report.
        this.#settleNested(record, {
          status: "failed",
          errors: [err instanceof Error ? err.message : String(err)],
        })
      })
    }

    return settled
  }

  /**
   * The turn inside a held run is over. The run itself is not.
   *
   * Clearing `worker` matters as much as resolving: the held record keeps that
   * reference only for the length of the nested turn, and an interrupt arriving
   * afterwards would otherwise be delivered to a warm session that has moved on
   * — stopping whatever the human sent it next.
   */
  #settleNested(
    record: TurnRecord,
    override: { status?: RunStatus; errors?: string[] } = {},
  ): void {
    const nested = record.nested
    if (!nested) return
    record.nested = null
    record.worker = null
    nested.settle({
      // "failed" when the worker went away without reporting anything, which is
      // the honest reading of a turn nothing said finished.
      status: override.status ?? nested.status ?? "failed",
      costUsd: nested.costUsd,
      modelUsage: nested.modelUsage,
      errors: override.errors ?? nested.errors,
    })
  }

  /**
   * Hand a message to a session that is already open.
   *
   * The record is adopted rather than created: `send` registered it before it
   * awaited anything, which is what holds the lock, and building a second one
   * here would leave the first in `#turns` forever.
   */
  #followUp(worker: SessionWorker, record: TurnRecord, opts: SendOptions): void {
    if (worker.idle) {
      clearTimeout(worker.idle)
      worker.idle = null
    }

    const { runId } = record
    record.worker = worker
    record.sessionId = worker.sessionId
    worker.turn = record

    // Only what CHANGED. Each of these is a control round trip into the CLI, and
    // sending three every turn to restate settings the session already has is
    // the kind of overhead this whole change exists to remove.
    const turn: FollowUpTurn = {
      runId,
      text: opts.text,
      ...(opts.attachments.length ? { attachments: opts.attachments } : {}),
      ...(opts.mode !== worker.mode ? { mode: opts.mode } : {}),
      ...(opts.effort !== worker.effort ? { effort: opts.effort } : {}),
      ...(opts.thinking !== worker.thinking ? { thinking: opts.thinking } : {}),
    }
    worker.mode = opts.mode
    worker.effort = opts.effort
    worker.thinking = opts.thinking

    worker.runner.send({ cmd: "turn", turn } satisfies ToWorker)
  }

  /**
   * Snapshot the working tree, once per conversation.
   *
   * Keyed by session, because the baseline a review needs is the tree as it was
   * when the CONVERSATION started, not when its latest turn did. Re-snapshotting
   * every turn would fold each turn's own work into the next turn's baseline, so
   * the diff at the end would show only whatever the last message happened to
   * change and silently drop the rest.
   *
   * A brand new conversation has no session id yet — the SDK assigns one after
   * the agent has started, which is far too late to be snapshotting anything —
   * so the first turn checkpoints under its run id and the ref is handed over
   * once the session has a name. See `adoptCheckpoint`.
   */
  async #checkpoint(project: Project, sessionId: string | null, runId: string): Promise<void> {
    const root = project.root
    const existing = sessionId ? await readCheckpoint(root, sessionId) : null
    if (existing) return

    const made = await takeCheckpoint(root, sessionId ?? runId)

    // How much of the human's own work this is standing in front of. Counted
    // against the checkpoint's parent rather than HEAD so it stays right in a
    // repo with no commits, where there is no parent and the honest answer is
    // that nothing was dirty because nothing was committed.
    const dirty = await gitOr("", () =>
      git(root, ["diff", "--name-only", "-z", `${made.sha}^`, made.sha]),
    )

    this.log.append(runId, {
      type: "checkpoint.taken",
      ref: made.ref,
      sha: made.sha,
      dirtyCount: dirty.split("\0").filter(Boolean).length,
      restore: restoreCommand(made.ref),
    })
  }

  /** Fork a worker and open a session. `resume` carries the conversation. */
  async #coldStart(
    record: TurnRecord,
    opts: SendOptions,
    projectDoc: string,
  ): Promise<void> {
    const { project } = opts
    const { runId } = record
    const cwd = project.root

    // A turn inside a held run reports its own interrupt to the run that asked
    // for it and to nobody else: the log is the COMMIT's, and a terminal event
    // written into it here would seal it against the outcome the commit is still
    // going to have.
    if (record.interrupted && record.nested) {
      this.#settleNested(record, { status: "cancelled" })
      return
    }

    // Stopped between admission and the fork. Give it a terminal event of its
    // own — every consumer of a log assumes it ends in exactly one — rather than
    // a log that just stops after the checkpoint.
    if (record.interrupted) {
      this.log.append(runId, {
        type: "run.finished",
        subtype: "cancelled_before_start",
        status: "cancelled",
        totalCostUsd: 0,
        modelUsage: {},
        numTurns: 0,
        durationMs: Date.now() - record.startedAt,
        permissionDenials: [],
      })
      this.#turns.delete(runId)
      return
    }

    const job: RunAgentOptions = {
      runId,
      taskId: "",
      projectId: project.id,
      // A chat turn is the message, with no title composed in front of it.
      title: opts.text,
      prompt: "",
      projectDoc,
      // Always the project root. There is no other place a run can happen.
      cwd,
      model: CONFIG.taskModel,
      // Read-only tools only. Edit, Write and Bash deliberately fall through to
      // the mode and to canUseTool, because a bare name here auto-approves the
      // tool before either is consulted — which would let a Plan turn edit the
      // tree it was told to describe.
      allowedTools: [...CONFIG.chatAutoAllowTools],
      allowedBash: [...CONFIG.allowedBash],
      deniedBash: [...CONFIG.deniedBash],
      env: CONFIG.runEnv,
      ...(CONFIG.chatMaxBudgetUsd ? { maxBudgetUsd: CONFIG.chatMaxBudgetUsd } : {}),
      chatMode: opts.mode,
      effort: opts.effort,
      thinking: opts.thinking,
      attachments: opts.attachments,
      trackContext: true,
      ...(opts.sessionId ? { resume: opts.sessionId } : {}),
    }

    // The one line that decides which machine this conversation runs on.
    // Everything below is identical either way — the lock, the turn record, the
    // event handlers — because both sides of this speak the same protocol.
    const runner: Runner = project.host
      ? new SshRunner({
          host: project.host,
          configPath: sshConfigPath(),
          agentPath: REMOTE_AGENT,
          runId,
        })
      : new LocalRunner(WORKER, runId)

    const worker: SessionWorker = {
      runner,
      projectId: project.id,
      root: repoOf(project),
      sessionId: opts.sessionId,
      mode: opts.mode,
      effort: opts.effort,
      thinking: opts.thinking,
      model: CONFIG.taskModel,
      projectDoc,
      turn: null,
      closing: false,
      idle: null,
    }
    this.#workers.add(worker)

    // The record was registered by `send` before the checkpoint ran, so it is
    // adopted here rather than created — rebuilding it would drop an interrupt
    // that arrived in between.
    record.worker = worker
    worker.turn = record

    // Draining the worker's stdout and stderr is `LocalRunner`'s job now, since
    // it is the thing that opened those pipes — and a remote runner has no such
    // pipes to drain.

    runner.onMessage((msg) => {
      if (msg.type === "ready") {
        runner.send({ cmd: "start", job } satisfies ToWorker)
        return
      }
      if (msg.type === "closed") {
        this.#retire(worker, "the conversation's session ended")
        return
      }

      // Everything below belongs to one turn, and the worker says which. Trusting
      // "whatever the lane thinks is current" instead would misfile a turn's
      // trailing events onto the next one the moment two messages overlap.
      const turn = this.#turns.get(msg.runId)

      if (msg.type === "delta") {
        const watchers = this.#watchers.get(msg.runId)
        if (watchers) for (const fn of watchers) fn(msg.body)
        return
      }
      if (msg.type === "permission") {
        turn?.pending.add(msg.requestId)
        this.log.append(msg.runId, {
          type: "permission.request",
          requestId: msg.requestId,
          name: msg.name,
          input: msg.input,
        })
        return
      }
      if (msg.type === "event") {
        // A turn running inside a held run writes that run's middle and neither
        // of its ends. See `TurnRecord.nested`: `run.started` is already in this
        // log, and a terminal event would seal it against everything the commit
        // has left to say — the failing check it is about to re-run, the message
        // it writes, the sha it lands, its own outcome.
        if (turn?.nested) {
          if (msg.body.type === "run.started") return
          if (msg.body.type === "run.finished") {
            turn.nested.costUsd = msg.body.totalCostUsd
            turn.nested.modelUsage = msg.body.modelUsage
            turn.nested.status = turn.interrupted ? "cancelled" : msg.body.status
            turn.nested.errors = msg.body.errors ?? []
            return
          }
          if (msg.body.type === "run.error") {
            turn.nested.status = "failed"
            turn.nested.errors = [msg.body.message]
            return
          }
          this.log.append(msg.runId, msg.body)
          return
        }

        // A new conversation learns its id from the SDK's init message; capture
        // it so the browser can switch from "new chat" to a real conversation
        // without waiting for the turn to finish. The worker needs it too, or a
        // follow-up would not find the session it is already holding open.
        if (msg.body.type === "run.started" && msg.body.sessionId) {
          const named = msg.body.sessionId
          worker.sessionId = named
          if (turn) turn.sessionId = named
          // Hand the checkpoint from the run id it was taken under to the
          // session that now owns it. Until this lands the only reference to the
          // snapshot is a ref nothing will ever look up again, so a crash right
          // here is the one case where an undo goes missing — hence doing it the
          // moment the name exists rather than when the turn ends.
          void adoptCheckpoint(worker.root, msg.runId, named).catch(() => {})
        }
        if (msg.body.type === "run.finished") {
          const outcome = {
            ...msg.body,
            status: turn?.interrupted ? "cancelled" : msg.body.status,
          }
          // The turn's restore point goes in FIRST, and the outcome line waits
          // for it. Appending it afterwards would read the same on screen and
          // break the invariant the rest of the daemon leans on — a run log ends
          // in exactly one terminal event, and `smoke-queue` reads the last
          // event to decide how a turn ended rather than searching for it.
          const settled = this.#markTurn(worker, msg.runId)
            // The outcome is appended whatever the snapshot did. A turn that
            // succeeded must not be reported as one that never ended because a
            // git call for a convenience on top of it failed.
            .catch(() => {})
            // Same bargain, and the same order: both of these are notes ABOUT
            // the turn and both have to be in the log before the line that ends
            // it, because a run log ends in exactly one terminal event.
            .then(() => this.#noteStale(msg.runId).catch(() => {}))
            .then(() => {
              this.log.append(msg.runId, outcome)
            })
          if (turn) turn.settling = settled
          void settled.catch(() => {})
          return
        }
        this.log.append(msg.runId, msg.body)
        return
      }
      if (msg.type === "done") {
        this.#finishTurn(worker, msg.runId)
      }
    })

    runner.onError((err) => {
      this.#retire(worker, `worker error: ${err.message}`)
    })

    runner.onExit((code, signal) => {
      this.#retire(
        worker,
        `the turn ended without a result (code ${code}, signal ${signal ?? "none"})`,
      )
    })
  }

  /**
   * A turn landed. The session stays warm for the next message.
   *
   * Deleting the record is what releases the project's lock, so it waits for the
   * turn's restore point to be written. The other order is a real bug and a
   * quiet one: the next turn is admitted the instant the record goes, and its
   * first writes would land in the tree the previous turn's snapshot is still
   * being taken from — a restore point labelled "after turn 3" holding part of
   * turn 4.
   */
  #finishTurn(worker: SessionWorker, runId: string): void {
    // The WORKER is free immediately — it has nothing left to do, and leaving
    // this set across the snapshot would have a worker that exited in that
    // window retired as a turn that died, printing `run.error` over an outcome
    // that already said the turn succeeded.
    if (worker.turn?.runId === runId) worker.turn = null

    // A turn that ran inside a held run ends here and takes nothing with it. The
    // record is the COMMIT's, and deleting it would release the project halfway
    // through one — with the tree the fix just rewrote left uncommitted and a
    // new chat free to start on top of it.
    const record = this.#turns.get(runId)
    if (record?.nested) {
      this.#settleNested(record)
      this.#armIdle(worker)
      return
    }

    const release = () => {
      this.#turns.delete(runId)
      this.#watchers.delete(runId)
      this.#armIdle(worker)
    }
    // The RECORD is what holds the project, so it waits. Nothing else can be let
    // into the checkout until this turn's boundary has been written from it.
    const settling = record?.settling
    if (!settling) return release()
    void settling.then(release, release)
  }

  /**
   * Record where the tree stands as the end of this turn.
   *
   * Failures are swallowed rather than raised. The conversation's own checkpoint
   * has a throw behind it because a run without one has no undo and no diff
   * baseline; this is a finer-grained convenience sitting on top of that, and a
   * turn that has already succeeded should not be reported as failed because the
   * boundary marker did not get written. Nothing is lost permanently either way
   * — the next turn's boundary covers this turn's work too, just less precisely.
   */
  async #markTurn(worker: SessionWorker, runId: string): Promise<void> {
    // A session with no id yet cannot key a ref. In practice the SDK has named
    // it long before the turn ends; this is the ordering, not a case.
    const session = worker.sessionId
    if (!session) return
    const made = await gitOr<TurnCheckpoint | null>(null, () =>
      takeTurnCheckpoint(worker.root, session),
    )
    // Null means the turn changed nothing on disk, which is most questions.
    if (!made) return

    this.log.append(runId, {
      type: "turn.checkpoint",
      ref: made.ref,
      sha: made.sha,
      n: made.n,
      restore: restoreCommand(made.ref),
    })
  }

  /**
   * Say so if this turn left the daemon running code that no longer exists.
   *
   * Answers, in the transcript, the question this repository's logs show being
   * asked in a fresh chat instead: whether the change that was just made is in
   * the process you are talking to. The daemon rail has carried the same fact
   * all along, three panes away and phrased as a state rather than as an answer
   * to anything.
   *
   * Silent unless the fingerprint moved across this turn, which is what keeps it
   * off every run on every project that is not aide's own checkout — no path
   * matching, and nothing here knows the name of a directory.
   */
  async #noteStale(runId: string): Promise<void> {
    const record = this.#turns.get(runId)
    if (!record) return
    const moved = await staleSince(record.sourceIdAtStart)
    if (!moved) return

    this.log.append(runId, {
      type: "turn.stale",
      bootSourceId: moved.bootSourceId,
      sourceId: moved.sourceId,
      supervised: CONFIG.supervised,
    })
  }

  /**
   * Close a session nobody has spoken to in a while.
   *
   * An open session is a CLI subprocess and a context window sitting in memory,
   * and a conversation you left an hour ago is not coming back inside a timeout
   * — it will cold-start with `resume` and lose nothing but the second it saves.
   */
  #armIdle(worker: SessionWorker): void {
    if (worker.idle) clearTimeout(worker.idle)
    worker.idle = setTimeout(() => {
      worker.idle = null
      if (worker.turn) return
      worker.closing = true
      worker.runner.send({ cmd: "close" } satisfies ToWorker)
      // The close is cooperative and the worker exits on its own; this is the
      // backstop for one that does not, so an evicted session cannot leak a
      // process for the life of the daemon.
      setTimeout(() => {
        if (this.#workers.has(worker)) worker.runner.kill()
      }, this.#closeGraceMs).unref?.()
    }, this.#idleMs)
    // A warm session must never be the reason the daemon cannot exit.
    worker.idle.unref?.()
  }

  /**
   * The session is gone. Any turn still on it never got a terminal event, so it
   * gets one here — every consumer of a run log assumes it ends in exactly one.
   */
  #retire(worker: SessionWorker, reason: string): void {
    if (!this.#workers.delete(worker)) return
    if (worker.idle) clearTimeout(worker.idle)
    worker.idle = null

    const turn = worker.turn
    worker.turn = null
    // The held run outlives the worker that was carrying out its fix, so this
    // reports the death to it rather than over it. Writing `run.error` into that
    // log would seal it, and dropping the record would release a project the
    // commit is still standing in.
    if (turn?.nested) {
      // The reason, but not a verdict: a worker that dies between reporting its
      // outcome and being let go of has still done the work, and overriding a
      // success here would have the commit narrate a fix that landed as one that
      // never finished.
      this.#settleNested(turn, { errors: [reason] })
      return
    }
    if (turn && this.#turns.delete(turn.runId)) {
      this.log.append(turn.runId, { type: "run.error", message: reason })
      this.#watchers.delete(turn.runId)
    }
  }

  /** Answer a pending permission request. Returns false if it is already gone. */
  resolvePermission(runId: string, requestId: string, allowed: boolean): boolean {
    const record = this.#turns.get(runId)
    if (!record || !record.pending.has(requestId)) return false
    record.pending.delete(requestId)
    // A turn still installing dependencies has no worker and no pending calls,
    // so the guard above already returned. `?.` covers the ordering rather than
    // a real case.
    record.worker?.runner.send({ cmd: "permission", requestId, allowed } satisfies ToWorker)
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

    // `?.` rather than a guard: a turn interrupted between admission and the
    // fork has no worker to tell, and `#coldStart` checks `interrupted` before
    // it starts one. Nor does a held run, unless it is part way through the fix
    // `turnUnderHold` gave it — in which case this is what stops the agent, and
    // the flag above is what stops the commit that was waiting on it.
    record.worker?.runner.send({ cmd: "interrupt" } satisfies ToWorker)
    return true
  }

  /** Ends every turn and every session. Called from the daemon's shutdown path. */
  shutdown(): void {
    // Settled before the records go, or a commit waiting on a fix would sit on a
    // promise nothing can resolve and keep the process from exiting.
    for (const record of this.#turns.values()) {
      this.#settleNested(record, { status: "cancelled", errors: ["aide is shutting down"] })
    }
    for (const worker of this.#workers) {
      worker.closing = true
      if (worker.idle) clearTimeout(worker.idle)
      worker.idle = null
      worker.runner.send({ cmd: "interrupt" } satisfies ToWorker)
      worker.runner.kill()
    }
    this.#workers.clear()
    this.#turns.clear()
  }
}

/**
 * Why a second run was refused, written to be acted on rather than merely read.
 *
 * It names the conversation holding the repo and how long it has had it, because
 * "one run at a time" without those two facts is a dead end — the whole question
 * in the moment is whether the thing in your way is nearly done or wedged.
 */
function lockRefusal(holder: ChatTurn): string {
  const title = holder.text.split("\n").find((l) => l.trim())?.trim() ?? "another conversation"
  const short = title.length > 60 ? `${title.slice(0, 60)}…` : title
  return `"${short}" has the repo (started ${since(holder.startedAt)}). Stop it, or wait for it to finish.`
}

/** Coarse on purpose: this reads in a sentence, not a status bar. */
function since(startedAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.round(minutes / 60)}h ago`
}
