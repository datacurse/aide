This is purely a UI layout refactor (removing the header bar, moving daemon controls into the projects rail footer). It doesn't add, change, or remove any capability described in the spec — no new behavior, no fixed limitation. The file comes back unchanged.

# What aide can and cannot do

The capability list. One line per thing, present tense, only what is true of the
code on this branch. Agents write this as part of the change that earns the
claim, so a line here should always have a commit behind it.

`project.md` is the other half — why aide exists and what it refuses to become.
This file is what it currently does.

## Projects

- Adds a git repository by absolute path and remembers it in `~/.aide/registry.json`.
- Reads `.aide/project.md` for a brief, and puts it in every agent's system
  prompt.
- Cannot manage a directory that is not a git repository.

## Chats

- Runs a conversation against the Claude Agent SDK in the project root, with the
  full Claude Code toolset available and only read-only tools auto-approved.
- Asks before each edit, or accepts them, or plans, depending on the mode picker;
  effort is a per-turn slider.
- Keeps the SDK session open between turns, so a follow-up costs a message rather
  than a fork, a CLI boot and a transcript replay. Falls back to a cold start with
  `resume` whenever there is no live session.
- Closes a conversation's session after ten idle minutes and reopens it on demand.
- Streams tokens as they arrive, and reports what each turn cost.
- Runs in the project's own checkout, always. There is no worktree, no branch
  per conversation and nothing to merge.
- Takes a snapshot of the working tree before the first turn and records it at
  `refs/aide/checkpoints/<session>`, including files git is not tracking yet, and
  reports the command that restores it.
- Restores what a run changed or deleted, and says so plainly: files the run
  CREATED are left, because removing them would mean `git clean` and that takes
  every other untracked file with it.
- Holds that baseline still for the whole conversation, so the diff at the end is
  everything the conversation did rather than only its last message.
- Marks the end of every turn that changed the tree at
  `refs/aide/turns/<session>/<n>`, chained so one turn's work is the diff between
  two adjacent refs, and shows each marker in the transcript with the command
  that returns to it. A turn that changed nothing leaves none, because a restore
  point identical to the one before it is not a place you can go back to.
- Writes that marker before it releases the project, so a boundary holds its own
  turn's work and never the next turn's opening edits.
- Carries a status when the board is tracking it: working, needs you, or closed,
  with blocked and stale as flags. An ordinary question has no status, because
  calling it "needs you" forever would bury the ones that do.
- Sorts the list by what it costs to ignore — blocked, needs you, working,
  ordinary, then finished pushed to the bottom.
- Is closed by a human and only by a human: done, failed or dropped. Nothing an
  agent runs can reach that route.
- Says whether it is on the board in the composer: editable before the first
  message, shown locked afterwards, because a row is paired with a session at the
  moment the SDK names it.

## The board

- Reads `.aide/todos.md` as a backlog: any line starting with `-` is a row, and
  aide numbers unnumbered ones on the next save without reformatting the rest of
  the file.
- Shows the backlog next to `.aide/spec.md`, so what is wanted and what is built
  are on screen together. It is the app's front door.
- Runs one agent per project at a time. A second request is refused, naming the
  conversation that holds the checkout and how long it has held it — refused
  rather than queued, because a queued turn would start against a tree the
  previous run had just rewritten and nobody had reviewed.
- Shows which conversation holds a project's checkout in the project list.
- Marks a row `working`, `needs you` or `blocked` from the conversation attached
  to it, and sorts by what it costs to ignore.
- Starting a chat from a row fills the message box and stops — sending is still
  a human action.
- Remembers which conversation is working which row in `~/.aide/board.json`,
  outside the repository.
- Creates a row for a cold conversation that asked to be tracked, because work
  off the board is invisible.
- Records which conversation is on which row itself, at the moment the SDK names
  the session — the browser is not in that path.
- Commits a conversation's work as a run of its own, narrated live in its
  transcript: reads the diff, drafts the message and the spec update with it,
  then writes both. There is no panel to review either in first — the
  transcript afterwards is the review.
