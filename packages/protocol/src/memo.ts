/**
 * A per-project memo over a store that is replaced rather than mutated.
 *
 * ## The bug this exists to stop, which is not a slow render
 *
 * `useSyncExternalStore` compares snapshots by IDENTITY. A snapshot function
 * that derives an array — "the unsent chats in this project" — builds a new one
 * on every call, so without a memo every read reports a change and the component
 * re-renders forever. That is the loop, and it does not degrade gracefully: the
 * page paints once and goes grey when React gives up.
 *
 * The version this replaces held ONE slot, `{ source, projectId, rows }`, and it
 * was correct for exactly as long as one project was on screen at a time. The
 * four panes are scoped to one, so the slot always hit. The wall draws a column
 * per project, and with one slot the columns evict each other — A's read
 * replaces B's entry, B's read replaces A's, so every read on every column
 * misses and returns a fresh array. Interleaving is the trigger, so the failure
 * appears only when a second project is on screen, which is why nothing before
 * the wall found it.
 *
 * Keyed on the SOURCE as well: the store is replaced wholesale on every write,
 * so one identity comparison invalidates every project at once and no caller has
 * to know which project a write touched.
 *
 * ## Why this is here rather than beside the hook
 *
 * `drafts.ts` reaches for `window.indexedDB` at module load and so cannot be
 * imported from Node — the same trap `mergedMode` was moved here to escape. This
 * is the whole of the correctness of that hook, it is invisible to the compiler
 * (returning a fresh array is perfectly well typed), and it is invisible to a
 * type check and a build. `pnpm smoke` drives it with two projects interleaved,
 * which is precisely the case that broke.
 */
export class PerProjectMemo<T> {
  #source: object | null = null
  #byProject = new Map<string, readonly T[]>()

  /**
   * The memoized rows for one project, or null when there is no project.
   *
   * `compute` is called only on a miss. The array it returns is held by identity
   * and handed back unchanged until the source is replaced.
   */
  read(source: object, projectId: string | null, compute: (projectId: string) => T[]): readonly T[] | null {
    if (projectId === null) return null
    // A new store means every project's rows are stale at once — the map is
    // replaced on write, so this one comparison covers all of them.
    if (this.#source !== source) {
      this.#source = source
      this.#byProject = new Map()
    }
    const held = this.#byProject.get(projectId)
    if (held) return held
    const rows = compute(projectId)
    this.#byProject.set(projectId, rows)
    return rows
  }
}
