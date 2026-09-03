/**
 * The one turn aide knows how to ask for.
 *
 * `commit` is a gate: it has a precondition, a defined output and a refusal.
 * This is not that. It is a turn nobody typed — the same category as the commit
 * gate's single repair attempt — and the brief already says what that has to be:
 * Plan, which acts and asks once, rather than a mode that stops mid-turn for a
 * permission nobody is there to give.
 *
 * So there is no new machinery here and deliberately so. Pressing `survey`
 * creates the same unstarted chat the ▶ on a parked row sends, with this text in
 * it, at Plan. Everything after the press is an ordinary conversation: it holds
 * the project's checkout like any other, it appears in the list, it can be
 * stopped, and answering "do #2" is just the next message. That is the whole
 * feature — the button saves you typing a prompt you would otherwise keep in a
 * note somewhere, and nothing else about it is special.
 *
 * ## Why this prompt and not "simplify the code"
 *
 * Because "simplify" is a word a model can satisfy by moving things around. The
 * question that has a useful answer is what the NEXT change costs: where adding
 * something means editing three files that have to agree, where one idea is
 * spelled two ways, where something exists only because something else used to.
 *
 * The two clauses that look like padding are the two that were learned:
 *
 * - Asking for the line count keeps a rename honest. A survey that leads with a
 *   file split reads like a large finding and deletes nothing.
 * - Asking for the things that LOOK redundant and are not makes those a
 *   deliverable rather than something the model has to justify going off-piste
 *   to mention. In this repository that is most of the interesting answer: three
 *   `money` formatters that are three different decisions, a `kind: "task"` that
 *   still describes transcripts on disk, a smoke file whose sections are ordered
 *   on purpose. A survey that merged those would be a net loss dressed as a
 *   cleanup.
 *
 * It is a plain string rather than anything assembled, because it is meant to be
 * edited — by hand in the box before sending, and here when a press teaches you
 * something. The composer is a text box; that is the whole extension point.
 */
export const SURVEY_PROMPT = `Survey this codebase for technical debt and rank what you find, worst first.

I care about the cost of the *next* change: places where adding a feature means editing three files that must agree, where one concept is spelled two ways, where a thing exists only because something else used to exist.

For each finding, tell me: what it costs today, what removing it would cost, and roughly how many lines it deletes.

If something looks redundant but isn't — two things that would merge into one and shouldn't — say so and why. I would rather know it is deliberate than have you merge it.

Don't write code yet. And don't rank by how satisfying the cleanup is: rank by how much it slows down future work.`
