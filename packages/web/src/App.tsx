import { useCallback, useEffect, useState } from "react"
import { api, type Health, type ProjectView, type TaskView } from "./api.js"
import { DaemonBar } from "./Daemon.js"
import { useAppLocation } from "./useAppLocation.js"
import { ConversationList, ConversationPane } from "./panes/Conversations.js"
import { RunPane } from "./panes/Run.js"
import { Button, Empty, PaneHeader, StatusDot, STATUS_STYLE } from "./ui.js"

/** While anything is in flight the lists need to move on their own. */
const POLL_MS = 1500

export function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [projects, setProjects] = useState<ProjectView[]>([])
  const [tasks, setTasks] = useState<TaskView[]>([])
  const [error, setError] = useState<string | null>(null)
  const [composing, setComposing] = useState(false)
  /**
   * Which project, which list, which task or conversation — all of it in the
   * URL, so a reload lands you back where you were and Back steps through what
   * you had open. See useAppLocation.
   */
  const [{ projectId, pane: mode, taskId, sessionId }, navigate] = useAppLocation()
  /** Bumped to refetch the conversation list — a new chat has no id until it starts. */
  const [conversationsSeq, setConversationsSeq] = useState(0)
  const [draft, setDraft] = useState({ title: "", body: "" })

  const refresh = useCallback(async () => {
    // Health is polled with everything else rather than fetched once at mount.
    // The daemon takes a second or two to boot, so a single attempt races it and
    // loses about half the time — and losing pinned the header to "daemon
    // offline" for the life of the page even while every other request worked.
    try {
      setHealth(await api.health())
    } catch {
      setHealth(null)
    }
    try {
      const next = await api.projects()
      setProjects(next)
      if (projectId) setTasks(await api.tasks(projectId))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [projectId])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  const project = projects.find((p) => p.id === projectId) ?? null
  const task = tasks.find((t) => t.id === taskId) ?? null
  // Prefer the live run; fall back to the most recent one so a finished task
  // still shows its transcript.
  const runId = task?.activeRunId ?? task?.runs.at(-1) ?? null

  const addProject = async () => {
    const path = window.prompt("Absolute path to a git repository")
    if (!path?.trim()) return
    try {
      const added = await api.addProject(path.trim())
      navigate({ projectId: added.id })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const createTask = async () => {
    if (!projectId || !draft.title.trim()) return
    try {
      const created = await api.createTask(projectId, draft.title.trim(), draft.body.trim())
      setDraft({ title: "", body: "" })
      setComposing(false)
      navigate({ taskId: created.id })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="flex h-full flex-col bg-editor font-mono text-fg antialiased">
      <header className="flex h-9 shrink-0 items-center justify-between gap-4 border-b border-line bg-chrome px-4 font-sans">
        <div className="flex items-baseline gap-3">
          <span className="text-sm font-semibold tracking-tight text-fg">aide</span>
        </div>
        {error && <span className="min-w-0 flex-1 truncate text-[11px] text-err">{error}</span>}
        <DaemonBar health={health} onChanged={() => void refresh()} />
      </header>

      <main className="flex min-h-0 flex-1">
        {/* Projects */}
        <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-chrome">
          <PaneHeader title="projects">
            <Button onClick={addProject}>add</Button>
          </PaneHeader>
          <div className="flex-1 overflow-auto py-1">
            {projects.length === 0 ? (
              <Empty>No projects yet. Add a git repository to get started.</Empty>
            ) : (
              projects.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => navigate({ projectId: p.id })}
                  className={`flex w-full items-center gap-2 px-3 py-[3px] text-left font-sans text-[13px] ${
                    p.id === projectId
                      ? "bg-active text-white"
                      : "text-fg-muted hover:bg-hover"
                  }`}
                >
                  <span
                    className={`inline-block size-1.5 shrink-0 rounded-full ${
                      p.activeRuns > 0 ? "bg-info animate-pulse" : "bg-fg-dim"
                    }`}
                  />
                  <span className="flex-1 truncate">{p.name}</span>
                  {p.activeRuns > 0 && (
                    <span className="text-[10px] text-info">{p.activeRuns}</span>
                  )}
                </button>
              ))
            )}
          </div>
        </aside>

        {/* Tasks and conversations */}
        <aside className="flex w-80 shrink-0 flex-col border-r border-line bg-chrome">
          <PaneHeader title={mode}>
            <div className="mr-1 flex overflow-hidden rounded border border-line">
              {(["tasks", "chats"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => navigate({ pane: m })}
                  className={`px-2 py-0.5 text-xs ${
                    mode === m ? "bg-input text-fg" : "text-fg-muted hover:text-fg"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
            <Button
              disabled={!project}
              onClick={() =>
                mode === "tasks" ? setComposing((v) => !v) : navigate({ sessionId: null })
              }
              title={mode === "tasks" ? "New task" : "Start a new conversation"}
            >
              new
            </Button>
          </PaneHeader>

          {composing && project && (
            <div className="space-y-2 border-b border-line bg-editor p-3">
              <input
                autoFocus
                value={draft.title}
                onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                placeholder="Title"
                className="w-full rounded border border-line-soft bg-input px-2 py-1 font-sans text-xs outline-none placeholder:text-fg-dim focus:border-accent"
              />
              <textarea
                value={draft.body}
                onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
                placeholder="What should the agent do? This body is the prompt."
                rows={5}
                className="w-full resize-none rounded border border-line-soft bg-input px-2 py-1 font-sans text-xs leading-relaxed outline-none placeholder:text-fg-dim focus:border-accent"
              />
              <div className="flex justify-end gap-1.5">
                <Button onClick={() => setComposing(false)}>cancel</Button>
                <Button tone="primary" disabled={!draft.title.trim()} onClick={createTask}>
                  create
                </Button>
              </div>
            </div>
          )}

          {mode === "chats" ? (
            <ConversationList
              key={conversationsSeq}
              projectId={projectId}
              selected={sessionId}
              onSelect={(id) => navigate({ sessionId: id })}
            />
          ) : (
          <div className="flex-1 overflow-auto py-1">
            {!project ? (
              <Empty>Select a project.</Empty>
            ) : tasks.length === 0 ? (
              <Empty>No tasks yet. Create one and it lands in .aide/tasks/.</Empty>
            ) : (
              tasks.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => navigate({ taskId: t.id })}
                  className={`flex w-full items-center gap-2 px-3 py-[3px] text-left font-sans text-[13px] ${
                    t.id === taskId
                      ? "bg-active text-white"
                      : "text-fg-muted hover:bg-hover"
                  }`}
                >
                  <StatusDot status={t.status} />
                  <span className="w-8 shrink-0 text-fg-dim">{t.id}</span>
                  <span className="flex-1 truncate">{t.title}</span>
                  <span className={`shrink-0 text-[10px] ${STATUS_STYLE[t.status].text}`}>
                    {STATUS_STYLE[t.status].label}
                  </span>
                </button>
              ))
            )}
          </div>
          )}
        </aside>

        {mode === "chats" ? (
          <ConversationPane
            projectId={projectId}
            openSessionId={sessionId}
            // A new chat has no id until its first turn starts. Put it in the
            // URL the moment it exists, so a reload mid-first-turn still lands
            // on the conversation rather than on a blank new one — and refetch
            // the list so the row appears.
            onStarted={(id) => {
              navigate({ sessionId: id })
              setConversationsSeq((n) => n + 1)
            }}
          />
        ) : (
          <RunPane projectId={projectId} task={task} runId={runId} onChanged={() => void refresh()} />
        )}
      </main>
    </div>
  )
}
