import { useState } from "react"
import {
  CHAT_MODELS,
  CHAT_MODES,
  CHAT_MODE_LABEL,
  EFFORT_LEVELS,
} from "@aide/protocol"
import { useChatDefaults } from "./chatSettings.js"
import { useClickAway } from "./useClickAway.js"

/**
 * The defaults every chat starts on: mode, model, effort, thinking.
 *
 * In the rail's foot beside the daemon controls, because it is about aide
 * itself rather than about any one piece of work — the same reason the daemon
 * lives there. It edits the DEFAULTS and nothing else: a control changed in a
 * chat's own bar is filed under that chat and wins there, so nothing pressed
 * here reaches into a conversation that has already chosen. See
 * `chatSettings.ts` for the split and `resolveChatSettings` for who wins.
 *
 * Browser-held, like the values it edits — these configure the composer, which
 * is a browser control; the daemon's own fallback model is `AIDE_TASK_MODEL`
 * and is deliberately not what this writes.
 */
export function SettingsButton() {
  const [open, setOpen] = useState(false)
  const box = useClickAway(open, () => setOpen(false))
  const [defaults, patch] = useChatDefaults()

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="What every chat starts on — mode, model, effort, thinking. A chat's own bar overrides these for that chat alone."
        className={`text-[11px] underline-offset-2 hover:underline ${
          open ? "text-fg" : "text-fg-muted"
        }`}
      >
        settings
      </button>
      {open && (
        // Upwards and out over the panes, like the daemon log beside it:
        // anchored to the foot of a 16rem rail, a panel has nowhere else to go.
        <div className="absolute bottom-6 left-0 z-20 w-[21rem] rounded border border-line bg-chrome py-1 shadow-lg">
          <div className="px-3 py-1 text-[11px] text-fg-dim">Every chat starts on</div>

          <div className="flex flex-col gap-2 px-3 py-1.5">
            <Row name="mode">
              {CHAT_MODES.map((m) => (
                <Pill
                  key={m}
                  on={m === defaults.mode}
                  title={CHAT_MODE_LABEL[m].hint}
                  onClick={() => patch({ mode: m })}
                >
                  {CHAT_MODE_LABEL[m].label}
                </Pill>
              ))}
            </Row>
            <Row name="model">
              {CHAT_MODELS.map((m) => (
                <Pill
                  key={m.id}
                  on={m.id === defaults.model}
                  title={m.hint}
                  onClick={() => patch({ model: m.id })}
                >
                  {m.label}
                </Pill>
              ))}
            </Row>
            <Row name="effort">
              <input
                type="range"
                min={0}
                max={EFFORT_LEVELS.length - 1}
                value={EFFORT_LEVELS.indexOf(defaults.effort)}
                onChange={(e) => patch({ effort: EFFORT_LEVELS[Number(e.target.value)] ?? "high" })}
                className="flex-1 accent-accent"
              />
              <span className="w-12 text-right text-[11px] text-fg-dim">{defaults.effort}</span>
            </Row>
            <Row name="thinking">
              <Pill on={defaults.thinking} onClick={() => patch({ thinking: true })}>
                on
              </Pill>
              <Pill on={!defaults.thinking} onClick={() => patch({ thinking: false })}>
                off
              </Pill>
            </Row>
          </div>

          {/* The one sentence that stops these reading as another global: the
              old behaviour — one setting for every chat — is exactly what this
              panel exists to end. */}
          <p className="border-t border-line px-3 py-1.5 text-[11px] leading-relaxed text-fg-dim">
            A control changed in a chat&rsquo;s own bar wins for that chat, and that chat only.
          </p>
        </div>
      )}
    </div>
  )
}

function Row({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-[11px] text-fg-muted">{name}</span>
      <div className="flex flex-1 flex-wrap items-center gap-1">{children}</div>
    </div>
  )
}

function Pill({
  on,
  title,
  onClick,
  children,
}: {
  on: boolean
  title?: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`rounded px-2 py-0.5 text-[11px] ${
        on ? "bg-active text-white" : "bg-input text-fg-muted hover:bg-hover hover:text-fg"
      }`}
    >
      {children}
    </button>
  )
}
