import { useEffect, useRef, useState } from "react"
import { MAX_ATTACHMENT_BYTES, collectAttachments } from "./attachments.js"
import { useChatChoice, useChatDefaults } from "./chatSettings.js"
import { readDraft, saveDraft, useDraft } from "./drafts.js"
import { File as FileGlyph, Lightning, Lock, Paperclip, X } from "./icons.js"
import { Hint } from "./Hint.js"
import { ImageViewer, useImageViewer } from "./ImageViewer.js"
import { LOCKED } from "./ui.js"
import { TYPING_KEY } from "./typing.js"
import { useAutoGrow } from "./useAutoGrow.js"
import { useClickAway } from "./useClickAway.js"
import { useRemembered } from "./useRemembered.js"
import {
  CHAT_MODELS,
  CHAT_MODES,
  CHAT_MODE_LABEL,
  EFFORT_LEVELS,
  chatModelLabel,
  isImageAttachment,
  resolveChatSettings,
  type Attachment,
  type ChatMode,
  type ChatModel,
  type ContextUsage,
  type EffortLevel,
} from "@aide/protocol"

const kb = (bytes: number) =>
  bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`

const isBool = (v: unknown): v is boolean => typeof v === "boolean"

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
    <Hint
      hint={`${usage.totalTokens.toLocaleString()} of ${usage.maxTokens.toLocaleString()} tokens used`}
    >
      <span className={`flex items-center gap-1.5 text-[11px] ${tone}`}>
        <span className="relative inline-block h-1 w-10 overflow-hidden rounded-full bg-input">
          <span
            className="absolute inset-y-0 left-0 bg-current"
            style={{ width: `${Math.min(100, Math.max(0, remaining))}%` }}
          />
        </span>
        {Math.round(remaining)}% context left
      </span>
    </Hint>
  )
}

/**
 * Which model answers the turn.
 *
 * Its own button rather than a row inside the mode menu, and the reason is what
 * the two choices are. Mode and effort are about the SAME model being told how
 * to behave; this replaces it. It is also the control most likely to be changed
 * for one message and put back — a long mechanical edit sent to Sonnet, the next
 * question back on Opus — which is the argument the thinking toggle already
 * makes for living in the bar rather than behind a menu.
 *
 * It shows the label at all times, including the default. A picker that renders
 * as nothing until you touch it cannot answer the question you actually have,
 * which is "what is about to answer this" — and with a control that you
 * deliberately flip and mean to restore, a blank reading of "whatever it was
 * last time" is the state that sends an expensive turn to a cheap model.
 */
function ModelPicker({ model, onModel }: { model: ChatModel; onModel: (m: ChatModel) => void }) {
  const [open, setOpen] = useState(false)
  const box = useClickAway(open, () => setOpen(false))

  return (
    <div ref={box} className="relative">
      <Hint hint="Which model answers this turn">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-fg-muted hover:bg-hover hover:text-fg"
        >
          {chatModelLabel(model)}
        </button>
      </Hint>
      {open && (
        <div className="absolute bottom-7 left-0 z-20 w-[22rem] rounded border border-line bg-chrome py-1 shadow-lg">
          <div className="px-3 py-1 font-sans text-[11px] text-fg-dim">Model</div>
          {CHAT_MODELS.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => {
                onModel(m.id)
                setOpen(false)
              }}
              className={`flex w-full flex-col gap-0.5 px-3 py-1.5 text-left ${
                m.id === model ? "bg-active text-white" : "hover:bg-hover"
              }`}
            >
              <span className="font-sans text-[12px]">{m.label}</span>
              <span
                className={`font-sans text-[11px] ${m.id === model ? "text-white/70" : "text-fg-dim"}`}
              >
                {m.hint}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
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
  const box = useClickAway(open, () => setOpen(false))

  const label = CHAT_MODE_LABEL[mode].label

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-fg-muted hover:bg-hover hover:text-fg"
      >
        <Lightning className="size-3 shrink-0" />
        {label}
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
 * Thinking, on or off, in the one word it costs.
 *
 * Beside the mode picker rather than inside it, and struck through rather than
 * merely dimmed, because this is a switch you flip for one message and mean to
 * put back — a state hidden behind a menu is one you forget you left on, and
 * every fast answer after that is a fast answer you cannot account for.
 *
 * Italic, like a thought in the transcript, but in the bar's own colours rather
 * than the transcript's green: in a row of grey controls a coloured word reads
 * as a status somebody is telling you about, not as a switch you can press.
 */
function ThinkingToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <Hint
      hint={
        on
          ? "Thinking is on. Turn it off for a small ask, where the thinking is most of the wait and none of the work"
          : "Thinking is off — faster, and worse at anything it has to work out. The profile records which turns ran this way"
      }
    >
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={on}
        className={`rounded px-1.5 py-0.5 text-[11px] italic hover:bg-hover ${
          on ? "text-fg-muted hover:text-fg" : "text-fg-dim line-through hover:text-fg-muted"
        }`}
      >
        thinking
      </button>
    </Hint>
  )
}

/**
 * The reply revealed at a pace, or as fast as it arrives.
 *
 * Beside the thinking toggle, and shaped like it, because they are the same kind
 * of switch — one word, flipped for a message and meant to be put back. It is
 * the odd one out in this row all the same, and knowingly: everything else here
 * changes what the turn DOES, and this changes only how you watch it. It sits
 * here because this is where a person already goes to change how a turn feels,
 * and a preferences screen for one word would be a worse answer than the
 * inconsistency.
 *
 * Not struck through when off. Thinking off is a capability withheld and reads
 * correctly as an absence; typing off is the plain behaviour aide has always
 * had, and striking it out would frame the default as a deprivation.
 */
function TypingToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <Hint
      hint={
        on
          ? "The reply is revealed at a readable pace instead of in the bursts it arrives in. Click for raw speed."
          : "The reply appears as fast as it arrives. Click to have it typed out instead."
      }
    >
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={on}
        className={`rounded px-1.5 py-0.5 text-[11px] hover:bg-hover ${
          on ? "text-fg-muted hover:text-fg" : "text-fg-dim hover:text-fg-muted"
        }`}
      >
        typing
      </button>
    </Hint>
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
   * Why this box cannot send, or null.
   *
   * Two rules reach here, both the daemon's: one chat has the project's checkout
   * at a time, and one chat's work is committed before the next one starts. The
   * first is set on any conversation, the second only on one that has not
   * started. Stated here as well as in the rails either side — which is where
   * the things that clear it live — because the refusal has to be readable from
   * the box it applies to.
   */
  blocked: string | null
  /**
   * Send what is in the box the moment it appears, without being pressed.
   *
   * Set by the ▶ on a parked chat, which is one press for "open this and start
   * it". The send lives here rather than in the row because everything a turn
   * needs besides the text — the mode, the effort, whether it may think — is
   * remembered in this component, and a second copy of that in the list would
   * be the one that silently disagreed.
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
    thinking: boolean
    model: ChatModel
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
  /**
   * The defaults every chat starts on, and what THIS chat has picked over them.
   *
   * These four were one remembered value each, shared by every chat — switching
   * to Haiku for one deliberate turn quietly switched every other conversation
   * with it, and nothing on screen said so. A pick in this bar is now filed
   * under the chat's own key (the draft key, which survives the chat being
   * named — `carryDraft` moves the picks with the words), and a chat that has
   * picked nothing follows the defaults, which only the `settings` panel in the
   * rail's foot edits. Picking here changes nothing anywhere else, which is the
   * whole point.
   *
   * Still NOT read off the conversation itself. Thinking has nowhere to be read
   * from — the session store says nothing about it, and guessing from whether
   * the last turn produced a thought would be worse than not, since a turn that
   * thought about nothing looks identical to one that was not allowed to. The
   * model has somewhere (every assistant message names the model that wrote it)
   * and is not read on purpose: the chat's own pick already survives in the
   * choice store, so reading the transcript on top of it could only resurrect a
   * pick the human has since undone.
   */
  const [defaults] = useChatDefaults()
  const [chosen, choose] = useChatChoice(draftKey)
  /**
   * Unlike the settings above, this one is not sent anywhere. It is read by the
   * transcript, out of the same key, which is why it is not in `onSend`'s
   * message — a turn that ran while it was on is not a turn that differs. And
   * it is deliberately still global: how a reply is revealed is a reading
   * preference, not a property of a chat.
   */
  const [typewriter, setTypewriter] = useRemembered<boolean>(TYPING_KEY, false, isBool)
  /**
   * The mode this particular conversation was last driven at — a chat you were
   * running on Auto in VS Code should not start asking permission just because
   * you opened it here. It matters only for a chat with no pick of its own:
   * a pick made in this bar is explicit and may not have been sent yet, so it
   * outranks what the last turn happened to go out under.
   */
  const [inherited, setInherited] = useState<ChatMode | null>(null)
  /**
   * A mode the chat itself carries, which outranks everything.
   *
   * Only a chat aide composed has one — `survey` — and it is on the draft rather
   * than in a prop because the draft is the thing that survives: the button
   * creates the row, the app navigates to it, and this component may not mount
   * until a render later. A prop would have to be threaded from `App` through
   * the pane and would be gone on reload, which for a row you parked and came
   * back to is exactly when the mode still has to be right.
   *
   * It does NOT survive you picking a mode by hand: `chooseMode` writes the
   * chat's own pick and clears the draft's copy, because a picker that visibly
   * says Auto while the turn goes out on Plan is worse than either mode.
   */
  const composed = draft?.mode ?? null
  // Who wins is `resolveChatSettings`, in protocol, where `pnpm smoke:queue`
  // pins it — a precedence written inline here is one the wall's copy of this
  // component could quietly disagree with.
  const { mode, effort, thinking, model } = resolveChatSettings({
    composed,
    chosen,
    inherited,
    defaults,
  })

  // Keyed on the session too: two conversations can carry the same mode, and
  // without the id the effect would not re-fire on the second one, leaving your
  // manual override from the first still in force.
  useEffect(() => {
    setInherited(inheritedMode)
  }, [sessionId, inheritedMode])

  // Choosing from the menu is a decision about THIS chat: it overrides the
  // inherited value and is filed under the chat's own key — never written to
  // the defaults, which only the settings panel edits. It also drops the mode a
  // composed chat carried, or the picker would sit there reading Auto while the
  // turn went out on Plan. Yours is the last word on a chat you have opened.
  const chooseMode = (m: ChatMode) => {
    setInherited(null)
    choose({ mode: m })
    if (draft?.mode) saveDraft(draftKey, { text, attachments, mode: undefined })
  }
  const [note, setNote] = useState<string | null>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  useAutoGrow(area, text, { minRows: 2, maxRows: 12 })

  const canSend = !busy && !blocked && (text.trim().length > 0 || attachments.length > 0)

  const send = () => {
    if (!canSend) return
    const outgoing = { text: text.trim(), attachments }
    void onSend({ ...outgoing, mode, effort, thinking, model }).then((started) => {
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
    void onSend({ text: PROCEED, attachments: [], mode, effort, thinking, model })
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
   * No dependency array, deliberately. `send` closes over the box, the mode, the
   * effort, the model and the thinking toggle, so a list would either be all of
   * them — which is every render anyway — or a stale closure sending last
   * render's message.
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

  // Any file, not just images: an image goes to the model as a picture, and
  // everything else is written onto the agent's own disk with its path in the
  // message — the daemon draws that line, not this box.
  const takeFiles = async (files: FileList | File[]) => {
    const { added, skipped } = await collectAttachments(files)
    if (skipped) setNote(`${skipped} file(s) over ${kb(MAX_ATTACHMENT_BYTES)} skipped`)
    if (added.length === 0) return
    // Re-read the box rather than trusting what this closure captured: decoding
    // is async, so anything typed — or a second file dropped — while it ran
    // would be overwritten by the stale copy.
    const now = readDraft(draftKey)
    saveDraft(draftKey, { text: now.text, attachments: [...now.attachments, ...added] })
  }

  /**
   * Files land here from three doors — the clip button, a drop anywhere on the
   * bar, and paste — and all three walk through `takeFiles` above.
   *
   * The drop handlers live on the wrapper rather than the textarea so the whole
   * bar is the target: chips, controls and all, which is what a drag aimed at
   * "the prompt box" actually hits. `dragOver` only flips for drags carrying
   * files, or selecting text and waving it around would light the bar up over
   * a drop this box would ignore.
   */
  const picker = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)

  /**
   * The viewer indexes the PICTURES, not the attachments.
   *
   * A chip row can mix a screenshot with a zip, and paging through the set with
   * the arrow keys must not stop on something that has no picture to draw. So
   * the images are pulled out first and a chip looks up its own seat in that
   * list, which is also how a non-image chip decides to draw the file glyph
   * instead of a thumbnail.
   */
  const pictures = attachments.filter(isImageAttachment)
  const viewer = useImageViewer()

  return (
    <div
      className={`shrink-0 border-t border-line bg-chrome px-3 py-2 ${
        dragOver ? "outline-accent -outline-offset-2 outline-2 outline-dashed" : ""
      }`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return
        // preventDefault is what makes this a legal drop target at all — the
        // highlight is just saying so out loud.
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={(e) => {
        // Leaving for a child fires this too; only a real exit dims the bar.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        setDragOver(false)
      }}
      onDrop={(e) => {
        setDragOver(false)
        if (!e.dataTransfer.files.length) return
        e.preventDefault()
        void takeFiles(e.dataTransfer.files)
      }}
    >
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {attachments.map((a) => {
            // Only the picture opens the viewer, not the whole chip. The chip
            // already contains the remove button, and a button inside a button
            // is markup the browser fixes by dropping the INNER one — so the ✕
            // would go from visibly removing an attachment to silently doing
            // nothing.
            const seat = pictures.findIndex((p) => p.id === a.id)
            return (
              <span
                key={a.id}
                className="flex items-center gap-1.5 rounded border border-line bg-input px-1.5 py-0.5 font-sans text-[11px] text-fg-muted"
              >
                {seat >= 0 ? (
                  <Hint hint="See what this is, full size">
                    <button
                      type="button"
                      onClick={() => viewer.show(seat)}
                      className="cursor-zoom-in"
                    >
                      <img
                        src={`data:${a.mediaType};base64,${a.data}`}
                        alt=""
                        className="size-4 rounded-sm object-cover"
                      />
                    </button>
                  </Hint>
                ) : (
                  <FileGlyph className="size-3.5 shrink-0 text-fg-dim" />
                )}
                <span className="max-w-48 truncate">
                  {a.name ?? a.mediaType.replace("image/", "")}
                </span>
                {kb(a.bytes)}
                <Hint hint="Remove">
                  <button
                    type="button"
                    onClick={() => edit({ attachments: attachments.filter((x) => x.id !== a.id) })}
                    className="text-fg-dim hover:text-err"
                  >
                    <X className="size-3" />
                  </button>
                </Hint>
              </span>
            )
          })}
        </div>
      )}
      {viewer.open !== null && (
        <ImageViewer
          images={pictures}
          index={viewer.open}
          onIndex={viewer.show}
          onClose={viewer.close}
        />
      )}

      <textarea
        ref={area}
        value={text}
        onChange={(e) => edit({ text: e.target.value })}
        // Paste is the shortest path for a screenshot — clipboard straight into
        // the turn, no file dialog — and a file copied in the OS shell pastes
        // the same way. Drops are handled by the wrapper, whose dragOver made
        // them legal here in the first place.
        onPaste={(e) => {
          const files = [...e.clipboardData.files]
          if (files.length) {
            e.preventDefault()
            void takeFiles(files)
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
        // "Commit first" was right back when a commit was the only way out of a
        // block. It is not any more — a run holding the checkout clears by
        // finishing — and a placeholder naming the wrong remedy is worse than
        // one naming none, so it points at the sentence below instead.
        placeholder={
          busy
            ? "Claude is working…"
            : blocked
              ? "Held — the line below says why."
              : "Ask, or attach any kind of file — paste, drop, or the clip"
        }
        className="w-full resize-none rounded border border-line-soft bg-input px-2 py-1.5 font-sans text-[13px] leading-relaxed outline-none placeholder:text-fg-dim focus:border-accent"
      />

      {blocked && <p className="mt-1 font-sans text-[11px] text-warn">{blocked}</p>}
      {note && <p className="mt-1 font-sans text-[11px] text-warn">{note}</p>}

      <div className="mt-1.5 flex items-center gap-3">
        {/* The clip. The input is the machinery, the button is the furniture —
            a bare file input draws its own filename label, which this bar has
            chips for. Its value is cleared after every pick so choosing the
            same file twice fires onChange twice; the FileList is copied first
            because clearing the input empties the live list it handed over. */}
        <input
          ref={picker}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) void takeFiles([...e.target.files])
            e.target.value = ""
          }}
        />
        <Hint hint="Attach files of any kind — images go to the model as pictures, everything else lands on the agent's disk for it to read. Or drop them anywhere on this bar">
          <button
            type="button"
            onClick={() => picker.current?.click()}
            className="rounded p-1 text-fg-muted hover:bg-hover hover:text-fg"
          >
            <Paperclip className="size-3.5" />
          </button>
        </Hint>
        <ModePicker
          mode={mode}
          effort={effort}
          onMode={chooseMode}
          onEffort={(e) => choose({ effort: e })}
        />
        <ModelPicker model={model} onModel={(m) => choose({ model: m })} />
        <ThinkingToggle on={thinking} onToggle={() => choose({ thinking: !thinking })} />
        <TypingToggle on={typewriter} onToggle={() => setTypewriter(!typewriter)} />
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
                <Hint hint={blocked ?? `Send “${PROCEED}” — for when the answer is just carry on`}>
                  <button
                    type="button"
                    // Locked on the same terms as `send` beside it. It did not
                    // use to need this: `blocked` only ever landed on a chat
                    // that had never run, and this button is drawn only on one
                    // that has. A run holding the checkout refuses both, and
                    // two buttons side by side refused by one thing must not
                    // read as one blocked and one merely empty.
                    //
                    // `aria-disabled` rather than `disabled` when blocked, so
                    // the hint saying WHY still opens: a disabled element emits
                    // no `pointerenter`, so the one state whose explanation is
                    // worth reading would be the one state with no hint.
                    aria-disabled={blocked ? true : undefined}
                    onClick={blocked ? undefined : proceed}
                    disabled={blocked ? undefined : !canProceed}
                    className={`inline-flex items-center gap-1 rounded-sm px-2.5 py-1 font-sans text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                      blocked ? LOCKED : "bg-input text-fg hover:bg-raised"
                    }`}
                  >
                    {blocked && <Lock className="size-3 shrink-0" />}
                    {PROCEED}
                  </button>
                </Hint>
              )}
              <Hint hint={blocked ?? "Enter to send, Shift+Enter for a newline"}>
                <button
                  type="button"
                  // Locked by work in the way, merely disabled by an empty box.
                  // The distinction is the whole point of the padlock: one is
                  // something to go and clear, the other is something to type.
                  //
                  // Blocked is `aria-disabled` and not `disabled` so the hint
                  // naming what is in the way still opens — a disabled element
                  // emits no `pointerenter`, so the padlock would have nothing
                  // to explain itself with.
                  aria-disabled={blocked ? true : undefined}
                  onClick={blocked ? undefined : send}
                  disabled={blocked ? undefined : !canSend}
                  className={`inline-flex items-center gap-1 rounded-sm px-3 py-1 font-sans text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                    blocked ? LOCKED : "bg-accent text-white hover:bg-accent-hover"
                  }`}
                >
                  {blocked && <Lock className="size-3 shrink-0" />}
                  send
                </button>
              </Hint>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
