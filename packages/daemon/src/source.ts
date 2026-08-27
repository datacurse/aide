import { createHash } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Which version of its own code this process is running.
 *
 * A daemon is long-lived and loads its modules once. Every edit to
 * `packages/daemon/src` therefore produces a process running code that no longer
 * exists on disk, and nothing in the system knew that — the symptom was a raw
 * Fastify 404 for a route added minutes earlier, which reads as broken code
 * rather than as an old process. That is not a rare accident here: the milestone
 * is developing aide in aide, so every daemon-side feature lands in a checkout
 * whose daemon predates it.
 *
 * So the daemon fingerprints its own source at boot and can re-check it at any
 * time. `stale` then has an answer rather than an opinion, and something else
 * can act on it.
 *
 * Contents, not mtimes. `git checkout` and `git merge` rewrite files whose
 * content is unchanged, and a fingerprint made of timestamps would call that a
 * new version and trigger a pointless restart on every branch switch.
 */

/**
 * Both source trees, because both are loaded as raw TypeScript: `@aide/protocol`
 * reaches the daemon through a pnpm workspace junction, not as a built artefact,
 * so editing a shared type changes what this process would run.
 *
 * Everything under them is hashed, including files the server never imports
 * (`smoke.ts`, `probe.ts`). Walking the real import graph would be more precise
 * and is not worth it: the cost of being wrong is one restart of an idle daemon,
 * about a second, and nobody is waiting on it.
 */
const ROOTS = [
  fileURLToPath(new URL("./", import.meta.url)),
  fileURLToPath(new URL("../../protocol/src/", import.meta.url)),
]

async function fingerprint(): Promise<string | null> {
  const hash = createHash("sha1")
  let counted = 0

  for (const root of ROOTS) {
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true, recursive: true })
    } catch {
      // No source tree here — an installed copy rather than a checkout. Nothing
      // to compare against, so say so rather than invent a fingerprint.
      return null
    }
    // Sorted, because readdir order is filesystem order and two machines (or the
    // same machine after a checkout) must agree on the hash of identical trees.
    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith(".ts") && !e.parentPath.includes("node_modules"))
      .map((e) => join(e.parentPath, e.name))
      .sort()

    for (const file of files) {
      try {
        // The path relative to its root, so hashing is stable no matter where
        // the checkout lives.
        hash.update(file.slice(root.length))
        hash.update(await readFile(file))
        counted += 1
      } catch {
        /* vanished mid-walk; the next check will see the settled tree */
      }
    }
  }

  return counted === 0 ? null : hash.digest("hex").slice(0, 12)
}

/**
 * Long enough that the browser polling health does not re-read forty files a
 * second, short enough that a save is noticed about as fast as you can alt-tab.
 */
const TTL_MS = 2000

let cached: { id: string | null; at: number } | null = null

export async function currentSourceId(): Promise<string | null> {
  const now = Date.now()
  if (cached && now - cached.at < TTL_MS) return cached.id
  const id = await fingerprint()
  cached = { id, at: now }
  return id
}

/**
 * Captured at import, before the server listens, so it describes the code this
 * process actually loaded rather than whatever the tree looked like later.
 */
export const BOOT_SOURCE_ID = await fingerprint()

/** True only when both fingerprints are known and differ. Unknown is never stale. */
export async function isStale(): Promise<boolean> {
  const now = await currentSourceId()
  return BOOT_SOURCE_ID !== null && now !== null && now !== BOOT_SOURCE_ID
}
