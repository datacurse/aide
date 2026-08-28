import { useCallback, useEffect, useState } from "react"
import type { BoardRow } from "@aide/protocol"
import { api, type BoardView, type GitPending, type Health, type ProjectView } from "./api.js"
import { CHIME_KEY } from "./chime.js"
import { DaemonBar } from "./Daemon.js"
import { carryDraft, draftKey, openNewChat, readDraft, saveDraft } from "./drafts.js"
import { PANES, useAppLocation } from "./useAppLocation.js"
import { useRemembered } from "./useRemembered.js"
import { BoardList, BoardSummary, SpecPane } from "./panes/Board.js"
import { ConversationList, ConversationPane } from "./panes/Conversations.js"
import { GitList, GitPane, PendingRail } from "./panes/Git.js"
import { Button, Empty, PaneHeader } from "./ui.js"

/** While anything is in flight the lists need to move on their own. */
const POLL_MS = 1500

export function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [projects, setProjects] = useState<ProjectView[]>([])
  const [board, setBoard] = useState<BoardView>({ rows: [], spec: "", warnings: [] })
  const [error, setError] = useState<string | null>(null)
  /**
   * What the project has left to commit.
   *
   * Polled here rather than inside the rail, because two things read it: the
   * rail that shows it and the composer that refuses to start a new chat while
   * it is non-empty. Two pollers would let those two disagree for a second at a
   * time, which is exactly long enough to look like a bug.
   */
  const [pending, setPending] = useState<GitPending | null>(null)
  const [pendingError, setPendingError] = useState<string | null>(null)
  /**
   * Which project, which list, which conversation — all of it in the
   * URL, so a reload lands you back where you were and Back steps through what
   * you had open. See useAppLocation.
   */
  const [{ projectId, pane: mode, sessionId, sha }, navigate] = useAppLocation()
  /** Bumped to refetch the conversation list — a new chat has no id until it starts. */
  const [conversationsSeq, setConversationsSeq] = useState(0)
  /**
   * The board row a new chat was being started from.
   *
   * State rather than a ref because the composer renders from it — a chat opened
   * from a row is tracked by definition — and it is sent with the first message,
   * because the row is paired with the session the moment the SDK names it.
   */
  const [pendingRow, setPendingRow] = useState<string | null>(null)
  /**
   * Whether a finished run makes a sound. Remembered rather than a session
   * toggle: a chime you have to silence again after every reload is worse than
   * no chime, because you stop trusting the reload.
   */
  const [chiming, setChiming] = useRemembered<boolean>(
    CHIME_KEY,
    true,
    (v): v is boolean => typeof v === "boolean",
  )

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
      // Only while the board is on screen. It reads two files off disk per poll
      // and no other pane has any use for the result.
      if (projectId && mode === "board") setBoard(await api.board(projectId))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    // Its own try: the git rail is beside every pane, so a repo that has moved
    // out from under us must not take the projects list down with it — and a
    // failure here must not read as "nothing uncommitted", which would offer a
    // new chat the daemon is about to refuse.
    if (!projectId) {
      setPending(null)
      setPendingError(null)
      return
    }
    try {
      setPending(await api.gitPending(projectId))
      setPendingError(null)
    } catch (err) {
      setPendingError(err instanceof Error ? err.message : String(err))
    }
  }, [projectId, mode])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  // Dropped the instant the project changes, not when the next poll answers.
  // Holding the old one for a beat would put another repository's uncommitted
  // files under this project's name, which is the one thing a rail that gates
  // your next action must never do.
  useEffect(() => {
    setPending(null)
    setPendingError(null)
  }, [projectId])

  const project = projects.find((p) => p.id === projectId) ?? null
  const uncommitted = pending?.files.length ?? 0

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

  const reloadBoard = async () => {
    if (projectId) setBoard(await api.board(projectId))
  }

  /**
   * Clicking a row.
   *
   * A row already being worked opens its conversation. A row that is still just
   * an idea FILLS the message box and stops — you press send yourself, after
   * pasting a screenshot or adding the sentence that makes it a real request.
   * Sending on click would turn a mis-click into a running agent.
   */
  const openRow = (row: BoardRow) => {
    if (!projectId) return
    if (row.sessionId) {
      navigate({ pane: "chats", sessionId: row.sessionId })
      return
    }
    // Same gate as "new", because this is the same act. Reported rather than
    // silently ignored: a row that does nothing when clicked is indistinguishable
    // from a broken one.
    if (uncommitted > 0) {
      setError(
        `${uncommitted} uncommitted file${uncommitted === 1 ? "" : "s"} in this project. Commit that work before starting another chat.`,
      )
      return
    }
    const key = draftKey(projectId, null)
    openNewChat(projectId)
    // Never overwrite something already typed. The new-chat box is shared, and
    // eating a half-written message to insert a todo is a bad trade.
    const held = readDraft(key)
    if (!held.text && held.attachments.length === 0) {
      saveDraft(key, { text: row.text, attachments: [] })
    }
    setPendingRow(row.id)
    navigate({ pane: "chats", sessionId: null })
    setConversationsSeq((n) => n + 1)
  }

  const addRow = async (text: string) => {
    if (!projectId) return
    try {
      await api.addTodo(projectId, text)
      await reloadBoard()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const deleteRow = async (row: BoardRow) => {
    if (!projectId) return
    // Only when a conversation is attached: removing an idea nobody has started
    // is not worth a dialog, but removing the row a running agent is working is
    // a different thing and reads as a mis-click.
    if (row.sessionId && !window.confirm(`Remove "${row.text}"? A chat is working it.`)) return
    try {
      await api.deleteTodo(projectId, row.id)
      await reloadBoard()
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
        <div className="flex shrink-0 items-center gap-3">
          <button
            type="button"
            onClick={() => setChiming(!chiming)}
            title={
              chiming
                ? "A finished run rings. Click to silence."
                : "Finished runs are silent. Click to hear them."
            }
            className={`text-[11px] underline-offset-2 hover:underline ${
              chiming ? "text-fg-muted" : "text-fg-dim line-through"
            }`}
          >
            chime
          </button>
          <DaemonBar health={health} onChanged={() => void refresh()} />
        </div>
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
                      p.holder ? "bg-info animate-pulse" : "bg-fg-dim"
                    }`}
                  />
                  <span className="flex-1 truncate">{p.name}</span>
                  {/* Which conversation has the repo, not how many do — one
                      project runs one agent, so a count would be a boolean
                      wearing a number's clothes. The name is what you need
                      when you are wondering what is in your way. */}
                  {p.holder && (
                    <span
                      className="max-w-[8rem] truncate text-[10px] text-info"
                      title={`"${p.holder.title}" has this checkout`}
                    >
                      {p.holder.title}
                    </span>
                  )}
                </button>
              ))
            )}
          </div>
        </aside>

        {/* Tasks, conversations, history */}
        {/* Wider for git: the history column carries a graph, and a lane costs
            real width — squeezing it into the task list's 20rem leaves nothing
            for the subject, which is the part anyone actually reads. */}
        <aside
          className={`flex shrink-0 flex-col border-r border-line bg-chrome ${
            mode === "git" ? "w-96" : "w-80"
          }`}
        >
          <PaneHeader title={mode}>
            {mode === "board" && <BoardSummary rows={board.rows} />}
            <div className="mr-1 flex overflow-hidden rounded border border-line">
              {PANES.map((m) => (
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
            {/* Only the chat list has something to create. The git pane reads
                the repo, and the board has its own one-line input. */}
            {mode === "chats" && (
              <Button
                // Held back by uncommitted work, for the same reason the daemon
                // refuses the message: a conversation opened on top of somebody
                // else's edits takes them as its own baseline. Disabled rather
                // than hidden — a button that vanishes teaches you nothing.
                disabled={!project || uncommitted > 0}
                onClick={() => {
                  // Idempotent on purpose: a second press is you looking for the
                  // chat you already started, not asking for another one.
                  if (project) openNewChat(project.id)
                  setPendingRow(null)
                  navigate({ sessionId: null })
                }}
                title={
                  uncommitted > 0
                    ? `${uncommitted} uncommitted file${uncommitted === 1 ? "" : "s"} — commit this work before starting another chat.`
                    : "Start a new conversation. Pressing this again opens the one you already started."
                }
              >
                new
              </Button>
            )}
          </PaneHeader>


          {mode === "board" ? (
            <BoardList
              projectId={projectId}
              rows={board.rows}
              warnings={board.warnings}
              onOpen={openRow}
              onAdd={(text) => void addRow(text)}
              onDelete={(row) => void deleteRow(row)}
            />
          ) : mode === "git" ? (
            <GitList
              projectId={projectId}
              selected={sha}
              onSelect={(next) => navigate({ sha: next })}
            />
          ) : (
            <ConversationList
              key={conversationsSeq}
              projectId={projectId}
              selected={sessionId}
              // Picking an existing conversation abandons the row that was
              // queued up for a new one; without this it would attach itself to
              // whatever new chat is started next.
              onSelect={(id) => {
                setPendingRow(null)
                navigate({ sessionId: id })
              }}
            />
          )}
        </aside>

        {mode === "board" ? (
          <SpecPane spec={board.spec} />
        ) : mode === "git" ? (
          <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-editor">
            <PaneHeader title={sha ? `commit ${sha.slice(0, 7)}` : "working tree"} />
            <GitPane projectId={projectId} sha={sha} />
          </section>
        ) : (
          <ConversationPane
            projectId={projectId}
            openSessionId={sessionId}
            pendingTodoId={pendingRow}
            uncommitted={uncommitted}
            // A verdict rewrites todos.md and unlinks the row, so both lists are
            // stale the moment it lands.
            onChanged={() => {
              setConversationsSeq((n) => n + 1)
              void reloadBoard()
            }}
            // A new chat has no id until its first turn starts. Put it in the
            // URL the moment it exists, so a reload mid-first-turn still lands
            // on the conversation rather than on a blank new one — and refetch
            // the list so the row appears.
            onStarted={(id) => {
              // The draft row is this conversation, so it does not linger next
              // to the real one the list is about to grow — anything still
              // unsent in its box moves across with it.
              if (projectId) carryDraft(draftKey(projectId, null), draftKey(projectId, id))
              // The daemon records the row-to-session link itself, as part of
              // the send that already had to know the row to pick a working
              // directory. Nothing to do here but stop offering it to the next
              // new chat.
              setPendingRow(null)
              navigate({ sessionId: id })
              setConversationsSeq((n) => n + 1)
            }}
          />
        )}

        {/* Always on screen, whichever pane is showing. It is not a view of the
            repository — the git pane is that — it is the answer to "can I start
            the next thing", which has to be visible before you try. */}
        <PendingRail projectId={projectId} pending={pending} error={pendingError} />
      </main>
    </div>
  )
}
