import { useCallback, useEffect, useRef, useState } from "react"
import { projectGates, visibleHolder, type BridgedChat } from "@aide/protocol"
import { api, type GitPending, type Health, type ProjectView } from "./api.js"
import { CHIME_KEY } from "./chime.js"
import { usePoll } from "./usePoll.js"
import { DaemonBar } from "./Daemon.js"
import { Dashboard } from "./Dashboard.js"
import { carryDraft, draftKey, draftSubject, openComposedChat, openNewChat, peekDraft } from "./drafts.js"
import { Hint } from "./Hint.js"
import { Lock, X } from "./icons.js"
import { draftName } from "./naming.js"
import { SettingsButton } from "./Settings.js"
import { SURVEY_PROMPT } from "./survey.js"
import { useAppLocation } from "./useAppLocation.js"
import { useKeyed } from "./useKeyed.js"
import { useRemembered } from "./useRemembered.js"
import { ConversationPane } from "./panes/Conversation.js"
import { ConversationList } from "./panes/Conversations.js"
import { PendingRail } from "./panes/Pending.js"
import { RemotePicker } from "./RemotePicker.js"
import { Scroller } from "./Scroller.js"
import { Button, Empty, heldBy, heldByCommit, LOCKED, PaneHeader, SELECTED } from "./ui.js"

/** While anything is in flight the lists need to move on their own. */
const POLL_MS = 1500

/**
 * How long a primed `forget` stays primed.
 *
 * Short enough that one left armed cannot catch a click made minutes later for
 * some other reason, long enough to read the name it is now offering to drop.
 */
