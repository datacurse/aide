/**
 * A unified diff, coloured.
 *
 * Shared rather than copied, because two of these would drift: the run pane
 * shows what an agent did in a worktree and the git pane shows what is in the
 * repo, and the moment those render `+` differently the human reviewing one has
 * to re-learn the other.
 *
 * Deliberately not a diff *parser*. It colours lines by their first character,
 * which is all a unified diff needs and all that stays correct when git emits
 * something this code has never seen — a binary notice, a mode change, a
 * `\ No newline at end of file`. A structured parser would have to be taught
 * each of those, and would render an unrecognised patch as nothing.
 */

function lineClass(l: string): string {
  // Order matters: `+++` and `---` are file headers and start with the same
  // characters as added and removed lines, so they have to be caught first or
  // every file header reads as an edit.
  if (l.startsWith("+++") || l.startsWith("---")) return "text-fg-muted"
  if (l.startsWith("+")) return "bg-diff-add text-diff-add-fg"
  if (l.startsWith("-")) return "bg-diff-del text-diff-del-fg"
  if (l.startsWith("@@")) return "text-syn-comment"
  if (l.startsWith("diff --git")) return "mt-3 text-syn-var"
  return "text-fg-muted"
}

export function Diff({ patch }: { patch: string }) {
  return (
    <pre className="w-full overflow-x-auto whitespace-pre">
      {patch.split("\n").map((l, i) => (
        // A blank line in a patch is a context line that happens to be empty.
        // Rendered as "" the div collapses to zero height and the diff loses a
        // row, so the alignment against the line beside it silently shifts.
        <div key={i} className={lineClass(l)}>
          {l || " "}
        </div>
      ))}
    </pre>
  )
}
