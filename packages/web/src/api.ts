import type { Project, RunEvent, Task } from "@aide/protocol"

export type ProjectView = Project & { activeRuns: number }
export type TaskView = Task & { activeRunId: string | null }

export interface Health {
  ok: boolean
  taskModel: string
  maxConcurrentRuns: number
  maxBudgetUsd: number
}

export interface DiffView {
  worktree: string
  diff: string
  status: string
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

export const api = {
  health: () => call<Health>("/api/health"),

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
}
