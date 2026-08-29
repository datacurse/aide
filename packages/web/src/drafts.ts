import { useSyncExternalStore } from "react"
import type { Attachment } from "@aide/protocol"

/**
 * What is in the message box but has not been sent.
 *
 * Two things need this, and they turn out to be the same thing. A chat you have
 * started but not spoken in yet has no session id — the SDK assigns one on the
 * first turn — so the only place such a conversation can exist is here, and that
 * record is its row in the list. And a half-typed message with a screenshot
 * pasted into it is worth more than the reload that would otherwise eat it.
 *
 * A project may hold any number of those unstarted records, and that is the
 * backlog: something you want is a chat you have written and not sent. There is
 * no second list and no file for it, because an unsent sentence is not yet a
 * fact about the project — it becomes one when you press send.
 *
 * In the browser rather than in `.aide/`, deliberately: none of this has
 * happened yet. A pasted image is bytes that exist in one tab, and writing
 * either through the daemon would mean the project carrying state for a
 * conversation that may never exist.
 *
 * IndexedDB rather than localStorage, for one reason: attachments. The composer
 * takes images up to 10MB, whose base64 is 13M characters — several times the
 * entire localStorage quota. That write throws, and the draft you were promised
 * turns out not to be there, which is worse than never offering to keep it.
 */

export interface Draft {
  /** `${projectId}:${id}`, where id is a session uuid or a `new-` id for one that has none yet. */
  key: string
  text: string
  attachments: Attachment[]
  /**
   * Kept even when it is empty, because this record IS the chat's row in the
   * list — and an empty box is how a chat you just created looks. A draft on a
   * conversation that already exists is deleted the moment its box is emptied.
   */
  pinned: boolean
  /** epoch ms */
  createdAt: number
  updatedAt: number
}

/**
 * The id of a chat that has not started.
 *
 * Session ids are uuids, so this prefix cannot collide with one — which is what
 * lets a single key space hold both an unstarted chat and the conversation it
 * turns into, and lets the list tell them apart by looking at the key.
 */
const NEW = "new-"
let draftSeq = 0

/** Unique within a project, which is as far as these ever travel. */
const newDraftId = (): string => {
  draftSeq += 1
  return `${NEW}${Date.now().toString(36)}${draftSeq}`
}

export const draftKey = (projectId: string, id: string): string => `${projectId}:${id}`

/** The id half of a key. Keys are `<projectId>:<id>` and project ids have no colon. */
export const idFromKey = (key: string): string => key.slice(key.indexOf(":") + 1)

const DB_NAME = "aide"
const STORE = "drafts"

/**
 * Memory is the source of truth and IndexedDB is the backing store, not the
 * other way round. Reads never wait on a transaction, which is what lets the
 * composer be driven straight off this map: a keystroke lands here immediately
 * and reaches disk in the next batch, so switching conversations mid-word
 * cannot lose the word.
 */
let cache = new Map<string, Draft>()
const listeners = new Set<() => void>()

function publish() {
  for (const notify of listeners) notify()
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify)
  return () => {
    listeners.delete(notify)
  }
}

let connection: Promise<IDBDatabase | null> | null = null

function connect(): Promise<IDBDatabase | null> {
  return (connection ??= new Promise((resolve) => {
    let request: IDBOpenDBRequest
    try {
      request = window.indexedDB.open(DB_NAME, 1)
    } catch {
      // Private mode, or storage disabled. Drafts then live as long as the tab,
      // which is still better than losing them on every conversation switch.
      resolve(null)
      return
    }
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: "key" })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
    request.onblocked = () => resolve(null)
  }))
}

void (async () => {
  const db = await connect()
  if (!db) return
  const rows = await new Promise<Draft[]>((resolve) => {
    try {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).getAll()
      request.onsuccess = () => resolve(request.result as Draft[])
      request.onerror = () => resolve([])
    } catch {
      resolve([])
    }
  })
  const merged = new Map(cache)
  for (const row of rows) {
    const held = merged.get(row.key)
    // Whatever was typed while this read was in flight is newer than what came
    // back from disk, so the read must not win. An empty record is a different
    // case: pressing "new" in the first few milliseconds of a page creates one
    // holding nothing, and letting that shadow the saved draft would eat the
    // message you reloaded to get back.
    if (!held) merged.set(row.key, row)
    else if (held.text === "" && held.attachments.length === 0) {
      merged.set(row.key, { ...row, pinned: row.pinned || held.pinned })
    }
  }
  cache = merged
  publish()
})()

/**
 * How long a keystroke may sit in memory before it reaches disk. One transaction
 * per character would be silly; a whole sentence at risk would defeat the point.
 */
const WRITE_DELAY_MS = 400

/** Queued disk writes, `null` meaning "delete this key". */
const pending = new Map<string, Draft | null>()
let timer: ReturnType<typeof setTimeout> | null = null

function schedule(key: string, row: Draft | null) {
  pending.set(key, row)
  timer ??= setTimeout(flush, WRITE_DELAY_MS)
}

