import type {
  Attachment,
  BoardRow,
  ChatStatus,
  ChatVerdict,
  ChatMode,
  ConversationSummary,
  EffortLevel,
  GitPending,
  Health,
  Project,
  RunEvent,
  Todo,
} from "@aide/protocol"

export type { ConversationSummary, GitPending, Health }

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
  /**
   * Commit this conversation's work.
   *
   * Answers with a run id, not a sha. The drafting is two model calls on the
   * diff and takes about as long as a short turn, so it goes on the event stream
   * like one — what it wrote and what it took arrive in the transcript.
   */
  commitChat: (projectId: string, sessionId: string) =>
    call<{ runId: string }>(`/api/projects/${projectId}/conversations/${sessionId}/commit`, {
      method: "POST",
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

  /**
   * What is still uncommitted, in the scope a commit would take. Cheap: no
   * patch, no log, so the always-visible rail can poll it on the app's beat.
   */
  gitPending: (projectId: string) => call<GitPending>(`/api/projects/${projectId}/git/pending`),
}
