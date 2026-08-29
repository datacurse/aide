import { useCallback, useEffect, useState } from "react"
import { api, type GitPending, type Health, type ProjectView } from "./api.js"
import { CHIME_KEY } from "./chime.js"
import { DaemonBar } from "./Daemon.js"
import { carryDraft, draftKey, openNewChat } from "./drafts.js"
import { useAppLocation } from "./useAppLocation.js"
import { useRemembered } from "./useRemembered.js"
import { ConversationList, ConversationPane } from "./panes/Conversations.js"
import { PendingRail } from "./panes/Pending.js"
import { Button, Empty, PaneHeader } from "./ui.js"

/** While anything is in flight the lists need to move on their own. */
const POLL_MS = 1500

export function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [projects, setProjects] = useState<ProjectView[]>([])
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
   * Which project and which chat — in the URL, so a reload lands you back where
   * you were and Back steps through what you had open. A chat is either a
   * session the daemon knows or one that has not been sent; see useAppLocation.
   */
  const [{ projectId, sessionId, draftId }, navigate] = useAppLocation()
  /**
   * Bumped to refetch the conversation list — a new chat has no id until it starts.
   *
   * A prop, not a `key`. As a key it remounted the list on every tick, which
   * threw away the scroller: ticking a chat off halfway down the list sent you
   * back to the top, and a half-typed line in the capture box vanished with it.
   */
  const [conversationsSeq, setConversationsSeq] = useState(0)
  /**
   * The commit in flight, and the run it is happening in.
   *
   * Held here rather than in the rail that starts it or the pane that shows it,
   * because it is the one thing both need: the rail presses the button, and the
   * conversation is where the run has to appear. `starting` covers the half
   * second before the daemon has answered, in which the projects list still
   * reports the repo as free and the button would otherwise invite a second
   * press.
   */
  const [commitRunId, setCommitRunId] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
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
    // loses about half the time — and losing pinned the status to "daemon
    // offline" for the life of the page even while every other request worked.
    try {
      setHealth(await api.health())
    } catch {
      setHealth(null)
    }
    try {
      setProjects(await api.projects())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    // Its own try: the uncommitted rail is beside every pane, so a repo that
    // has moved out from under us must not take the projects list down with it
    // — and a failure here must not read as "nothing uncommitted", which would
    // offer a new chat the daemon is about to refuse.
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
  }, [projectId])

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

  // A run id belongs to the conversation it was started from. Carrying it across
  // a move would replay one chat's commit under another chat's transcript.
  useEffect(() => {
    setCommitRunId(null)
  }, [projectId, sessionId])

  const project = projects.find((p) => p.id === projectId) ?? null
  const uncommitted = pending?.files.length ?? 0

  /**
   * Whether the commit we started is the thing currently holding the repo.
   *
   * Derived from the lock the daemon already publishes rather than from a flag
   * set on press: the run outlives the request that started it, so a local
   * "committing" would clear while the drafting was still going.
   */
  const committing = starting || (commitRunId !== null && project?.holder?.runId === commitRunId)
  const commitBlocked = !sessionId
    ? "Open the conversation that made these changes. A commit is measured against the checkpoint that conversation started from, so there is nothing to measure without one."
    : project?.holder && project.holder.runId !== commitRunId
      ? `"${project.holder.title}" has the repo right now.`
      : null

  /**
   * Commit what the open conversation changed.
   *
   * Returns as soon as the daemon has a run id — the work itself takes a model
   * call and lands in the transcript. The refresh is not a nicety: until the
   * projects list reports the commit as holding the repo, `committing` above is
   * false and the button reads as pressable over a commit already running.
   */
  const commitWork = async () => {
    if (!projectId || !sessionId) return
    setStarting(true)
    setError(null)
    try {
      const { runId } = await api.commitChat(projectId, sessionId)
      setCommitRunId(runId)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setStarting(false)
    }
  }

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

  return (
    // No title bar. Nothing up there was worth a row of height across the whole
    // window — the app's name is in the tab, and the daemon controls are a
    // footnote that lives in the foot of the projects rail. The panes get the
    // screen.
    <main className="flex h-full bg-editor font-mono text-fg antialiased">
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
                  p.id === projectId ? "bg-active text-white" : "text-fg-muted hover:bg-hover"
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

        {/* Below the projects rather than above every pane: this is where you
            look when something is not answering, and it is the only thing on
            screen that is about aide itself rather than about the work. */}
        <div className="shrink-0 border-t border-line px-3 py-2 font-sans">
          {/* Cleared by the next successful poll, so it is a flash rather
              than something to dismiss — wrapped, because the sentence
              explaining why a chat was refused is the whole point of it. */}
          {error && (
            <p className="mb-2 text-[11px] leading-relaxed break-words text-err">{error}</p>
          )}
          <DaemonBar health={health} onChanged={() => void refresh()}>
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
          </DaemonBar>
        </div>
      </aside>

      {/* Chats — the only list. A chat you have written and not sent is the
          backlog, a chat that is running is the work, and a chat you have ticked
          off is the record. There is no second surface, because a row on one and
          a conversation on the other were always the same thing twice. */}
      <aside className="flex w-80 shrink-0 flex-col border-r border-line bg-chrome">
        <PaneHeader title="chats">
          <Button
            // Held back by uncommitted work, for the same reason the daemon
            // refuses the message: a conversation opened on top of somebody
            // else's edits takes them as its own baseline. Disabled rather
            // than hidden — a button that vanishes teaches you nothing.
            disabled={!project || uncommitted > 0}
            onClick={() => {
              if (!project) return
              navigate({ draftId: openNewChat(project.id) })
            }}
            title={
              uncommitted > 0
                ? `${uncommitted} uncommitted file${uncommitted === 1 ? "" : "s"} — commit this work before starting another chat.`
                : "An empty chat, opened here. Discard one you did not want with the ✕ on its row."
            }
          >
            new
          </Button>
        </PaneHeader>

        <ConversationList
          reloadSeq={conversationsSeq}
          projectId={projectId}
          selected={sessionId}
          selectedDraft={draftId}
          onSelect={(id) => navigate({ sessionId: id })}
          onSelectDraft={(id) => navigate({ draftId: id })}
          onChanged={() => setConversationsSeq((n) => n + 1)}
        />
      </aside>

      <ConversationPane
        projectId={projectId}
        openSessionId={sessionId}
        draftId={draftId}
        uncommitted={uncommitted}
        adoptRunId={commitRunId}
        onChanged={() => setConversationsSeq((n) => n + 1)}
        // A new chat has no id until its first turn starts. Put it in the
        // URL the moment it exists, so a reload mid-first-turn still lands
        // on the conversation rather than on a blank new one — and refetch
        // the list so the row appears.
        onStarted={(id) => {
          // The unstarted record IS this conversation, so it does not linger
          // next to the real one the list is about to grow — anything still
          // unsent in its box moves across with it.
          if (projectId && draftId) carryDraft(draftKey(projectId, draftId), draftKey(projectId, id))
          navigate({ sessionId: id })
          setConversationsSeq((n) => n + 1)
        }}
      />

      {/* Always on screen. Not a view of the repository — reading a change
          belongs to the conversation that made it — but the answer to "can I
          start the next thing", which has to be visible before you try, and the
          button that makes the answer yes. */}
      <PendingRail
        projectId={projectId}
        pending={pending}
        error={pendingError}
        commitBlocked={commitBlocked}
        committing={committing}
        onCommit={() => void commitWork()}
      />
    </main>
  )
}
