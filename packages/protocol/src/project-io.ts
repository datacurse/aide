import matter from "gray-matter"
import { RETIRED_DOC_KEYS, type ProjectDoc } from "./project.js"

/**
 * Parsing `.aide/project.md`. Node-only, because gray-matter is.
 *
 * There is nothing left in the frontmatter that aide acts on — the whole file is
 * prose for the agent now. What remains here is the opposite job: noticing keys
 * that USED to do something, so a `bootstrap:` line someone wrote a month ago
 * does not just quietly stop running with nothing on screen to say so.
 *
 * Reported rather than thrown on. A retired key is not a mistake in the file, it
 * is a file that outlived a feature, and refusing to open the project over it
 * would be a worse answer than a line on the board.
 */
export function parseProjectDoc(raw: string): ProjectDoc {
  const { data, content } = matter(raw)
  const retired = RETIRED_DOC_KEYS.filter((key) => data[key] !== undefined && data[key] !== null)
  return { body: content.trim(), retired: [...retired] }
}
