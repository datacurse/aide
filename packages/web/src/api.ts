import type {
  Attachment,
  ChatMode,
  ConversationSummary,
  EffortLevel,
  GitCommitDetail,
  GitSummary,
  GitWorkingTree,
  Health,
  Project,
  RunEvent,
  Task,
} from "@aide/protocol"

export type { ConversationSummary, GitCommitDetail, GitSummary, GitWorkingTree, Health }

/** A conversation's replayed transcript. */
export interface ConversationView {
  summary: ConversationSummary
  events: RunEvent[]
  truncated: boolean
  totalMessages: number
}

export type ProjectView = Project & { activeRuns: number }
export type TaskView = Task & { activeRunId: string | null }

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

export interface DiffView {
  worktree: string
  diff: string
  status: string
}

export interface CommitDraft {
  message: string
  /** Which model wrote it, so the UI never has to guess. */
  model: string
}

export interface CommitResult {
  sha: string
  /** Path relative to the project root, or null if the entry could not be written. */
  journal: string | null
  /** Set when the commit succeeded but something after it did not. */
  warning: string | null
}

export interface LandResult {
  sha: string
  /** The branch the task was merged into. */
  into: string
  warning: string | null
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

  tasks: (projectId: string) => call<TaskView[]>(`/api/projects/${projectId}/tasks`),
  createTask: (projectId: string, title: string, body: string) =>
    call<Task>(`/api/projects/${projectId}/tasks`, {
      method: "POST",
      body: JSON.stringify({ title, body }),
    }),
  deleteTask: (projectId: string, taskId: string) =>
    call<void>(`/api/projects/${projectId}/tasks/${taskId}`, { method: "DELETE" }),

  runTask: (projectId: string, taskId: string) =>
    call<{ runId: string }>(`/api/projects/${projectId}/tasks/${taskId}/run`, { method: "POST" }),
  interrupt: (runId: string) =>
    call<{ interrupted: boolean }>(`/api/runs/${runId}/interrupt`, { method: "POST" }),

  events: (runId: string, fromSeq = 0) =>
    call<RunEvent[]>(`/api/runs/${runId}/events?fromSeq=${fromSeq}`),
  diff: (projectId: string, taskId: string) =>
    call<DiffView>(`/api/projects/${projectId}/tasks/${taskId}/diff`),

  conversations: (projectId: string) =>
    call<ConversationSummary[]>(`/api/projects/${projectId}/conversations`),
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
  draftCommit: (projectId: string, taskId: string) =>
    call<CommitDraft>(`/api/projects/${projectId}/tasks/${taskId}/commit/draft`, {
      method: "POST",
    }),
  commit: (projectId: string, taskId: string, message: string) =>
    call<CommitResult>(`/api/projects/${projectId}/tasks/${taskId}/commit`, {
      method: "POST",
      body: JSON.stringify({ message }),
    }),
  land: (projectId: string, taskId: string) =>
    call<LandResult>(`/api/projects/${projectId}/tasks/${taskId}/land`, { method: "POST" }),

  /** Branch, ahead/behind, dirt counts and the log — one poll's worth. */
  git: (projectId: string, limit: number) =>
    call<GitSummary>(`/api/projects/${projectId}/git?limit=${limit}`),
  /** Split out because it carries a whole patch, and is only read when shown. */
  gitWorking: (projectId: string) =>
    call<GitWorkingTree>(`/api/projects/${projectId}/git/working`),
  gitCommit: (projectId: string, sha: string) =>
    call<GitCommitDetail>(`/api/projects/${projectId}/git/commits/${sha}`),
}
