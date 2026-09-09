/**
 * The second turn aide knows how to ask for: a plan, sliced into waves.
 *
 * Borrowed from the GSD ("get shit done") school of spec-driven development,
 * translated onto aide's own machinery rather than imported as scaffolding.
 * GSD's discipline is: research in parallel subagents, slice work into plans
 * small enough for a fresh context window, execute in dependency order, one
 * atomic commit per task. aide already owns most of those nouns — a parked
 * chat is the plan file, a turn is the fresh context, the auto-commit is the
 * atomic commit, and the tick is the verify — so what a framework would add
 * as files and slash commands arrives here as one prompt.
 *
 * Same category as `survey`, and the same decisions carry over: it sends on
 * the press (a button you pressed asking you to press again is the "new"
 * button that ignored you), it carries its own title so `naming.ts` does not
 * spend a model call asking what aide's own paragraph is about, and it goes
 * out at Plan because it says "don't write code yet" — sending that at a mode
 * that acts is an instruction and its own contradiction.
 *
 * Two clauses are the ones doing the work:
 *
 * - "waves must be independent — none reads a file another writes" is what
 *   makes the slicing honest. aide runs one agent per project, so waves do
 *   not buy parallel execution here; what they buy is that any task can run
 *   first, any task can be dropped, and nothing has to be re-planned between
 *   them. A plan whose steps secretly order themselves is a plan that fails
 *   on step two.
 * - "write each task AS the prompt I would send" is what makes the plan
 *   actionable without a framework. The deliverable is rows for the backlog:
 *   each item gets pasted into a parked chat and run as its own turn, so an
 *   item that needs the plan beside it to make sense is an item written
 *   wrong.
 *
 * A plain string, meant to be edited — in the box before sending, and here
 * when a press teaches you something.
 */
export const WAVES_PROMPT = `Plan the next piece of work on this project as waves of independent tasks.

The goal is the current milestone in the project brief; if this conversation already names a different goal, use that instead. Research before you slice, and fan the reading out: where questions are independent, spawn parallel subagents with the Agent tool, one per question, in one message — keep their conclusions, not their file dumps.

Then slice the work into waves. Wave 1 is every task that depends on nothing, wave 2 is what needs wave 1 landed, and so on. Tasks in the same wave must be independent — none reads a file another writes — so any one of them can run first, or be dropped.

Write each task AS the prompt I would send: a few sentences, self-contained, naming the files it touches and how to tell it worked. Each must be small enough for one turn and whole enough to stand as its own commit — a task that cannot stand as a commit is sliced wrong.

Say what you left out of the slice and why. Don't write code yet: the plan is the deliverable. I'll park the tasks as chats and run them in wave order — the parallelism was in the research, and in never having to re-plan between tasks.`
