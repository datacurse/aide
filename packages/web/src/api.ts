import type {
  Activity,
  Attachment,
  ChatSpend,
  ChatStatus,
  ChatMode,
  ChatModel,
  ConversationSummary,
  EffortLevel,
  FolderPick,
  GitHistory,
  GitPending,
  GitTree,
  Health,
  PlanUsage,
  Profile,
  Project,
  RunEvent,
  SshHost,
  SshListing,
} from "@aide/protocol"

/**
 * A conversation, plus the two things aide knows about it that the session file
 * does not: whether you are finished with it, and what it spent.
 *
 * Attached by the daemon rather than stored in the session file: the SDK owns
 * the transcript, aide owns the lifecycle, and merging them on the wire keeps
 * the list to one request.
 *
 * `spend` is null for a conversation aide never ran a turn of — a chat held in
 * the CLI or the VS Code extension shows up in the same list, and there is no
 * event log behind it to measure.
 */
/**
 * Protocol types re-exported so a component can take its data and the call that
 * fetched it from one import.
 *
 * Not a barrel for its own sake: the alternative is every pane importing the
 * shape from `@aide/protocol` and the fetcher from `./api`, which is two lines
 * saying one thing. Both spellings work and both are in use — this exists for
 * the files that would otherwise import from two places to draw one pane.
 */
export type {
  Activity,
  ConversationSummary,
  FolderPick,
  GitHistory,
  GitPending,
  GitTree,
  Health,
  PlanUsage,
  Profile,
  SshHost,
  SshListing,
}

export type ConversationRow = ConversationSummary & {
  status: ChatStatus
  spend: ChatSpend | null
}

/** A conversation's replayed transcript. */
export interface ConversationView {
  summary: ConversationRow
  events: RunEvent[]
  truncated: boolean
  totalMessages: number
}

/**
 * Who has a project's checkout right now, if anyone.
 *
 * Also the only thing about a running conversation that is polled — see the
 * route. The chat list's own rows carry a status, but it is as old as the last
 * time something asked for the list, so anything that has to be true NOW is read
 * off this instead.
 */
export interface LockHolder {
  runId: string
  /** null for the moment before the SDK names a brand new conversation. */
  sessionId: string | null
  title: string
  startedAt: number
  /** A tool call is waiting on a human. The one thing that is stopped ON you. */
  blocked: boolean
  /**
   * The daemon's own hold — an auto-commit landing — not a conversation's
   * turn. It locks nothing here: the daemon queues a send behind it, so the
   * only gate that reads it is push. Optional-read (`?.held`) in gates via
   * GateHolder, so a daemon older than this field just means every holder
   * blocks, which was yesterday's behaviour.
   */
  held: boolean
}

export type ProjectView = Project & { holder: LockHolder | null }

/**
 * Daemon lifecycle, served by the Vite dev server rather than the daemon — the
 * one thing that must still answer when the daemon is down. In a built bundle
 * these routes do not exist, and `daemonStatus()` resolves to null so the UI can
 * drop the controls rather than show dead buttons.
 */
export type DaemonState = "stopped" | "starting" | "running" | "adopted"

export interface DaemonStatus {
  state: DaemonState
  port: number
  pid: number | null
  managed: boolean
  startedAt: number | null
  lastExit: { code: number | null; signal: string | null; at: number } | null
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  })
  if (!res.ok) {
    const detail = await res.json().catch(() => ({ message: res.statusText }))
    throw new Error((detail as { message?: string }).message ?? `HTTP ${res.status}`)
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
}

/** null when there is no dev-server control plane, as opposed to a real failure. */
async function daemonCall(path: string, init?: RequestInit): Promise<unknown | null> {
  const res = await fetch(`/__daemon${path}`, init)
  if (res.status === 404) return null
  // A static host serving the built bundle answers unknown paths with index.html
  // and a cheerful 200. Parsing that as a status object leaves the UI reporting
  // "starting…" forever, so anything that is not JSON means no control plane.
  if (!(res.headers.get("content-type") ?? "").includes("application/json")) return null
  const body = await res.json().catch(() => null)
  if (body === null) return null
  if (!res.ok) throw new Error((body as { message?: string }).message ?? `HTTP ${res.status}`)
  return body
}

