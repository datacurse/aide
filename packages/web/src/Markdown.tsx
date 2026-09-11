import { memo } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"

/**
 * How every markdown element is rendered — and why this object is out here.
 *
 * It must never move back inside the component, and the reason is worth the
 * paragraph because the failure looks nothing like its cause. `react-markdown`
 * hands each value in this map straight through as the JSX element **type** for
 * the tag it names (`hast-util-to-jsx-runtime`: `state.components[name]`), and
 * React only reuses a DOM node when `elementType` matches by REFERENCE. Built
 * inline, these arrows are new function objects on every render, so every `<p>`,
 * `<code>`, `<strong>` and `<li>` in the transcript was a different type than it
 * had been a moment ago, and React deleted and rebuilt the lot.
 *
 * Nothing looked wrong: the words were identical each time. What broke was
 * selecting them. The DOM under a drag was destroyed roughly every 1.5 seconds —
 * the poll in App.tsx re-renders the tree — so the anchor fell back to the
 * nearest surviving ancestor and the highlight swallowed the whole message. It
 * cost three wrong fixes elsewhere before anyone looked here.
 *
 * Styled inline rather than through a typography plugin so it maps onto the
 * palette in index.css, which is the one file that documents where each colour
 * came from.
 */
const COMPONENTS: Components = {
  h1: ({ children }) => (
    <h1 className="mt-4 mb-2 text-base font-semibold text-fg first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-4 mb-2 text-[15px] font-semibold text-fg first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-3 mb-1.5 text-[13px] font-semibold text-fg first:mt-0">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-3 mb-1.5 text-[13px] font-semibold text-fg-muted first:mt-0">{children}</h4>
  ),
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-fg">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-accent underline underline-offset-2"
    >
      {children}
    </a>
  ),
  ul: ({ children }) => (
    <ul className="my-2 list-disc space-y-1 pl-5 first:mt-0 last:mb-0">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 list-decimal space-y-1 pl-5 first:mt-0 last:mb-0">{children}</ol>
  ),
  li: ({ children }) => <li className="pl-0.5">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-line-soft pl-3 text-fg-muted">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-line" />,
  // react-markdown gives `code` for both inline spans and fenced blocks;
  // a fenced one arrives wrapped in <pre>, so `pre` owns the scroll box
  // and this only has to style the text.
  code: ({ className, children }) => {
    const fenced = /language-/.test(className ?? "")
    if (fenced) {
      return <code className="font-mono text-xs text-fg">{children}</code>
    }
    return (
      // `break-all` rather than `break-words`: inline code is usually a
      // path or an identifier with no spaces to break at, and the point
      // is that it must never be the thing that widens the pane.
      <code className="rounded-sm bg-input px-1 py-0.5 font-mono text-[12px] break-all text-syn-string">
        {children}
      </code>
    )
  },
  // `max-w-none` escapes the reading measure `measured` puts on the prose. A
  // code block held to the prose column is the one place the measure is
  // actively wrong: it is read by scanning for structure rather than left to
  // right, and narrowing it only adds horizontal scrolling to lines that would
  // otherwise have fit. Harmless without `measured`, where nothing caps it.
  pre: ({ children }) => (
    <pre className="my-2 max-w-none overflow-x-auto rounded border border-line bg-chrome p-2.5 leading-relaxed">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    // Wide tables scroll inside their own box rather than widening the
    // pane, which would push the whole transcript sideways. `max-w-none` for
    // the same reason as `pre` — a table is columns to compare, not a measure
    // to read along.
    <div className="my-2 max-w-none overflow-x-auto">
      <table className="w-full border-collapse text-[12px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-line bg-chrome px-2 py-1 text-left font-semibold">{children}</th>
  ),
  td: ({ children }) => <td className="border border-line px-2 py-1 align-top">{children}</td>,
}

/** Hoisted for the same reason, though this one only costs a re-parse. */
const PLUGINS = [remarkGfm]

/**
 * Assistant output rendered as markdown, not as monospace source.
 *
 * Claude writes markdown. Showing it raw meant reading `##`, `**bold**` and
 * fenced code as literal characters, which is exactly the difference between a
 * transcript you skim and one you decode.
 *
 * `react-markdown` rather than a regex pass or `marked` + `innerHTML`: it builds
 * React elements and never sets HTML, which matters because a transcript is not
 * trusted content. Tool results carry file contents, and a file in someone's
 * repo can contain a `<script>` tag. There is no sanitizer to forget here
 * because there is no HTML path at all — raw HTML in the markdown renders as
 * text, which is the correct outcome for a code-review tool.
 *
 * `memo` because a transcript is hundreds of these and the app polls every 1.5
 * seconds: without it, every message on screen is re-parsed by remark on every
 * tick, forever, to produce the identical tree it produced last time.
 */
export const Markdown = memo(function Markdown({
  text,
  measured = false,
}: {
  text: string
  /**
   * Hold the prose to a reading measure. Opt-in, and the transcript is the only
   * caller that asks for it.
   *
   * The transcript is the flexible middle of a layout whose other three panes
   * are fixed (256 + 320 + 256 = 832px of chrome), so the prose is as wide as
   * the window minus that — ~88 characters per line at 1440px, ~160 at 1920 and
   * ~258 at 2560. The top of that range is three times the 45–75 character
   * measure that typography converges on, and it is the width at which the eye
   * loses the start of the next line on the return sweep.
   *
   * `MEASURE_PX` and not a `ch` value, though `ch` is the usual advice: `1ch` is
   * the width of the current font's `0`, which self-corrects when the font can
   * change. This one cannot — `--font-sans` is fixed in `index.css` — so `ch`
   * would buy nothing and cost the next reader the ability to tell what the
   * number means without computing it.
   *
   * It is NOT on by default, because the other caller is the profile dialog,
   * whose document is mostly tables and stat rows inside a 832px modal: capping
   * that is narrowing a document to 680px inside a box built to hold it.
   */
  measured?: boolean
}) {
  return (
    // `min-w-0` and `break-words` together are what keep a transcript inside its
    // pane. A long unbroken token — a Windows path, a flag, a URL — has no break
    // opportunity, so by default it widens its container rather than wrapping,
    // and the whole conversation gains a horizontal scrollbar because of one
    // line buried in it.
    <div
      className={`min-w-0 font-sans text-[13px] leading-relaxed break-words text-fg ${
        measured ? MEASURE_PX : ""
      }`}
    >
      <ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  )
})

/**
 * The reading measure, ~103 characters at 13px Segoe UI.
 *
 * Deliberately wider than the 66 characters typography would ask for, on two
 * counts that are about this transcript rather than about prose in general.
 * The text is dense technical writing full of inline `code`, paths and flags,
 * which is scanned for a name as often as it is read along. And it shares the
 * pane with tool rows, diffs and the timeline, which are full-width and
 * monospace — a 620px column of prose beside a full-width `pre` does not read
 * as a considered measure, it reads as a pane that failed to lay out.
 *
 * Under ~1500px of window it changes nothing: the pane is already narrower than
 * this, so the cap only engages on the wide screens that created the problem.
 */
const MEASURE_PX = "max-w-[680px]"
