import type {
  Attachment,
  BoardRow,
  ChatStatus,
  ChatVerdict,
  ChatMode,
  ConversationSummary,
  EffortLevel,
  GitCommitDetail,
  GitSummary,
  GitWorkingTree,
  Health,
  Project,
  RunEvent,
  Todo,
} from "@aide/protocol"

export type { ConversationSummary, GitCommitDetail, GitSummary, GitWorkingTree, Health }

/**
 * A conversation plus what the board knows about it.
 *
 * Attached by the daemon rather than stored in the session file: the SDK owns
 * the transcript, aide owns the lifecycle, and merging them on the wire keeps
 * the list to one request.
 */
export type ConversationRow = ConversationSummary & { status: ChatStatus }

/** A conversation's replayed transcript. */
export interface ConversationView {
  summary: ConversationRow
  events: RunEvent[]
  truncated: boolean
  totalMessages: number
}

/** Who has a project's checkout right now, if anyone. */
export interface LockHolder {
  runId: string
  /** null for the moment before the SDK names a brand new conversation. */
  sessionId: string | null
  title: string
  startedAt: number
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

/** The board pane's whole payload: the backlog and the capability list. */
export interface BoardView {
  rows: BoardRow[]
  spec: string
  /** Project-state problems that would otherwise fail silently. Usually empty. */
  warnings: string[]
}

/** What the commit gate offers for review: a message, and the spec it earns. */
export interface ReviewDraft {
  message: string
  /** Empty when the change earns no spec update, which is the common case. */
  spec: string
  specChanged: boolean
  model: string
  /**
   * Files the run changed that were ALREADY modified before it started.
   *
   * Empty in the ordinary case. When it is not, committing takes both sets of
   * edits, because git cannot separate them — so these are named rather than
   * silently folded in.
   */
  mixed: string[]
}

/**
 * What a conversation cost and where it went wrong, derived from its run logs.
 *
 * The markdown IS the artifact — there is no structured half that the UI
 * reformats, because two representations of one set of numbers is two places for
 * them to disagree. `runs` is here only so the panel can say "no run log for
 * this conversation" without parsing the document to find out.
 */
export interface Receipt {
  sessionId: string
  runs: number
  markdown: string
}

/** A run's work, measured against the checkpoint taken before it started. */
export interface DiffView {
  root: string
  diff: string
  /** Exactly what a commit would stage. */
  paths: string[]
  mixed: string[]
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

  daemonStatus: () => daemonCall("/status") as Promise<DaemonStatus | null>,
  daemonLog: () => daemonCall("/log") as Promise<{ lines: string[] } | null>,
  daemonStart: () => daemonCall("/start", { method: "POST" }) as Promise<{ message: string } | null>,
  daemonStop: () => daemonCall("/stop", { method: "POST" }) as Promise<{ message: string } | null>,
  daemonRestart: () =>
    daemonCall("/restart", { method: "POST" }) as Promise<{ message: string } | null>,

  projects: () => call<ProjectView[]>("/api/projects"),
  addProject: (path: string) =>
    call<Project>("/api/projects", { method: "POST", body: JSON.stringify({ path }) }),
  removeProject: (id: string) => call<void>(`/api/projects/${id}`, { method: "DELETE" }),