export const api = {
  health: () => call<Health>("/api/health"),

  /**
   * What is left of the plan. Slower than everything else here — a cold reading
   * opens a session with the CLI — so it is polled on its own long beat rather
   * than on the app's.
   */
  usage: () => call<PlanUsage>("/api/usage"),

  /**
   * Activity across every project — the dashboard.
   *
   * Not on the app's beat. It reduces every run log on the machine, and it
   * describes turns that have already ended, so redrawing it twice a second
   * would burn the work to produce an identical document. The page fetches on
   * open, on a change of window, and when you press refresh.
   */
  activity: (days: number) => call<Activity>(`/api/activity?days=${days}`),

  daemonStatus: () => daemonCall("/status") as Promise<DaemonStatus | null>,
  daemonLog: () => daemonCall("/log") as Promise<{ lines: string[] } | null>,
  daemonStart: () => daemonCall("/start", { method: "POST" }) as Promise<{ message: string } | null>,
  daemonStop: () => daemonCall("/stop", { method: "POST" }) as Promise<{ message: string } | null>,
  daemonRestart: () =>
    daemonCall("/restart", { method: "POST" }) as Promise<{ message: string } | null>,

  projects: () => call<ProjectView[]>("/api/projects"),
  /**
   * Open a folder dialog on the machine and answer with what was chosen.
   *
   * Does not resolve until the human closes the dialog, which may be minutes —
   * so it belongs to a button press and never to the poll.
   */
  browseForFolder: () => call<FolderPick>("/api/projects/browse", { method: "POST" }),
  addProject: (path: string) =>
    call<Project>("/api/projects", { method: "POST", body: JSON.stringify({ path }) }),
  /**
   * Forget a project: the registry entry, and nothing else.
   *
   * The repository, its `.aide/` and every conversation in it stay exactly where
   * they are — this is aide forgetting a path, not a delete. Refused by the
   * daemon while a run holds the checkout, because dropping the entry under a
   * live turn orphans it rather than stopping it.
   */
  removeProject: (projectId: string) =>
    call<void>(`/api/projects/${projectId}`, { method: "DELETE" }),

  /** The machines in `~/.aide/ssh_config`, and where that file is. */
  sshHosts: () => call<{ hosts: SshHost[]; configPath: string }>("/api/ssh/hosts"),
  /**
   * What is in a directory on one of them.
   *
   * Can take seconds and can fail for reasons that are nothing to do with aide —
   * a machine asleep, a key not loaded — so every caller shows what came back
   * rather than swallowing it. Like `browseForFolder`, this belongs to a press.
   */
  sshList: (host: string, path: string) =>
    call<SshListing>("/api/ssh/list", { method: "POST", body: JSON.stringify({ host, path }) }),
  /** Register a repository that lives on one of those machines. */
  addRemoteProject: (host: string, path: string) =>
    call<Project>("/api/ssh/projects", {
      method: "POST",
      body: JSON.stringify({ host, path }),
    }),
  conversations: (projectId: string) =>
    call<ConversationRow[]>(`/api/projects/${projectId}/conversations`),
  /**
   * Send the branch upstream. The one git button left — committing is the
   * daemon's, automatic, once per turn after the checks pass.
   *
   * Not a run: a couple of git calls, no model, nothing to attribute, so it
   * answers with what it did rather than a run id to go and watch.
   *
   * `squash` folds every commit ahead of the upstream into one before sending —
   * the per-turn auto-commits are the local record, and whether upstream wants
   * the steps or the change is decided at the moment of the press. On a branch
   * with no upstream it is quietly a plain publish.
   */
  pushProject: (projectId: string, squash = false) =>
    call<{ branch: string; pushed: number; squashed?: number }>(
      `/api/projects/${projectId}/push`,
      { method: "POST", body: JSON.stringify({ squash }) },
    ),
  /** Done. Nothing an agent runs can reach this. */
  closeChat: (projectId: string, sessionId: string) =>
    call<{ warning: string | null }>(
      `/api/projects/${projectId}/conversations/${sessionId}/close`,
      { method: "POST" },
    ),
  reopenChat: (projectId: string, sessionId: string) =>
    call<void>(`/api/projects/${projectId}/conversations/${sessionId}/reopen`, { method: "POST" }),
  conversation: (projectId: string, sessionId: string) =>
    call<ConversationView>(`/api/projects/${projectId}/conversations/${sessionId}`),
  /**
   * What this conversation cost and where its time went.
   *
   * On a button press, never on the app's beat: it reads and reduces every run
   * log the conversation has, which is cheap for one conversation and pointless
   * to redo every 1.5 seconds for one nobody has asked about.
   */
  profile: (projectId: string, sessionId: string) =>
    call<Profile>(`/api/projects/${projectId}/conversations/${sessionId}/profile`),

  chat: (
    projectId: string,
    body: {
      sessionId: string | null
      text: string
      attachments: Attachment[]
      mode: ChatMode
      effort: EffortLevel
      /** False sends the turn with extended thinking switched off. */
      thinking: boolean
      /** Which model answers. The daemon's default when absent. */
      model: ChatModel
    },
  ) =>
    call<{ runId: string }>(`/api/projects/${projectId}/chat`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /**
   * A short name for something parked but not sent.
   *
   * A model call, and the only one the browser makes that is not a run — it
   * takes no lock, so naming an idea works while an agent has the checkout.
   * Deliberately not on any beat: see `naming.ts` for what decides that it
   * happens once per thing you write.
   */
  nameChat: (text: string) =>
    call<{ title: string }>("/api/chat-name", { method: "POST", body: JSON.stringify({ text }) }),

  /**
   * Which conversation a run's first turn became, and whether it is over.
   *
   * The one thing a page that walked away cannot work out for itself: a session
   * id is announced once, on the live stream, a second or two into a chat's
   * first turn. `ended` says when to stop asking, for a turn that died before
   * the SDK named anything.
   */
  runSession: (runId: string) =>
    call<{ sessionId: string | null; ended: boolean }>(`/api/runs/${runId}/session`),

  answerPermission: (runId: string, requestId: string, allowed: boolean) =>
    call<{ ok: true }>(`/api/runs/${runId}/permissions/${requestId}`, {
      method: "POST",
      body: JSON.stringify({ allowed }),
    }),
  interruptChat: (runId: string) =>
    call<{ interrupted: boolean }>(`/api/runs/${runId}/chat-interrupt`, { method: "POST" }),

  /**
   * What is still uncommitted, in the scope a commit would take. Cheap: no
   * patch, no log, so the always-visible rail can poll it on the app's beat.
   */
  gitPending: (projectId: string) => call<GitPending>(`/api/projects/${projectId}/git/pending`),

  /**
   * Where HEAD is, and the commits behind it.
   *
   * The rail's other half, and on a beat of its own: history only moves when
   * somebody commits, so asking as often as the uncommitted list is asked would
   * be a `git log` and four `rev-parse`s a second for an answer that changes a
   * few times an hour.
   */
  gitHistory: (projectId: string, limit: number) =>
    call<GitHistory>(`/api/projects/${projectId}/git?limit=${limit}`),

  /**
   * What is in one directory of the working tree.
   *
   * On a press — opening a folder — and never on a beat. A tree that polled
   * would be one `ls-tree` per open directory per tick to redraw rows that move
   * only when somebody adds a file, and the mark that DOES move on every
   * keystroke is already on the rail above it.
   */
  gitTree: (projectId: string, path: string) =>
    call<GitTree>(`/api/projects/${projectId}/git/tree?path=${encodeURIComponent(path)}`),
}
