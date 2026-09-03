import { useCallback, useEffect, useRef, useState } from "react"
import { api, type GitPending, type Health, type ProjectView } from "./api.js"
import { CHIME_KEY } from "./chime.js"
import { DaemonBar } from "./Daemon.js"
import { Dashboard } from "./Dashboard.js"
import { carryDraft, draftKey, openNewChat } from "./drafts.js"
import { useAppLocation } from "./useAppLocation.js"
import { useKeyed } from "./useKeyed.js"
import { useRemembered } from "./useRemembered.js"
import { ConversationList, ConversationPane } from "./panes/Conversations.js"
import { PendingRail } from "./panes/Pending.js"
import { RemotePicker } from "./RemotePicker.js"
import { Button, Empty, heldBy, PaneHeader, SELECTED } from "./ui.js"

/** While anything is in flight the lists need to move on their own. */
const POLL_MS = 1500

export function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [projects, setProjects] = useState<ProjectView[]>([])
  const [error, setError] = useState<string | null>(null)
  /**
   * Which project and which chat — in the URL, so a reload lands you back where
   * you were and Back steps through what you had open. A chat is either a
   * session the daemon knows or one that has not been sent; see useAppLocation.
   */
  const [{ activity, projectId, sessionId, draftId }, navigate] = useAppLocation()
  /**
   * What the project has left to commit.
   *
   * Polled here rather than inside the rail, because two things read it: the
   * rail that shows it and the composer that refuses to start a new chat while
   * it is non-empty. Two pollers would let those two disagree for a second at a
   * time, which is exactly long enough to look like a bug.
   *
   * Held per project rather than blanked on the way out — see `useKeyed`. This
   * is the pane where the blanking cost more than a flicker: `uncommitted`
   * reads 0 while the list is empty, so every switch took the block off the new
   * chat button for as long as a `git status`, and a chat started in that window
   * is one the daemon then refuses.
   */
  const [pending, rememberPending] = useKeyed<GitPending>(projectId)
  const [pendingError, rememberPendingError] = useKeyed<string>(projectId)
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
   * The last commit stopped on a failed check, so the next press may override it.
   *
   * Reported up by the conversation pane, which is where the run's events are.
   * Not remembered anywhere durable: an override has to be answered while you
   * are still looking at what failed, and one that survived a reload would be a
   * commit-anyway armed for a reason nobody on screen can see.
   */
  const [verifyRefused, setVerifyRefused] = useState(false)
  /**
   * A parked chat that has had its ▶ pressed and has not gone out yet.
   *
   * One press has to do two things that live in different components — open the
   * chat, which is a navigation, and send it, which only the composer can do
   * because only it knows the mode, the effort and whether the model may think.
   * This is the half-beat between
   * them, and the composer clears it the moment it has acted.
   */
  const [autoSend, setAutoSend] = useState<string | null>(null)
  /**
   * Whether a folder dialog is open on the desktop.
   *
   * Worth a state of its own because the window can be behind the browser: with
   * nothing on screen changing, the only reading of a dead `add` button is that
   * the press did not land, and the second press then waits on the same dialog
   * for no reason.
   */
  const [picking, setPicking] = useState(false)
  /** Whether the ssh machine picker is open. See `RemotePicker`. */
  const [remote, setRemote] = useState(false)
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
    if (!projectId) return
    try {
      // Filed under the project it was asked about, never under whatever is open
      // when it answers: a `git status` on a large repo outlives the switch away
      // from it, and the rail that decides what you may do next is the last place
      // another project's files may appear.
      rememberPending(projectId, await api.gitPending(projectId))
      rememberPendingError(projectId, null)
    } catch (err) {
      rememberPendingError(projectId, err instanceof Error ? err.message : String(err))
    }
  }, [projectId, rememberPending, rememberPendingError])

  /**
   * A tick is skipped while the previous one is still in flight.
   *
   * `setInterval` fires on the clock whether or not the last beat answered, and
   * against a REMOTE project a beat does not: `gitPending` is one ssh round trip
   * at about 1.75s on a 1500ms interval, so every beat started before the one
   * before it finished and the overlap grew without bound. Each of those is a
   * fresh ssh process — Windows OpenSSH cannot multiplex — so what it grows into
   * is dozens of concurrent connections against a host whose sshd refuses them
   * past `MaxStartups` (10, on the machine this was found on) and a Windows
   * spawn table that answers `ENOMEM` before that. Measured: 12 at once already
   * loses one to `kex_exchange_identification`, 30 loses two thirds.
   *
   * The visible symptom was a commit dying on `did not answer \`git diff\`
   * within 90s` while the rail beside it, polling happily, showed the same repo
   * as perfectly reachable — the commit's connections were the ones being
   * dropped.
   *
   * A skipped beat costs nothing: the next one reads the same state, and it is
   * strictly better to be one beat behind than to be the reason the answer never
   * arrives.
   */
  const inFlight = useRef(false)
  useEffect(() => {
    const beat = async () => {
      if (inFlight.current) return
      inFlight.current = true
      try {
        await refresh()
      } finally {
        inFlight.current = false
      }
    }
    void beat()
    const timer = setInterval(() => void beat(), POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  // A run id belongs to the conversation it was started from. Carrying it across
  // a move would replay one chat's commit under another chat's transcript.
  useEffect(() => {
    setCommitRunId(null)
  }, [projectId, sessionId])

  const project = projects.find((p) => p.id === projectId) ?? null
  const uncommitted = pending?.files.length ?? 0

  /**
   * A run let go of the checkout, so ask the chat list what it says now.
   *
   * The list is fetched on arrival and on things you did, never on the beat:
   * answering it means reading the SDK's session store and every run log, which
   * is not a thing to do twice a second to redraw thirty rows that did not move.
   * But a row's figures — its minutes, its dollars, its share — are written by
   * the end of a turn, and the end of a turn is exactly this transition. So one
   * refetch here buys what a poll would have, at one request per run instead of
   * forty a minute. The badge is not what this is for; that reads the lock
   * directly and is already live.
   */
  const holderRunId = project?.holder?.runId ?? null
  const heldLast = useRef<{ projectId: string | null; runId: string | null }>({
    projectId: null,
    runId: null,
  })
  useEffect(() => {
    const was = heldLast.current
    heldLast.current = { projectId, runId: holderRunId }
    // Within one project only. Switching projects drops the holder to null with
    // nothing having finished, and the list refetches on a switch anyway.
    if (was.projectId === projectId && was.runId !== null && holderRunId === null) {
      setConversationsSeq((n) => n + 1)
    }
  }, [projectId, holderRunId])

  /**
   * Why this project cannot take another turn right now, or null. Both halves
   * are the daemon's own rules, stated before the press rather than after it.
   *
   * The holder half is not the uncommitted half arriving early — it is the one
   * thing the uncommitted half can never say in time. A run writes files nobody
   * can anticipate, and the rail only learns of them a poll after they land, so
   * a chat admitted beside a run in flight took a tree that was being written
   * under it as its baseline; the block then appeared, describing damage already
   * done. Waiting for files to show up is waiting for the wrong event.
   *
   * It also has to come FIRST. A held checkout is very nearly always a dirty one
   * too, and "commit that work" is an instruction you cannot follow while a run
   * has the repo — the commit button is locked by the same holder.
   */
  const projectHeld = project?.holder
    ? heldBy(project.holder.title)
    : uncommitted > 0
      ? `${uncommitted} uncommitted file${uncommitted === 1 ? "" : "s"} — commit that work before starting another chat.`
      : null

  /**
   * Why pressing ▶ on a parked chat would be refused right now, or null.
   *
   * Stated BEFORE the press rather than after it, unlike the composer's own
   * refusal, because sending clears the box: a ▶ that fails would take the
   * parked idea with it and leave a red line where the work used to be.
   */
  const startBlocked = projectHeld

  /**
   * Whether the commit we started is the thing currently holding the repo.
   *
   * Derived from the lock the daemon already publishes rather than from a flag
   * set on press: the run outlives the request that started it, so a local
   * "committing" would clear while the drafting was still going.
   */
  const committing = starting || (commitRunId !== null && project?.holder?.runId === commitRunId)
  /**
   * Why the commit button cannot be pressed, or null.
   *
   * One reason left, and it is a wait rather than a refusal. There used to be a
   * second — "open the conversation that made these changes" — from back when a
   * commit was measured against a chat's checkpoint. Nothing makes the changes
   * in the rail belong to a chat, so that was a dead button over work your own
   * editor had made, in a project the same work was blocking every new chat in.
   */
  const commitBlocked =
    project?.holder && project.holder.runId !== commitRunId ? heldBy(project.holder.title) : null

  /**
   * Commit everything uncommitted in this project.
   *
   * The open chat is passed for attribution only — the trailer, and the
   * transcript the run streams into. There need not be one: what gets committed
   * is the rail's own list either way, which is what makes the rail's list
   * something you can always clear.
   *
   * Returns as soon as the daemon has a run id — the work itself takes a model
   * call and lands in the transcript. The refresh is not a nicety: until the
   * projects list reports the commit as holding the repo, `committing` above is
   * false and the button reads as pressable over a commit already running.
   */
  const commitWork = async (push: boolean) => {
    if (!projectId) return
    setStarting(true)
    setError(null)
    try {
      // The override is spent on the press that uses it. Clearing it here rather
      // than waiting for the new run's events means a second failure has to
      // arm it again — otherwise one refusal would leave every later commit in
      // this project forced, silently.
      const force = verifyRefused
      setVerifyRefused(false)
      const { runId } = await api.commitProject(projectId, sessionId, force, push)
      setCommitRunId(runId)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setStarting(false)
    }
  }

  /**
   * Push, on its own, with no run behind it.
   *
   * Synchronous from the browser's point of view — one git call, no model — so
   * unlike a commit there is no run id to follow and the refresh at the end is
   * the whole of the feedback: the rail's `ahead` drops and the button goes.
   */
  const [pushing, setPushing] = useState(false)
  const pushWork = async () => {
    if (!projectId) return
    setPushing(true)
    setError(null)
    try {
      await api.pushProject(projectId)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPushing(false)
    }
  }

  /**
   * A chat's first turn has named its session, so the unsent record that was
   * standing in for it becomes that conversation.
   *
   * Two things reach here, and the second is why this is not just the pane's
   * `onStarted` any more. The pane calls it from the live stream, for a turn you
   * stayed to watch. The chat list calls it from the daemon, for one you did not
   * — the name lands a second or two after the turn starts, and before this the
   * pane was the only thing listening, so leaving in those two seconds stranded
   * the record: it kept its "not sent yet" row beside the conversation it had
   * become, and the project's remembered chat went on pointing at it, so coming
   * back to the project opened an empty box.
   *
   * The pane follows only when the chat that started is the one on screen.
   * Healing a row four places down the list must not take you out of what you
   * are reading.
   */
  const chatStarted = useCallback(
    (fromDraftId: string | null, id: string) => {
      // The unstarted record IS this conversation, so it does not linger next to
      // the real one the list is about to grow — anything still unsent in its
      // box moves across with it.
      if (projectId && fromDraftId) {
        carryDraft(draftKey(projectId, fromDraftId), draftKey(projectId, id))
      }
      if (fromDraftId === null || fromDraftId === draftId) navigate({ sessionId: id })
      setConversationsSeq((n) => n + 1)
    },
    [projectId, draftId, navigate],
  )

  /**
   * Add a project by pointing at it.
   *
   * The dialog is the daemon's, because a page cannot learn where a folder is on
   * disk — deliberately, and there is no way around it; see `daemon/picker.ts`.
   * Typing a path is still here, but only for a machine that has no dialog to
   * open, and the reason it could not open one is put in front of the box rather
   * than swallowed.
   */
  const addProject = async () => {
    setError(null)
    setPicking(true)
    let path: string | null
    try {
      const picked = await api.browseForFolder()
      // Cancelled. Not an error, and not a reason to ask for the path in text
      // instead — being made to type one after saying no is the worst of both.
      if (!picked.path && !picked.unavailable) return
      path =
        picked.path ?? window.prompt(`${picked.unavailable}\n\nAbsolute path to a git repository`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return
    } finally {
      setPicking(false)
    }

    if (!path?.trim()) return
    try {
      const added = await api.addProject(path.trim())
      navigate({ projectId: added.id })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  // The dashboard takes the window. It REPLACES the panes rather than covering
  // them, because the four panes poll — `refresh` above runs on a 1.5s beat and
  // a remote `gitPending` is an ssh connection — and leaving them mounted behind
  // a full-screen page would spend a connection every beat and a half on a rail
  // nobody can see. The polling stops with them; `projectId` and the open chat
  // stay in the URL, so closing puts you back exactly where you were.
  //
  // Nothing in flight is lost by this: a run belongs to the daemon, not to the
  // page, which is the property the whole app is built on.
  if (activity) {
    return (
      <Dashboard
        onClose={() => navigate({ activity: false })}
        onOpenProject={(id) => navigate({ activity: false, projectId: id })}
      />
    )
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
          {/* No `title` while picking. A disabled button takes no pointer
              events, so its tooltip never opens — which meant the one sentence
              telling you the dialog is a separate window was as hard to find as
              the window. It is in the rail's foot instead, where it can be read. */}
          <Button onClick={addProject} disabled={picking}>
            {picking ? "choosing…" : "add"}
          </Button>
          {/* Separate from `add` rather than a mode of it. The local one opens
              the machine's own dialog and this one cannot — there is no window
              on the far side of an ssh connection — so they are two different
              acts wearing one word only if you hide the difference. */}
          <Button onClick={() => setRemote(true)} title="Add a project from another machine">
            ssh
          </Button>
          {/* On the PROJECTS header because that is what it is about — every
              project at once, which is the one question none of the four panes
              can answer. It needs no project selected and takes none. */}
          <Button
            onClick={() => navigate({ activity: true })}
            title="Activity across every project — where the time and the money went"
          >
            stats
          </Button>
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
                // Every row, so the answer is a hover away without opening the
                // project. The line below is for the one you are working in.
                title={p.root}
                // The same frame the chat list draws, because two lists side by
                // side that disagree about what "selected" looks like read as
                // one of them being broken. It also gets the same thing out of
                // the way here: the holder's name is `text-info`, and on a
                // filled navy row that was blue text on a blue plate.
                className={`flex w-full flex-col border px-3 py-[3px] text-left font-sans text-[13px] hover:bg-hover ${
                  p.id === projectId ? `${SELECTED} text-fg` : "border-transparent text-fg-muted"
                }`}
              >
                <span className="flex w-full items-center gap-2">
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
                </span>
                {/* Where the work happens, which is the project root and nothing
                    else — every run and every chat is in it, so it belongs to
                    the project rather than to a conversation. It used to be a
                    22px bar along the foot of the transcript, and for a chat
                    that had not run yet it could not even say the path: it read
                    "runs in the project root". A row of window height for one
                    line of text that is the same for every chat in a project is
                    the same trade the title bar lost.

                    Only under the selected row. On all of them the rail is a
                    list of paths you have to read past to find a name. */}
                {p.id === projectId && (
                  <span className="w-full truncate pl-[14px] text-[10px] text-fg-dim">{p.root}</span>
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
          {/* The folder dialog belongs to the daemon, not to the page, so
              nothing about it is visible from here — and while it is open the
              only thing on screen that changed is a button reading
              "choosing…". Saying where the window went beats leaving that to
              be worked out. */}
          {picking && (
            <p className="mb-2 text-[11px] leading-relaxed text-fg-dim">
              Choosing a folder. The dialog is a separate window — if you cannot see it, it is
              behind this one.
            </p>
          )}
          <DaemonBar health={health} onChanged={() => void refresh()}>
            <button
              type="button"
              onClick={() => setChiming(!chiming)}
              title={
                chiming
                  ? "A finished run rings every couple of seconds, and the tab title says so, until you come back. Click to silence."
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
            // The same sentence the ▶ on a parked row gets, because they are the
            // same refusal: the daemon turns away a chat opened on top of work
            // in flight or edits nobody has committed. Locked rather than
            // hidden, and locked rather than merely dimmed — what is in the way
            // is one pane over, and the padlock is what sends you to look at it.
            //
            // `disabled` stays for having no project, which is not a lock: there
            // is nothing holding it and nothing to go and clear.
            disabled={!project}
            locked={projectHeld}
            onClick={() => {
              if (!project) return
              navigate({ draftId: openNewChat(project.id) })
            }}
            title="An empty chat, opened here. Discard one you did not want with the ✕ on its row."
          >
            new
          </Button>
        </PaneHeader>

        <ConversationList
          reloadSeq={conversationsSeq}
          projectId={projectId}
          selected={sessionId}
          selectedDraft={draftId}
          // The rows are not polled; this is. See `withLock` in the list.
          holder={project?.holder ?? null}
          startBlocked={startBlocked}
          onSelect={(id) => navigate({ sessionId: id })}
          onSelectDraft={(id) => navigate({ draftId: id })}
          // Open it and send it, from the one press. The order matters only in
          // that both land in the same batch, so the composer's first render for
          // this chat is already the one that sends it.
          onStartDraft={(id) => {
            navigate({ draftId: id })
            setAutoSend(id)
          }}
          onDraftStarted={chatStarted}
          onChanged={() => setConversationsSeq((n) => n + 1)}
        />
      </aside>

      <ConversationPane
        projectId={projectId}
        openSessionId={sessionId}
        draftId={draftId}
        uncommitted={uncommitted}
        // Polled, unlike everything else the pane knows about other chats. The
        // box has to go dark the moment another chat takes the repo, not the
        // next time something asks for the list.
        holder={project?.holder ?? null}
        adoptRunId={commitRunId}
        // Gated on the open chat being the one that was pressed, so a ▶ that
        // somehow outlived its navigation cannot fire at whatever is open now.
        autoSend={autoSend !== null && autoSend === draftId}
        onAutoSent={() => setAutoSend(null)}
        onVerifyRefused={setVerifyRefused}
        onChanged={() => setConversationsSeq((n) => n + 1)}
        // A new chat has no id until its first turn starts. Put it in the
        // URL the moment it exists, so a reload mid-first-turn still lands
        // on the conversation rather than on a blank new one — and refetch
        // the list so the row appears. The chat that started is by definition
        // the one this pane is showing, so `chatStarted` always navigates here.
        onStarted={(id) => chatStarted(draftId, id)}
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
        verifyRefused={verifyRefused}
        onCommit={(push) => void commitWork(push)}
        onPush={() => void pushWork()}
        pushing={pushing}
        // The same lock as a commit, and for the same reason: pushing while an
        // agent writes would send a branch whose tip is about to move.
        pushBlocked={commitBlocked}
      />

      {remote && (
        <RemotePicker
          onCancel={() => setRemote(false)}
          onPick={async (host, path) => {
            setRemote(false)
            setError(null)
            try {
              const added = await api.addRemoteProject(host.alias, path)
              navigate({ projectId: added.id })
              await refresh()
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err))
            }
          }}
        />
      )}
    </main>
  )
}