- Measures that diff against the conversation's checkpoint rather than against
  HEAD, so it is the agent's work and not the agent's work plus whatever was
  already uncommitted — and commits exactly the paths in it, leaving anything
  the human had staged or left lying around alone.
- Commits a file the run deleted, including one the run staged the deletion of
  itself with `git rm` — a path in neither the worktree nor the index is a fatal
  error to `git add`, and it used to take the whole commit down with it.
- Skips a path whose deletion an earlier commit already took, rather than
  refusing the commit. A long-lived conversation measures against a checkpoint
  from before that commit, so it still names the file; git refuses a pathspec
  matching nothing anywhere, and refuses the whole command with it. A run with
  nothing but such paths is told that everything it changed is already in.
- Names the files the run changed that were ALREADY modified before it started,
  because git cannot separate two people's edits inside one file and committing
  one takes both.
- Writes the drafted spec update as part of the same commit, so the claim and
  the code that earns it are one commit and one revert. Leaves the file alone
  when the diff earns no change to the capability list, rather than blanking it.
- Starts that run from a button in the uncommitted rail, which holds the
  project for its duration exactly like a turn — a second commit or a new
  conversation is refused the same way a second turn would be — and can be
  stopped before it writes, though not after.
- Cannot merge anything. There is no branch to merge, and no `land`.
- Stamps each commit with `Aide-Row` and `Aide-Session`, so the transcript is
  one command away long after the backlog line is gone.
- Removes a row when its conversation is closed as done or dropped, and leaves it
  when closed as failed — the verdict is the shape of the backlog, not a status
  field on the row.
- Reports where the conversation's checkpoint is as it closes, and keeps the ref:
  closing must not be the one irreversible step in the flow.
- Remembers verdicts in `~/.aide/board.json` so a finished conversation stays
  finished in the list after its row is gone.
- Numbers rows above every `Aide-Row` trailer already in the history, so an id
  that reached a commit is never handed out again and one row's commits cannot be
  attributed to another.
- Warns when `.aide/project.md` is past the size that fits in a prompt, or still
  sets a frontmatter key aide no longer reads.

## Git

- Keeps a rail of uncommitted files on screen beside every pane, naming them and
  the branch they are on, with the one button that commits them. It still
  commits a CONVERSATION's work rather than the rail's own — greyed out with a
  reason when none is open, and it streams into that conversation's transcript
  when pressed.
- Leaves `.aide/todos.md` out of that list, because the daemon rewrites it and a
  commit is forbidden from taking it — counting it would light the indicator
  permanently.
- Refuses to start a NEW conversation while anything is uncommitted, naming the
  count and what to do about it. A follow-up is never refused: finishing the chat
  you are in is the way out.
- Cannot browse the repository: there is no history list, no commit view and no
  graph. A diff is read in the conversation that produced it, where there is a
  description and a checkpoint to measure it against; the rail is all that is
  left of the project-shaped view.

## The daemon

- Survives the browser: runs continue with the tab closed.
- Refuses requests whose `Host` is not a loopback authority.
- Needs no boot reconciliation: a conversation's state is derived on every read
  from whether a turn is actually in flight, so a crash leaves nothing to correct.
- Cannot resume a run across its own restart — anything in flight is lost.
- Holds off restarting itself while a turn or a mutating request is in flight,
  which matters more than it reads: developing aide in aide means a run rewrites
  the running daemon's own source as a matter of course.
- Keeps daemon-global state in `~/.aide`, or in `AIDE_HOME` when set, which is
  what lets the smoke suites run without writing to the real one.
- Puts `.aide/project.md` in every agent's system prompt, capped at 32,000
  characters and SAYING SO when it truncates, so a brief that lost its second
  half cannot read as complete.
- Points agents at `.aide/spec.md` rather than inlining it: what a project
  currently does is discoverable by reading the code, and that file grows.