  /** Rows and spec together: they are one view and must not render a frame apart. */
  board: (projectId: string) => call<BoardView>(`/api/projects/${projectId}/board`),
  addTodo: (projectId: string, text: string) =>
    call<Todo>(`/api/projects/${projectId}/todos`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
  editTodo: (projectId: string, todoId: string, text: string) =>
    call<Todo>(`/api/projects/${projectId}/todos/${todoId}`, {
      method: "PATCH",
      body: JSON.stringify({ text }),
    }),
  deleteTodo: (projectId: string, todoId: string) =>
    call<void>(`/api/projects/${projectId}/todos/${todoId}`, { method: "DELETE" }),
  /** Attach a conversation to a row, once the SDK has named the session. */
  linkTodo: (projectId: string, todoId: string, sessionId: string) =>
    call<void>(`/api/projects/${projectId}/board/${todoId}/session`, {
      method: "POST",
      body: JSON.stringify({ sessionId }),
    }),
  unlinkTodo: (projectId: string, todoId: string) =>
    call<void>(`/api/projects/${projectId}/board/${todoId}/session`, { method: "DELETE" }),

  events: (runId: string, fromSeq = 0) =>
    call<RunEvent[]>(`/api/runs/${runId}/events?fromSeq=${fromSeq}`),

  conversations: (projectId: string) =>
    call<ConversationRow[]>(`/api/projects/${projectId}/conversations`),
  /** What this conversation changed, against its checkpoint. */
  chatDiff: (projectId: string, sessionId: string) =>
    call<DiffView>(`/api/projects/${projectId}/conversations/${sessionId}/diff`),
  /** Where the time and the money went. Safe to ask for mid-turn. */
  receipt: (projectId: string, sessionId: string) =>
    call<Receipt>(`/api/projects/${projectId}/conversations/${sessionId}/receipt`),
  /** Commit message and spec update, drafted together because they are one review. */
  draftReview: (projectId: string, sessionId: string) =>
    call<ReviewDraft>(`/api/projects/${projectId}/conversations/${sessionId}/review/draft`, {
      method: "POST",
    }),
  commitChat: (projectId: string, sessionId: string, message: string, spec: string) =>
    call<{ sha: string }>(`/api/projects/${projectId}/conversations/${sessionId}/commit`, {
      method: "POST",
      body: JSON.stringify({ message, spec }),
    }),
  /** The verdict. Nothing an agent runs can reach this. */
  closeChat: (projectId: string, sessionId: string, verdict: ChatVerdict) =>
    call<{ rowId: string | null; rowRemoved: boolean; warning: string | null }>(
      `/api/projects/${projectId}/conversations/${sessionId}/close`,
      { method: "POST", body: JSON.stringify({ verdict }) },
    ),
  reopenChat: (projectId: string, sessionId: string) =>
    call<void>(`/api/projects/${projectId}/conversations/${sessionId}/reopen`, { method: "POST" }),
  conversation: (projectId: string, sessionId: string) =>
    call<ConversationView>(`/api/projects/${projectId}/conversations/${sessionId}`),

  chat: (
    projectId: string,
    body: {
      sessionId: string | null
      text: string
      attachments: Attachment[]
      mode: ChatMode
      effort: EffortLevel
      /** Start this conversation on an existing board row. First message only. */
      todoId?: string
      /** Put it on the board with no row yet; the daemon makes one. First message only. */
      track?: boolean
    },
  ) =>
    call<{ runId: string }>(`/api/projects/${projectId}/chat`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  answerPermission: (runId: string, requestId: string, allowed: boolean) =>
    call<{ ok: true }>(`/api/runs/${runId}/permissions/${requestId}`, {
      method: "POST",
      body: JSON.stringify({ allowed }),
    }),
  interruptChat: (runId: string) =>
    call<{ interrupted: boolean }>(`/api/runs/${runId}/chat-interrupt`, { method: "POST" }),

  branch: (projectId: string) => call<{ branch: string | null }>(`/api/projects/${projectId}/branch`),

  /** Branch, ahead/behind, dirt counts and the log — one poll's worth. */
  git: (projectId: string, limit: number) =>
    call<GitSummary>(`/api/projects/${projectId}/git?limit=${limit}`),
  /** Split out because it carries a whole patch, and is only read when shown. */
  gitWorking: (projectId: string) =>
    call<GitWorkingTree>(`/api/projects/${projectId}/git/working`),
  gitCommit: (projectId: string, sha: string) =>
    call<GitCommitDetail>(`/api/projects/${projectId}/git/commits/${sha}`),
}