const CONFIRM_MS = 4000

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
   * Chats that have just become conversations and are not in the fetched list
   * yet — see `BridgedChat`, which holds the argument.
   *
   * Here rather than in the list because both halves of the handoff land here:
   * the pane hears the name off the live stream, the list hears it from the
   * daemon, and `chatStarted` is where those two already meet. A copy in each
   * would be two answers to "is this chat drawn yet".
   *
   * Not per project, and it does not need to be: a note is retired the moment
   * the project's own list contains it, and the list only ever consults notes
   * against the rows it has. Switching away and back leaves at most one stale
   * entry, which the first fetch of that project drops.
   */
  const [bridged, setBridged] = useState<BridgedChat[]>([])
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

  // A beat is skipped while the previous one is still in flight — this poll is
  // where that rule was learned, against a remote `gitPending` that took longer
  // than its own interval. `usePoll` holds the measurements and the failure it
  // prevents; it lives there rather than here because `Pending.tsx` polls git
  // the same way and spent a while without the guard.
  usePoll(refresh, POLL_MS, [refresh])

  const project = projects.find((p) => p.id === projectId) ?? null

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
   * Why this project cannot take a chat, a send or a push right now.
   *
   * The rules themselves are in `projectGates`, in protocol, rather than here.
   * Two implementations of "is this project blocked" is the shape the brief has
   * been bitten by twice, both times as a gate nobody could clear, and `pnpm
   * smoke` asserts them there — which a component cannot be.
   *
   * Stated BEFORE the press rather than after it, which is what `start` is for:
   * sending clears the box, so a ▶ that failed would take the parked idea with it
   * and leave a red line where the work used to be.
   */
  const gates = projectGates({
    holder: project?.holder ?? null,
    held: heldBy,
  })
  const projectHeld = gates.start

  /**
   * Push, on its own, with no run behind it. The one git button left —
   * committing is automatic, once per turn, in the daemon.
   *
   * Synchronous from the browser's point of view — a couple of git calls, no
   * model — so there is no run id to follow and the refresh at the end is the
   * whole of the feedback: the rail's `ahead` drops and the button goes.
   */
  const [pushing, setPushing] = useState(false)
  const pushWork = async (squash: boolean) => {
    if (!projectId) return
    setPushing(true)
    setError(null)
    try {
      await api.pushProject(projectId, squash)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPushing(false)
    }
  }

  /**
   * Forget a project — the registry entry, and nothing on disk.
   *
   * The repository, its `.aide/` and every conversation stay exactly where they
   * are; this only drops aide's own list entry. It lives on the rail because the
   * rail IS that list, and it was the one thing `removeProject` had no way to be
   * reached from once the wall went.
   *
   * If the project being forgotten is the one open, the panes have to be sent
   * somewhere — they are scoped to a project id the registry no longer answers
   * for, and every one of them would poll it forever.
   */
  const forgetProject = async (id: string) => {
    setError(null)
    try {
      await api.removeProject(id)
      if (id === projectId) navigate({ projectId: null })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
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
      if (projectId && fromDraftId) {
        const key = draftKey(projectId, fromDraftId)
        // Read before the carry, which deletes it. What the row was called and
        // when it was parked are the two facts the list needs to keep drawing
        // this chat in the same place, with the same words, for the round trip
        // between the record going and the daemon's own row arriving.
        const was = peekDraft(key)
        // The unstarted record IS this conversation, so it does not linger next
        // to the real one the list is about to grow — anything still unsent in
        // its box moves across with it.
        carryDraft(key, draftKey(projectId, id))
        if (was) {
          const said = draftSubject(was).trim().split("\n", 1)[0] ?? ""
          setBridged((prev) => [
            // Keyed by session id, so a second handoff for the same conversation
            // — the pane's stream and the list's poll both answering — replaces
            // the note rather than standing two rows on it.
            ...prev.filter((b) => b.sessionId !== id),
            {
              sessionId: id,
              // The name it had, else the first line of what went out. The
              // fetched row will carry the SDK's own title a moment later; what
              // matters here is that the row does not go blank or change words
              // under the cursor in between.
              title: draftName(was) ?? said,
              createdAt: was.createdAt,
              lastModified: was.updatedAt,
            },
          ])
        }
      }
      if (fromDraftId === null || fromDraftId === draftId) navigate({ sessionId: id })
      setConversationsSeq((n) => n + 1)
    },
    [projectId, draftId, navigate],
  )

  /**
   * A stand-in has been overtaken by the daemon's own row.
   *
   * The list is the only thing that knows what the fetch answered with, so it
   * is the only thing that can say this. Retiring the note is not tidiness: one
   * kept after the real row lands draws the same chat twice, which is the bug
   * this whole mechanism exists to avoid, arriving from the other side.
   *
   * Stable, because the list calls it from an effect that depends on it.
   */
  const bridgeLanded = useCallback((sessionIds: readonly string[]) => {
    setBridged((prev) => {
      const next = prev.filter((b) => !sessionIds.includes(b.sessionId))
      // Same array when nothing was retired, or the effect that reports this
      // re-runs on its own output forever.
      return next.length === prev.length ? prev : next
    })
  }, [])

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
        <Scroller className="flex-1" contentClassName="py-1">
          {projects.length === 0 ? (
            <Empty>No projects yet. Add a git repository to get started.</Empty>
          ) : (
            projects.map((p) => {
              // What this row may SAY is running — which is not `p.holder`. An
              // auto-commit holds the checkout and is reported like any other
              // run, and a rail that pulses for it spends the one indicator
              // that means "an agent is working here" on background
              // bookkeeping. See `visibleHolder`.
              const shown = visibleHolder(p.holder)
              return (
                // A row, with the name as its own button and `forget` as a
                // second one beside it. NOT one button around both: a button
                // inside a button is markup a browser fixes by dropping the
                // inner one, so the ✕ would be silently unclickable rather
                // than visibly wrong.
                <div key={p.id} className="group relative flex items-center">
                  {/* Every row, so the answer is a hover away without opening the
                      project. The line below is for the one you are working in. */}
                  <Hint hint={p.root}>
                    <button
                      type="button"
                      onClick={() => navigate({ projectId: p.id })}
                      // The same frame the chat list draws, because two lists side
                      // by side that disagree about what "selected" looks like read
                      // as one of them being broken. It also gets the same thing out
                      // of the way here: the holder's name is `text-info`, and on a
                      // filled navy row that was blue text on a blue plate.
                      className={`flex w-full flex-col border py-[3px] pr-8 pl-3 text-left font-sans text-[13px] hover:bg-hover ${
                        p.id === projectId
                          ? `${SELECTED} text-fg`
                          : "border-transparent text-fg-muted"
                      }`}
                    >
                      <span className="flex w-full items-center gap-2">
                        <span
                          className={`inline-block size-1.5 shrink-0 rounded-full ${
                            shown ? "bg-info animate-pulse" : "bg-fg-dim"
                          }`}
                        />
                        <span className="flex-1 truncate">{p.name}</span>
                        {/* Which conversation has the repo, not how many do — one
                            project runs one agent, so a count would be a boolean
                            wearing a number's clothes. The name is what you need
                            when you are wondering what is in your way. */}
                        {shown && (
                          <Hint hint={`"${shown.title}" has this checkout`}>
                            <span className="max-w-[8rem] truncate text-[10px] text-info">
                              {shown.title}
                            </span>
                          </Hint>
                        )}
                      </span>
                      {/* Where the work happens, which is the project root and
                          nothing else — every run and every chat is in it, so it
                          belongs to the project rather than to a conversation. It
                          used to be a 22px bar along the foot of the transcript,
                          and for a chat that had not run yet it could not even say
                          the path: it read "runs in the project root". A row of
                          window height for one line of text that is the same for
                          every chat in a project is the same trade the title bar
                          lost.

                          Only under the selected row. On all of them the rail is a
                          list of paths you have to read past to find a name. */}
                      {p.id === projectId && (
                        <span className="w-full truncate pl-[14px] text-[10px] text-fg-dim">
                          {p.root}
                        </span>
                      )}
                    </button>
                  </Hint>
                  {/* Absolutely placed over the row's right edge, which the row's
                      own `pr-8` keeps clear. In the flex flow it would compete with
                      the name for width and shorten every title by 24px to make room
                      for something that is only visible on hover. */}
                  <div className="absolute top-1/2 right-1 -translate-y-1/2">
                    {/* Reads the REAL holder, not `shown`. The daemon refuses a
                        forget under any hold, a commit included — dropping the
                        registry entry does not stop the run, it orphans it — so
                        hiding the padlock here would leave a ✕ whose only outcome
                        is a red line. What changes is the wording: a commit is
                        not something to wait for or stop, and not worth naming. */}
                    <ForgetProject
                      name={p.name}
                      blocked={
                        p.holder ? (p.holder.held ? heldByCommit : heldBy(p.holder.title)) : null
                      }
                      onForget={() => void forgetProject(p.id)}
                    />
                  </div>
                </div>
              )
            })
          )}
        </Scroller>

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
            {/* What every chat starts on. Here rather than anywhere per-project,
                because the defaults are about aide itself — the same scope as
                the daemon controls it sits between. */}
            <SettingsButton />
            <Hint
              hint={
                chiming
                  ? "A finished run rings every couple of seconds, and the tab title says so, until you come back. Click to silence."
                  : "Finished runs are silent. Click to hear them."
              }
            >
              <button
                type="button"
                onClick={() => setChiming(!chiming)}
                className={`text-[11px] underline-offset-2 hover:underline ${
                  chiming ? "text-fg-muted" : "text-fg-dim line-through"
                }`}
              >
                chime
              </button>
            </Hint>
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
            // NOT locked while a run holds the checkout, and that is the point:
            // this creates a local record, the same act as parking words in the
            // capture box above — which has never been gated. The lock lands
            // where the first turn is SENT: the ▶ on a parked row and the
            // composer both go dark under a holder. Locking creation too made
            // the two ways of making a chat disagree, and the capture box was
            // right.
            //
            // `disabled` stays for having no project, which is not a lock: there
            // is nothing holding it and nothing to go and clear.
            disabled={!project}
            onClick={() => {
              if (!project) return
              navigate({ draftId: openNewChat(project.id) })
            }}
            title="An empty chat, opened here. Discard one you did not want with the ✕ on its row."
          >
            new
          </Button>
          {/*
            The one turn aide knows how to ask for.

            Beside `new` rather than in the rail on the right, because that is
            what it makes: a chat, in this list, which then behaves like every
            other one. The rail is about the working tree, and a button there
            would read as acting on your uncommitted changes — which this does
            not touch.

            It sends on the press. An earlier version put the prompt in the box
            unsent so you could read it first, and that is the ▶'s own mistake
            over again: if you pressed the button you already know what it asks,
            and a second press to confirm is a button that ignores you. The words
            are still editable — they are in the transcript and the next message
            is yours — and `survey.ts` is where they are changed for good.

            Locked under a holder where `new` is not, because they make
            different things: `new` parks a local record, this SENDS on the
            press. One agent has the checkout, and a survey is an agent.
          */}
          <Button
            disabled={!project}
            locked={projectHeld}
            onClick={() => {
              if (!project) return
              const id = openComposedChat(project.id, {
                text: SURVEY_PROMPT,
                // What the row is called, without a model call: aide wrote the
                // words, so nothing has to be asked what they are about.
                title: "Technical debt survey",
                // Plan, and not the mode you last used. It asks for a ranked
                // list and says not to write code yet; sending that at a mode
                // that acts is sending an instruction and its contradiction in
                // one message.
                mode: "plan",
              })
              navigate({ draftId: id })
              setAutoSend(id)
            }}
            title="Ask what this project's technical debt is, worst first — a plan, not a change. Runs as a chat you can steer."
          >
            survey
          </Button>
        </PaneHeader>

        <ConversationList
          reloadSeq={conversationsSeq}
          projectId={projectId}
          selected={sessionId}
          selectedDraft={draftId}
          // The rows are not polled; this is. See `withLock` in the list.
          holder={project?.holder ?? null}
          startBlocked={projectHeld}
          onSelect={(id) => navigate({ sessionId: id })}
          onSelectDraft={(id) => navigate({ draftId: id })}
          // Open it and send it, from the one press. The order matters only in
          // that both land in the same batch, so the composer's first render for
          // this chat is already the one that sends it.
          onStartDraft={(id) => {
            navigate({ draftId: id })
            setAutoSend(id)
          }}
          bridged={bridged}
          onBridgeLanded={bridgeLanded}
          onDraftStarted={chatStarted}
          onChanged={() => setConversationsSeq((n) => n + 1)}
        />
      </aside>

      <ConversationPane
        projectId={projectId}
        openSessionId={sessionId}
        draftId={draftId}
        // Polled, unlike everything else the pane knows about other chats. The
        // box has to go dark the moment another chat takes the repo, not the
        // next time something asks for the list.
        holder={project?.holder ?? null}
        // Gated on the open chat being the one that was pressed, so a ▶ that
        // somehow outlived its navigation cannot fire at whatever is open now.
        autoSend={autoSend !== null && autoSend === draftId}
        onAutoSent={() => setAutoSend(null)}
        onChanged={() => setConversationsSeq((n) => n + 1)}
        // A new chat has no id until its first turn starts. Put it in the
        // URL the moment it exists, so a reload mid-first-turn still lands
        // on the conversation rather than on a blank new one — and refetch
        // the list so the row appears. The chat that started is by definition
        // the one this pane is showing, so `chatStarted` always navigates here.
        onStarted={(id) => chatStarted(draftId, id)}
      />

      {/* Always on screen. Not a view of the repository — reading a change
          belongs to the conversation that made it — but the live reading of
          what the next auto-commit will take, and the one git button left. */}
      <PendingRail
        projectId={projectId}
        pending={pending}
        error={pendingError}
        onPush={(squash) => void pushWork(squash)}
        pushing={pushing}
        // Locked while anything has the checkout: pushing while an agent
        // writes — or while the auto-commit after its turn is landing — would
        // send a branch whose tip is about to move.
        pushBlocked={gates.push}
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