function flush() {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  if (pending.size === 0) return
  const batch = [...pending]
  pending.clear()
  void connect().then((db) => {
    if (!db) return
    try {
      const store = db.transaction(STORE, "readwrite").objectStore(STORE)
      for (const [key, row] of batch) {
        if (row) store.put(row)
        else store.delete(key)
      }
    } catch {
      // A quota refusal, or a connection that went away. Nothing useful to say
      // about it here — the draft is still in memory for this page.
    }
  })
}

// The reload is the case this whole module exists for, so the last few
// keystrokes must not still be sitting in the batch when it happens.
window.addEventListener("pagehide", flush)

function commit(key: string, row: Draft | null) {
  const next = new Map(cache)
  if (row) next.set(key, row)
  else next.delete(key)
  cache = next
  schedule(key, row)
  publish()
}

export function saveDraft(key: string, content: { text: string; attachments: Attachment[] }): void {
  const prev = cache.get(key)
  // Emptiness is exact rather than trimmed: with the composer reading straight
  // off this store, discarding on whitespace would make the space bar delete
  // itself whenever it was the only thing in the box.
  const empty = content.text === "" && content.attachments.length === 0
  if (empty && !prev?.pinned) {
    if (prev) commit(key, null)
    return
  }
  if (prev && prev.text === content.text && prev.attachments === content.attachments) return
  const now = Date.now()
  commit(key, {
    key,
    text: content.text,
    attachments: content.attachments,
    pinned: prev?.pinned ?? false,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  })
}

/**
 * The current contents of a box, outside a render. For the handlers that have to
 * wait for something — decoding a pasted image — and must not write back the
 * value they captured before the wait.
 */
export function readDraft(key: string): { text: string; attachments: Attachment[] } {
  const row = cache.get(key)
  return { text: row?.text ?? "", attachments: row?.attachments ?? [] }
}

export function discardDraft(key: string): void {
  if (cache.has(key)) commit(key, null)
}

function createUnstarted(
  projectId: string,
  content: { text: string; attachments: Attachment[] },
): string {
  const id = newDraftId()
  const key = draftKey(projectId, id)
  const now = Date.now()
  commit(key, { key, ...content, pinned: true, createdAt: now, updatedAt: now })
  return id
}

/**
 * Press "new" and you get a new chat. Every press, no exceptions.
 *
 * This used to hand back any blank unstarted chat the project already held, on
 * the theory that nobody wants two empty boxes. What it did in practice was
 * make the button do nothing you could see: the list IS the backlog, so a
 * leftover blank row is usually sitting in it somewhere, and "new" jumped the
 * selection to that row rather than creating anything — however many times you
 * pressed it. A blank row you did not want costs one ✕; a button that ignores
 * you cannot be fixed from the outside.
 */
export function openNewChat(projectId: string): string {
  return createUnstarted(projectId, { text: "", attachments: [] })
}

/**
 * Something you want, parked as a chat you have not sent.
 *
 * This is the whole of the backlog. An entry is a conversation that exists and
 * has not spoken — the same record pressing "new" makes — so opening one is
 * selecting it rather than copying it somewhere, and sending it is the only
 * thing that turns it into work.
 */
export function addBacklogChat(
  projectId: string,
  content: { text: string; attachments: Attachment[] },
): string {
  return createUnstarted(projectId, content)
}

/**
 * The moment a new chat learns its session id it stops being the new-chat row
 * and becomes an ordinary conversation. Moving the draft rather than dropping it
 * is what keeps a second message typed while the first turn was still running.
 */
export function carryDraft(from: string, to: string): void {
  const row = cache.get(from)
  if (!row) return
  commit(from, null)
  if (row.text !== "" || row.attachments.length > 0) {
    commit(to, { ...row, key: to, pinned: false })
  }
}

/**
 * One draft, by key. Scoped to a single record on purpose: the composer writes
 * on every keystroke, and a hook over the whole map would re-render the
 * conversation list once per character.
 *
 * The record objects are replaced rather than mutated, so returning one straight
 * from the cache is already the stable snapshot useSyncExternalStore compares by
 * identity.
 */
export function useDraft(key: string | null): Draft | null {
  return useSyncExternalStore(subscribe, () => (key === null ? null : (cache.get(key) ?? null)))
}

function unstartedFor(projectId: string): Draft[] {
  const prefix = `${projectId}:${NEW}`
  return [...cache.values()]
    .filter((d) => d.key.startsWith(prefix))
    .sort((a, b) => a.createdAt - b.createdAt)
}

/**
 * Every chat in this project that has not started, oldest first.
 *
 * Memoized against the cache map itself, which is replaced rather than mutated
 * on every write: without this the array is a new identity on each read and
 * useSyncExternalStore treats an unchanged backlog as a change on every
 * keystroke anywhere in the app, which is an infinite render loop rather than
 * merely slow.
 */
let listCache: { source: typeof cache; projectId: string; rows: Draft[] } | null = null

export function useUnstartedChats(projectId: string | null): Draft[] {
  return useSyncExternalStore(subscribe, () => {
    if (!projectId) return NO_DRAFTS
    if (listCache?.source === cache && listCache.projectId === projectId) return listCache.rows
    const rows = unstartedFor(projectId)
    listCache = { source: cache, projectId, rows }
    return rows
  })
}

/** One array for every empty backlog, so the identity is stable across reads. */
const NO_DRAFTS: Draft[] = []
