import matter from "gray-matter"
import { RETIRED_DOC_KEYS, parseVerify, type ProjectDoc } from "./project.js"

/**
 * Parsing `.aide/project.md`. Node-only, because gray-matter is.
 *
 * The frontmatter acts on one key again — `verify:`, the commands a commit has
 * to get past — after a stretch where the whole file was prose. That is the same
 * shape `bootstrap:` had, and it went for a reason that does not apply here:
 * bootstrap existed to install dependencies into a fresh worktree, and there are
 * no worktrees. Checking the tree before writing history is not tied to any of
 * that.
 *
 * The other job here is the opposite one: noticing keys that USED to do
 * something, so a `bootstrap:` line someone wrote a month ago does not just
 * quietly stop running with nothing on screen to say so. Reported rather than
 * thrown on — a retired key is not a mistake in the file, it is a file that
 * outlived a feature, and refusing to open the project over it would be a worse
 * answer than a line on the board.
 *
 * `verify:` gets the opposite treatment and throws, because the two mistakes are
 * not alike: a retired key does nothing and says so, while a malformed `verify:`
 * would silently commit unchecked code.
 */
export function parseProjectDoc(raw: string): ProjectDoc {
  const { data, content } = matter(raw)
  const retired = RETIRED_DOC_KEYS.filter((key) => data[key] !== undefined && data[key] !== null)
  return { body: content.trim(), retired: [...retired], verify: parseVerify(data["verify"]) }
}