/**
 * Drop a project from aide's list.
 *
 * It says `forget`, never `delete`, because `delete` is a promise aide does not
 * keep in either direction: nothing on disk is destroyed — the repository, its
 * `.aide/` and every conversation stay — and somebody reading `delete` would
 * reasonably not press it when they only meant to tidy the list.
 *
 * Two presses, and the second one NAMES the project rather than asking "are you
 * sure" — a question whose only answer is the button you already pressed. The
 * arming is local to this row and expires (`CONFIRM_MS`), so two cannot be armed
 * at once and one left armed cannot catch a later click.
 *
 * Refused while a run holds the checkout, and that guard is the daemon's as well
 * (`DELETE /api/projects/:id`). The reason is sharper than the push gate's: the
 * lane belongs to the daemon rather than the registry, so dropping the entry
 * under a live turn does not stop that turn, it ORPHANS it — the run keeps
 * writing to a checkout nothing on screen can name.
 */
function ForgetProject({
  name,
  blocked,
  onForget,
}: {
  name: string
  /** Why this cannot be forgotten right now — a run has the checkout. */
  blocked: string | null
  onForget: () => void
}) {
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => setArmed(false), CONFIRM_MS)
    return () => clearTimeout(timer)
  }, [armed])

  if (blocked) {
    // Shown rather than hidden on hover like the other two states: a row you
    // cannot act on should say so when you go looking, not answer with nothing.
    return (
      <Hint hint={blocked}>
        <span className={`inline-flex shrink-0 items-center rounded-sm p-1 ${LOCKED}`}>
          <Lock className="size-3" />
        </span>
      </Hint>
    )
  }

  if (armed) {
    return (
      <Hint hint={`Drop ${name} from aide's list. The repository and its files are untouched.`}>
        <button
          type="button"
          onClick={onForget}
          className="shrink-0 rounded-sm bg-diff-del-fg/85 px-1.5 py-0.5 font-sans text-[10px] text-white hover:bg-diff-del-fg"
        >
          forget {name}
        </button>
      </Hint>
    )
  }

  // Hover-only, like the discard in the chat list: tidying the rail is not what
  // it is open for, and a ✕ on every row is a column of them beside the names.
  return (
    <Hint hint="Remove this project from aide. Nothing on disk is deleted.">
      <button
        type="button"
        onClick={() => setArmed(true)}
        className="shrink-0 rounded-sm p-1 text-fg-dim opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-err focus-visible:opacity-100"
      >
        <X className="size-3" />
      </button>
    </Hint>
  )
}
