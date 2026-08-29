import { useEffect, useRef, useState } from "react"
import { MAX_ATTACHMENT_BYTES, readAsAttachment } from "./attachments.js"
import { readDraft, saveDraft, useDraft } from "./drafts.js"
import { useAutoGrow } from "./useAutoGrow.js"
import { useRemembered } from "./useRemembered.js"
import {
  CHAT_MODES,
  CHAT_MODE_LABEL,
  EFFORT_LEVELS,
  type Attachment,
  type ChatMode,
  type ContextUsage,
  type EffortLevel,
} from "@aide/protocol"

const kb = (bytes: number) =>
  bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`

const isChatMode = (v: unknown): v is ChatMode =>
  typeof v === "string" && (CHAT_MODES as readonly string[]).includes(v)
const isEffort = (v: unknown): v is EffortLevel =>
  typeof v === "string" && (EFFORT_LEVELS as readonly string[]).includes(v)

/**
 * The one message typed often enough to be worth a button of its own.
 *
 * "proceed" and not "continue": continue also reads as "resume what was cut
 * off", which is a different instruction, and the wrong one to hand a turn that
 * ended by itself.
 */
const PROCEED = "proceed"

/** One array for every empty box, so the identity is stable across renders. */
const NOTHING_ATTACHED: Attachment[] = []

/** The context meter. Counts DOWN, because what matters is the room left. */
function ContextMeter({ usage }: { usage: ContextUsage | null }) {
  if (!usage || !usage.maxTokens) return null
  const remaining = Math.max(0, 100 - usage.percentage)
  const tone = remaining < 15 ? "text-err" : remaining < 35 ? "text-warn" : "text-fg-dim"
  return (
    <span
      className={`flex items-center gap-1.5 text-[11px] ${tone}`}
      title={`${usage.totalTokens.toLocaleString()} of ${usage.maxTokens.toLocaleString()} tokens used`}
    >
      <span className="relative inline-block h-1 w-10 overflow-hidden rounded-full bg-input">
        <span
          className="absolute inset-y-0 left-0 bg-current"
          style={{ width: `${Math.min(100, Math.max(0, remaining))}%` }}
        />
      </span>
      {Math.round(remaining)}% context left
    </span>
  )
}

function ModePicker({
  mode,
  effort,
  onMode,
  onEffort,
}: {
  mode: ChatMode
  effort: EffortLevel
  onMode: (m: ChatMode) => void
  onEffort: (e: EffortLevel) => void
}) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", away)
    return () => document.removeEventListener("mousedown", away)
  }, [open])

  const label = CHAT_MODE_LABEL[mode].label

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-fg-muted hover:bg-hover hover:text-fg"
      >
        ⚡ {label}
      </button>
      {open && (
        <div className="absolute bottom-7 left-0 z-20 w-[22rem] rounded border border-line bg-chrome py-1 shadow-lg">
          <div className="px-3 py-1 font-sans text-[11px] text-fg-dim">Modes</div>
          {CHAT_MODES.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                onMode(m)
                setOpen(false)
              }}
              className={`flex w-full flex-col gap-0.5 px-3 py-1.5 text-left ${
                m === mode ? "bg-active text-white" : "hover:bg-hover"
              }`}
            >
              <span className="font-sans text-[12px]">{CHAT_MODE_LABEL[m].label}</span>
              <span
                className={`font-sans text-[11px] ${m === mode ? "text-white/70" : "text-fg-dim"}`}
              >
                {CHAT_MODE_LABEL[m].hint}
              </span>
            </button>
          ))}
          <div className="mt-1 flex items-center gap-2 border-t border-line px-3 py-2">
            <span className="font-sans text-[11px] text-fg-muted">Effort</span>
            <input
              type="range"
              min={0}
              max={EFFORT_LEVELS.length - 1}
              value={EFFORT_LEVELS.indexOf(effort)}
              onChange={(e) => onEffort(EFFORT_LEVELS[Number(e.target.value)] ?? "high")}
              className="flex-1 accent-accent"
            />
            <span className="w-12 text-right font-sans text-[11px] text-fg-dim">{effort}</span>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The message bar.
 *
 * Modelled on the Claude Code extension's, because that is the shape the work
 * actually has: type, attach what you are looking at, choose how much rope the
 * agent gets, watch the context fill, send. The mode picker is not decoration —
 * it maps 1:1 onto the SDK's `permissionMode`, so "Plan" genuinely means the
 * turn will present its plan before it does anything.
 */

export function Composer({
  busy,
  usage,
  sessionId,
  draftKey,
  inheritedMode,
  blocked,
  autoSend,
  onAutoSent,
  onSend,
  onInterrupt,
}: {
  busy: boolean
  usage: ContextUsage | null
  /** Which conversation is open; null for a new one. Scopes `inheritedMode`. */
  sessionId: string | null
  /** Where the unsent contents of the box live. See drafts.ts. */
  draftKey: string
  /** The mode this conversation was last driven at, or null if unknown. */
  inheritedMode: ChatMode | null
  /**
   * Whether this conversation gets a row on the board.
   *
   * This used to be the isolation toggle, and choosing it wrong used to matter:
   * it decided whether the agent got a worktree of its own or edited the tree
   * you were looking at. Every conversation edits that tree now, so all this
   * decides is whether the work is VISIBLE on the board — which is worth a
   * control, but not a warning.
   *
   * Still first-message-only. A row is paired with a session at the moment the
   * SDK names it, and there is no second moment to do it in.
   */
  /**
   * Why this box cannot send, or null. Only ever set on a NEW conversation, and
   * only for uncommitted work: the rule is that one chat's work is committed
   * before the next one starts. Stated here as well as in the rail — which is
   * where the commit button lives — because the refusal has to be readable from
   * the box it applies to.
   */
  blocked: string | null
  /**
   * Send what is in the box the moment it appears, without being pressed.
   *
   * Set by the ▶ on a parked chat, which is one press for "open this and start
   * it". The send lives here rather than in the row because everything a turn
   * needs besides the text — the mode, the effort, the plan-then-Auto switch —
   * is remembered in this component, and a second copy of that in the list
   * would be the one that silently disagreed.
   */
  autoSend: boolean
  /** The press has been acted on. Called whether or not the box could send. */
  onAutoSent: () => void
  /**
   * Resolves false when the turn was refused, so the box can put back what it
   * optimistically cleared.
   */
  onSend: (msg: {
    text: string
    attachments: Attachment[]
    mode: ChatMode
    effort: EffortLevel
  }) => Promise<boolean>
  onInterrupt: () => void
}) {
  /**
   * The box reads straight out of the draft store rather than keeping its own
   * copy. Component state is what evaporated a half-written message on every
   * reload, and a copy synced against the store would need to decide, on each
   * conversation switch, which of the two was the newer — a race with no right
   * answer. There is only one value, and it is the one that survives.
   */
  const draft = useDraft(draftKey)
  const text = draft?.text ?? ""
  const attachments = draft?.attachments ?? NOTHING_ATTACHED
  const edit = (patch: { text?: string; attachments?: Attachment[] }) =>
    saveDraft(draftKey, { text, attachments, ...patch })
  // Remembered, not reset. Picking Plan and then having the next page load put
  // you back on Auto is how a turn you meant to read first goes ahead and edits.
  // A stored value from before there were two modes fails `isChatMode` and falls
  // back here, which is the right answer: "manual" is not a mode any more.
  const [preferred, setPreferred] = useRemembered<ChatMode>("aide.chat.mode", "auto", isChatMode)
  const [effort, setEffort] = useRemembered<EffortLevel>("aide.chat.effort", "high", isEffort)
  /**
   * The mode this particular conversation was last driven at, which beats the
   * remembered preference while it is open — a chat you were running on Auto in
   * VS Code should not start asking permission just because you opened it here.
   *
   * Held apart from `preferred` rather than written into it, because inheriting
   * must not quietly change your default for every other conversation. Opening
   * one old Auto chat is not a decision to run everything on Auto.
   */
  const [inherited, setInherited] = useState<ChatMode | null>(null)
  const mode = inherited ?? preferred

  // Keyed on the session too: two conversations can carry the same mode, and
  // without the id the effect would not re-fire on the second one, leaving your
  // manual override from the first still in force.
  useEffect(() => {
    setInherited(inheritedMode)
  }, [sessionId, inheritedMode])

  // Choosing from the menu is a decision, so it both overrides the inherited
  // value and becomes the new default.
  const chooseMode = (m: ChatMode) => {
    setInherited(null)
    setPreferred(m)
  }
  const [note, setNote] = useState<string | null>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  useAutoGrow(area, text, { minRows: 2, maxRows: 12 })

  const canSend = !busy && !blocked && (text.trim().length > 0 || attachments.length > 0)

  const send = () => {
    if (!canSend) return
    const outgoing = { text: text.trim(), attachments }
    void onSend({ ...outgoing, mode, effort }).then((started) => {
      // A refused turn must not also swallow what it refused. The daemon turns
      // a chat away while another one has the repo, and with ▶ on a parked
      // chat the thing being cleared is the whole of a parked idea — one press
      // and it would be gone, with only a red line to say why.
      //
      // Skipped if anything has been typed since: the box is the newer of the
      // two, and putting back a message the human has already moved on from is
      // its own kind of loss.
      if (started) return
      const now = readDraft(draftKey)
      if (now.text === "" && now.attachments.length === 0) saveDraft(draftKey, outgoing)
    })
    edit({ text: "", attachments: [] })
    setNote(null)
  }

  /**
   * Send the one word without typing it.
   *
   * Live on an empty box, which is exactly when `send` is not: the two are
   * never both pressable, so whichever one is lit is the one that means
   * something. It deliberately will not fire over a box with something in it —
   * that press would have to either throw the typing away or leave it stranded
   * behind a turn it was not part of.
   *
   * Nothing is cleared, so unlike `send` there is nothing to put back when the
   * daemon refuses the turn; the rail says why, as it does for any refusal.
   */
  const canProceed = !busy && !blocked && text.trim().length === 0 && attachments.length === 0
  const proceed = () => {
    if (!canProceed) return
    void onSend({ text: PROCEED, attachments: [], mode, effort })
    setNote(null)
  }

  /**
   * The ▶ pressed on a parked chat, carried out.
   *
   * Consumed whether or not the box could send it: if this chat is held back —
   * an empty one, or uncommitted work in the way — the flag must not sit here
   * waiting to fire the moment the block clears, which would be a turn nobody
   * asked for at a moment nobody was looking.
   *
   * The ref is not belt and braces: StrictMode mounts effects twice, and
   * without it every ▶ would send the same message twice in development.
   *
   * No dependency array, deliberately. `send` closes over the box, the mode and
   * the effort, so a list of dependencies would either be all of them — which is
   * every render anyway — or a stale closure sending last render's message.
   */
  const acted = useRef(false)
  useEffect(() => {
    if (!autoSend) {
      acted.current = false
      return
    }
    if (acted.current) return
    acted.current = true
    onAutoSent()
    send()
  })

  const takeFiles = async (files: FileList | File[]) => {
    const images = [...files].filter((f) => f.type.startsWith("image/"))
    if (images.length === 0) return
    const tooBig = images.filter((f) => f.size > MAX_ATTACHMENT_BYTES)
    if (tooBig.length) setNote(`${tooBig.length} image(s) over ${kb(MAX_ATTACHMENT_BYTES)} skipped`)
    const read = await Promise.all(
      images.filter((f) => f.size <= MAX_ATTACHMENT_BYTES).map(readAsAttachment),
    )
    const added = read.filter((a): a is Attachment => a !== null)
    if (added.length === 0) return
    // Re-read the box rather than trusting what this closure captured: decoding
    // is async, so anything typed — or a second image pasted — while it ran
    // would be overwritten by the stale copy.
    const now = readDraft(draftKey)
    saveDraft(draftKey, { text: now.text, attachments: [...now.attachments, ...added] })
  }

  return (
    <div className="shrink-0 border-t border-line bg-chrome px-3 py-2">
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {attachments.map((a) => (
            <span
              key={a.id}
              className="flex items-center gap-1.5 rounded border border-line bg-input px-1.5 py-0.5 font-sans text-[11px] text-fg-muted"
            >
              <img
                src={`data:${a.mediaType};base64,${a.data}`}
                alt=""
                className="size-4 rounded-sm object-cover"
              />
              {a.mediaType.replace("image/", "")} {kb(a.bytes)}
              <button
                type="button"
                onClick={() => edit({ attachments: attachments.filter((x) => x.id !== a.id) })}
                className="text-fg-dim hover:text-err"
                title="Remove"
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      <textarea
        ref={area}
        value={text}
        onChange={(e) => edit({ text: e.target.value })}
        // Paste is the whole point of the attachment feature: a screenshot goes
        // straight from the clipboard into the turn, no file dialog.
        onPaste={(e) => {
          const files = [...e.clipboardData.files]
          if (files.some((f) => f.type.startsWith("image/"))) {
            e.preventDefault()
            void takeFiles(files)
          }
        }}
        onDrop={(e) => {
          if (e.dataTransfer.files.length) {
            e.preventDefault()
            void takeFiles(e.dataTransfer.files)
          }
        }}
        onKeyDown={(e) => {
          // Enter sends, Shift+Enter is a newline. This is a chat box, and the
          // multi-line case is the rarer one.
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            send()
          }
        }}
        // Height comes from useAutoGrow, which measures the wrapped text. The
        // row count this used to carry counted newlines, so a long message typed
        // as one paragraph stayed two rows tall and scrolled its own beginning
        // out of sight.
        rows={2}
        placeholder={
          busy ? "Claude is working…" : blocked ? "Commit first." : "Ask, or paste a screenshot"
        }
        className="w-full resize-none rounded border border-line-soft bg-input px-2 py-1.5 font-sans text-[13px] leading-relaxed outline-none placeholder:text-fg-dim focus:border-accent"
      />

      {blocked && <p className="mt-1 font-sans text-[11px] text-warn">{blocked}</p>}
      {note && <p className="mt-1 font-sans text-[11px] text-warn">{note}</p>}

      <div className="mt-1.5 flex items-center gap-3">
        <ModePicker mode={mode} effort={effort} onMode={chooseMode} onEffort={setEffort} />
        <ContextMeter usage={usage} />
        <div className="ml-auto flex items-center gap-2">
          {busy ? (
            <button
              type="button"
              onClick={onInterrupt}
              className="rounded-sm bg-diff-del-fg/85 px-2.5 py-1 font-sans text-xs text-white hover:bg-diff-del-fg"
            >
              stop
            </button>
          ) : (
            <>
              {/* Only on a conversation that has run. Before there is a
                  session there is nothing to carry on with, and the press
                  would be the chat's FIRST message — which is what names the
                  row, so a list of chats called "proceed" is a list of
                  nothing. */}
              {sessionId && (
                <button
                  type="button"
                  onClick={proceed}
                  disabled={!canProceed}
                  title={`Send “${PROCEED}” — for when the answer is just carry on`}
                  className="rounded-sm bg-input px-2.5 py-1 font-sans text-xs text-fg transition-colors hover:bg-raised disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {PROCEED}
                </button>
              )}
              <button
                type="button"
                onClick={send}
                disabled={!canSend}
                title="Enter to send, Shift+Enter for a newline"
                className="rounded-sm bg-accent px-3 py-1 font-sans text-xs text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
              >
                send
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
