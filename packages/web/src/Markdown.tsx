import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

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
 * Styled inline rather than through a typography plugin so it maps onto the
 * palette in index.css, which is the one file that documents where each colour
 * came from.
 */
export function Markdown({ text }: { text: string }) {
  return (
    // `min-w-0` and `break-words` together are what keep a transcript inside its
    // pane. A long unbroken token — a Windows path, a flag, a URL — has no break
    // opportunity, so by default it widens its container rather than wrapping,
    // and the whole conversation gains a horizontal scrollbar because of one
    // line buried in it.
    <div className="min-w-0 font-sans text-[13px] leading-relaxed break-words text-fg">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
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
            <h4 className="mt-3 mb-1.5 text-[13px] font-semibold text-fg-muted first:mt-0">
              {children}
            </h4>
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
          pre: ({ children }) => (
            <pre className="my-2 max-w-full overflow-x-auto rounded border border-line bg-chrome p-2.5 leading-relaxed">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            // Wide tables scroll inside their own box rather than widening the
            // pane, which would push the whole transcript sideways.
            <div className="my-2 overflow-x-auto">
              <table className="w-full border-collapse text-[12px]">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-line bg-chrome px-2 py-1 text-left font-semibold">
              {children}
            </th>
          ),
          td: ({ children }) => <td className="border border-line px-2 py-1 align-top">{children}</td>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
