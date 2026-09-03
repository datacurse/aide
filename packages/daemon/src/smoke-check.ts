/**
 * The one assertion, and the one tally behind it.
 *
 * `smoke.ts` grew past two thousand lines, at which point the cost of adding an
 * assertion was finding where to put it. What could be split off is less than it
 * looks: most of that file drives ONE throwaway repository through a deliberate
 * sequence — a checkpoint, then a commit against it, then a branch and a merge
 * for the history view to draw — and each section is set up by the ones above it.
 * Splitting those would mean building a repository per file, which is slower and
 * quietly changes what is being tested: that the operations compose.
 *
 * What is genuinely separable is the group that touches no repository at all —
 * the shell policy, the plan-mode rules, the browser-safety check, the restart
 * decision — and that is `smoke-policy.ts`. It shares this counter rather than
 * keeping one of its own, because two files each printing their own "all checks
 * passed" is two exit codes and a way for one to be green while the other is not.
 *
 * The failure count lives here, in module scope. ES modules are evaluated once
 * and cached, so both importers see the same `failures` — which is the whole
 * reason this is a module rather than a function returning a fresh counter.
 */

let failures = 0

/**
 * One assertion.
 *
 * `detail` is not decoration: on a FAIL it is usually the only thing that says
 * what the value actually was, and several of the checks in these files are
 * about a non-effect — that something did NOT change — where the label alone
 * cannot tell you which direction it broke in.
 */
export function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures += 1
}

/** How many have failed so far, across every file that has imported this. */
export const failureCount = (): number => failures

/**
 * Print the verdict and exit.
 *
 * Called once, by whichever file is the entry point. It exits the process rather
 * than returning a code, because a smoke run that ended without saying so is
 * indistinguishable from one that passed.
 */
export function report(): never {
  console.log(`\n${failures === 0 ? "all checks passed" : `${failures} FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}
