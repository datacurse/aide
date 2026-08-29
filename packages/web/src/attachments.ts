import type { Attachment } from "@aide/protocol"

/**
 * A pasted image, turned into what the wire takes.
 *
 * Its own module and not a corner of `Composer.tsx`, for a reason that is about
 * the dev loop rather than the design: two boxes take screenshots — the composer
 * and the capture box in the chat list — so this had to be exported, and a
 * non-component export beside a component makes Fast Refresh give up on the
 * whole file. Every keystroke in the composer became a full page reload, which
 * threw away the open conversation and the scroll position you were looking at.
 */

/**
 * Pasted images are held in memory as base64 and sent with the turn. A 10MB
 * screenshot is already past what is useful to a model and would make the
 * request body enormous, so it is refused with a reason rather than silently
 * dropped.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

let attachmentSeq = 0

/** Strip the `data:image/png;base64,` prefix — the API wants the payload alone. */
function splitDataUrl(dataUrl: string): { mediaType: string; data: string } | null {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl)
  if (!match?.[1] || !match[2]) return null
  return { mediaType: match[1], data: match[2] }
}

/** Resolves null rather than throwing: one unreadable paste must not lose the rest. */
export function readAsAttachment(file: File): Promise<Attachment | null> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => {
      const parsed = typeof reader.result === "string" ? splitDataUrl(reader.result) : null
      if (!parsed) return resolve(null)
      attachmentSeq += 1
      resolve({
        id: `a${attachmentSeq}`,
        mediaType: parsed.mediaType,
        data: parsed.data,
        bytes: file.size,
      })
    }
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}
