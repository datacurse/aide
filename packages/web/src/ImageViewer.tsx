import { useEffect, useState } from "react"
import { Button } from "./ui.js"

/**
 * The least an image needs to be shown.
 *
 * Structural rather than one of protocol's types, because the three places that
 * open this viewer hold three different records: the composer and the capture
 * box hold an `Attachment` (id, bytes, maybe a name), the transcript holds a
 * `MessageImage` (media type and bytes, and nothing else — a log written before
 * names existed keeps none). Naming either one here would make the other convert
 * at the call site, and a conversion is where a field silently stops being
 * passed.
 */
export interface ViewableImage {
  mediaType: string
  /** Base64, without the data: URL prefix. */
  data: string
  /** What to caption it with, when the record kept a name. */
  name?: string
}

/**
 * What you actually attached, at the size you attached it.
 *
 * The thumbnails in the composer, the capture box and the transcript are 16 to
 * 48 pixels tall — enough to say "an image is here", not enough to say WHICH
 * image, which is the question you have the moment you have pasted two
 * screenshots and want to know whether the second one replaced the first. So a
 * click opens the bytes full-size over the whole window.
 *
 * An overlay rather than growing the thumbnail in place, which is what the
 * transcript used to do. Growing in place is bounded by the pane it happens in —
 * a 1400px screenshot in a 500px column is still unreadable at `max-h-80` — and
 * it reflows the transcript under the reader, so the paragraph they were on
 * moves. The overlay borrows the window, shows the picture, and gives it back
 * with the page exactly where it was.
 *
 * It takes the WHOLE set rather than one image, because attachments arrive in
 * batches: two screenshots pasted together are compared by flicking between
 * them, and a viewer that closes to let you open the next one makes the
 * comparison you opened it for cost four clicks instead of one arrow key.
 */
export function ImageViewer({
  images,
  index,
  onIndex,
  onClose,
}: {
  images: ViewableImage[]
  /** Which one is showing. Clamped by the caller opening it on a real row. */
  index: number
  onIndex: (i: number) => void
  onClose: () => void
}) {
  const image = images[index]

  /**
   * Arrows and Escape are bound on the DOCUMENT, not on the overlay.
   *
   * The overlay's own `onKeyDown` — which is what `Profile` and `RemotePicker`
   * use — only fires while focus is inside it, and that holds for those two
   * because everything in them is focusable and the dialog itself takes focus on
   * mount. Here the one control worth reaching is a key rather than a button:
   * `autoFocus` on the backdrop puts focus in the right place on open, but a
   * click on the image (which is not focusable) moves focus to the body and the
   * arrows go dead — with nothing on screen changing to say why. A document
   * listener cannot lose focus it never had.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
      else if (e.key === "ArrowRight" && images.length > 1) onIndex((index + 1) % images.length)
      else if (e.key === "ArrowLeft" && images.length > 1)
        onIndex((index - 1 + images.length) % images.length)
      else return
      // Only for the keys actually handled: an unconditional preventDefault here
      // would swallow every other shortcut the app has while this is open.
      e.preventDefault()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [index, images.length, onIndex, onClose])

  // The set can shrink under the viewer — the composer's chips carry a remove
  // button, and the row behind this one may be the one that just went. Closing
  // is the honest answer; clamping would silently show a different picture than
  // the one that was open.
  useEffect(() => {
    if (!image) onClose()
  }, [image, onClose])
  if (!image) return null

  const caption = image.name ?? image.mediaType.replace("image/", "")

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/80 p-6"
      onClick={onClose}
      role="presentation"
    >
      <div className="flex shrink-0 items-center justify-between gap-3 pb-3">
        <p className="truncate font-sans text-xs text-fg-muted">
          {caption}
          {images.length > 1 && (
            <span className="ml-2 text-fg-dim">
              {index + 1} of {images.length}
            </span>
          )}
        </p>
        <div className="flex shrink-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          {images.length > 1 && (
            <>
              <Button
                onClick={() => onIndex((index - 1 + images.length) % images.length)}
                title="Previous — or the left arrow key"
              >
                prev
              </Button>
              <Button
                onClick={() => onIndex((index + 1) % images.length)}
                title="Next — or the right arrow key"
              >
                next
              </Button>
            </>
          )}
          <Button onClick={onClose} title="Close — or Escape, or click anywhere">
            close
          </Button>
        </div>
      </div>

      {/* `object-contain` in a flexed box rather than `max-w-full max-h-full` on
          the image: the latter measures against the FLEX ITEM, which for an
          image in a column is its own content size, so a tall screenshot pushed
          the header off the top of the window instead of shrinking. */}
      <img
        src={`data:${image.mediaType};base64,${image.data}`}
        alt={caption}
        // A click on the picture is not a click on the backdrop. Closing on it
        // would make "look closer at this bit" the gesture that dismisses the
        // thing you are looking at.
        onClick={(e) => e.stopPropagation()}
        className="min-h-0 w-full flex-1 object-contain"
      />
    </div>
  )
}

/**
 * The state three call sites would otherwise each keep: which image is open, or
 * none.
 *
 * A hook rather than three copies of `useState<number | null>`, because the
 * closing rule is the part that is easy to get subtly different — and the
 * transcript already had it wrong in the way one shared piece prevents. Its zoom
 * was a single boolean per ROW, so clicking one of two attached screenshots
 * expanded both of them, side by side and each half the size it needed.
 */
export function useImageViewer() {
  const [open, setOpen] = useState<number | null>(null)
  return { open, show: setOpen, close: () => setOpen(null) }
}
