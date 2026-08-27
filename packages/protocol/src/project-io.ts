import matter from "gray-matter"
import {
  DEFAULT_BOOTSTRAP_TIMEOUT_MS,
  type ProjectDoc,
} from "./project.js"

/** Parsing `.aide/project.md`. Node-only, because gray-matter is. */
export function parseProjectDoc(raw: string): ProjectDoc {
  const { data, content } = matter(raw)

  const bootstrapRaw = data["bootstrap"]
  let bootstrap: string | null = null
  if (bootstrapRaw !== undefined && bootstrapRaw !== null) {
    if (typeof bootstrapRaw !== "string") {
      throw new Error(
        `project.md: \`bootstrap\` must be a string, got ${JSON.stringify(bootstrapRaw)}`,
      )
    }
    bootstrap = bootstrapRaw.trim() || null
  }

  const timeoutRaw = data["bootstrapTimeoutMs"]
  let bootstrapTimeoutMs = DEFAULT_BOOTSTRAP_TIMEOUT_MS
  if (timeoutRaw !== undefined && timeoutRaw !== null) {
    const n = Number(timeoutRaw)
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(
        `project.md: \`bootstrapTimeoutMs\` must be a positive number, got ${JSON.stringify(timeoutRaw)}`,
      )
    }
    bootstrapTimeoutMs = n
  }

  return { bootstrap, bootstrapTimeoutMs, body: content.trim() }
}
