/**
 * Icons, drawn inline.
 *
 * Phosphor's geometry, not Phosphor's package. `@phosphor-icons/react` is nine
 * thousand components and a build-time dependency to render the dozen below, in
 * a web package that has four dependencies and a rule about adding a fifth. The
 * paths are MIT-licensed and are copied verbatim from the regular weight, so
 * they can be checked against the real thing rather than eyeballed — each one is
 * `assets/regular/<the phosphor name>.svg` in `phosphor-icons/core`.
 *
 * `currentColor` and no explicit size: these are pieces of text, and every place
 * that uses one has already decided what colour it is and how big.
 *
 * Which is also why call sites nudge them downwards — `translate-y-[0.15em]` in
 * a flex row, `align-[-0.15em]` in flowing text. An SVG is a replaced element,
 * so the browser puts its BOTTOM edge on the text baseline; left alone, every
 * marker in the transcript floats a couple of pixels above the line it belongs
 * to. `translate` rather than a margin, so the nudge cannot change a layout.
 */
function Icon({ d, className }: { d: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 256 256"
      fill="currentColor"
      className={className}
      // Decorative, all of them. The sentence saying WHY a control is locked, or
      // what a marker means, is on the row's own title and, for the ones that
      // matter, written out beside it — so a screen reader announcing "lock"
      // here would be reading the icon instead of the reason.
      aria-hidden="true"
      focusable="false"
    >
      <path d={d} />
    </svg>
  )
}

type IconProps = { className?: string }

/** `lock-simple`, not `lock`: at 12px the keyhole on the full one is a smudge. */
export function Lock({ className }: IconProps) {
  return (
    <Icon
      className={className}
      d="M208,80H176V56a48,48,0,0,0-96,0V80H48A16,16,0,0,0,32,96V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V96A16,16,0,0,0,208,80ZM96,56a32,32,0,0,1,64,0V80H96ZM208,208H48V96H208V208Z"
    />
  )
}

export function Play({ className }: IconProps) {
  return (
    <Icon
      className={className}
      d="M232.4,114.49,88.32,26.35a16,16,0,0,0-16.2-.3A15.86,15.86,0,0,0,64,39.87V216.13A15.94,15.94,0,0,0,80,232a16.07,16.07,0,0,0,8.36-2.35L232.4,141.51a15.81,15.81,0,0,0,0-27ZM80,215.94V40l143.83,88Z"
    />
  )
}

export function Check({ className }: IconProps) {
  return (
    <Icon
      className={className}
      d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z"
    />
  )
}

export function X({ className }: IconProps) {
  return (
    <Icon
      className={className}
      d="M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z"
    />
  )
}

export function ArrowUp({ className }: IconProps) {
  return (
    <Icon
      className={className}
      d="M205.66,117.66a8,8,0,0,1-11.32,0L136,59.31V216a8,8,0,0,1-16,0V59.31L61.66,117.66a8,8,0,0,1-11.32-11.32l72-72a8,8,0,0,1,11.32,0l72,72A8,8,0,0,1,205.66,117.66Z"
    />
  )
}

export function ArrowDown({ className }: IconProps) {
  return (
    <Icon
      className={className}
      d="M205.66,149.66l-72,72a8,8,0,0,1-11.32,0l-72-72a8,8,0,0,1,11.32-11.32L120,196.69V40a8,8,0,0,1,16,0V196.69l58.34-58.35a8,8,0,0,1,11.32,11.32Z"
    />
  )
}

export function ArrowClockwise({ className }: IconProps) {
  return (
    <Icon
      className={className}
      d="M240,56v48a8,8,0,0,1-8,8H184a8,8,0,0,1,0-16H211.4L184.81,71.64l-.25-.24a80,80,0,1,0-1.67,114.78,8,8,0,0,1,11,11.63A95.44,95.44,0,0,1,128,224h-1.32A96,96,0,1,1,195.75,60L224,85.8V56a8,8,0,1,1,16,0Z"
    />
  )
}

export function Lightning({ className }: IconProps) {
  return (
    <Icon
      className={className}
      d="M215.79,118.17a8,8,0,0,0-5-5.66L153.18,90.9l14.66-73.33a8,8,0,0,0-13.69-7l-112,120a8,8,0,0,0,3,13l57.63,21.61L88.16,238.43a8,8,0,0,0,13.69,7l112-120A8,8,0,0,0,215.79,118.17ZM109.37,214l10.47-52.38a8,8,0,0,0-5-9.06L62,132.71l84.62-90.66L136.16,94.43a8,8,0,0,0,5,9.06l52.8,19.8Z"
    />
  )
}

export function Tag({ className }: IconProps) {
  return (
    <Icon
      className={className}
      d="M243.31,136,144,36.69A15.86,15.86,0,0,0,132.69,32H40a8,8,0,0,0-8,8v92.69A15.86,15.86,0,0,0,36.69,144L136,243.31a16,16,0,0,0,22.63,0l84.68-84.68a16,16,0,0,0,0-22.63Zm-96,96L48,132.69V48h84.69L232,147.31ZM96,84A12,12,0,1,1,84,72,12,12,0,0,1,96,84Z"
    />
  )
}

/** The bullet on a run's last line. Its colour is the outcome; this is the dot. */
export function Circle({ className }: IconProps) {
  return (
    <Icon
      className={className}
      d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Z"
    />
  )
}

/** A node on a line, which is what the rail's graph draws a commit as too. */
export function GitCommit({ className }: IconProps) {
  return (
    <Icon
      className={className}
      d="M248,120H183.42a56,56,0,0,0-110.84,0H8a8,8,0,0,0,0,16H72.58a56,56,0,0,0,110.84,0H248a8,8,0,0,0,0-16ZM128,168a40,40,0,1,1,40-40A40,40,0,0,1,128,168Z"
    />
  )
}

export function Warning({ className }: IconProps) {
  return (
    <Icon
      className={className}
      d="M236.8,188.09,149.35,36.22h0a24.76,24.76,0,0,0-42.7,0L19.2,188.09a23.51,23.51,0,0,0,0,23.72A24.35,24.35,0,0,0,40.55,224h174.9a24.35,24.35,0,0,0,21.33-12.19A23.51,23.51,0,0,0,236.8,188.09ZM222.93,203.8a8.5,8.5,0,0,1-7.48,4.2H40.55a8.5,8.5,0,0,1-7.48-4.2,7.59,7.59,0,0,1,0-7.72L120.52,44.21a8.75,8.75,0,0,1,15,0l87.45,151.87A7.59,7.59,0,0,1,222.93,203.8ZM120,144V104a8,8,0,0,1,16,0v40a8,8,0,0,1-16,0Zm20,36a12,12,0,1,1-12-12A12,12,0,0,1,140,180Z"
    />
  )
}

/**
 * The four fields a turn writes about itself, as glyphs.
 *
 * These replaced the words `did` / `next` / `why` / `risk` in a label column.
 * Four repeated words down a list of cards is a lot of ink spent on furniture,
 * and at this size an icon is read as a category faster than a word is read as a
 * word — but only if the four are unmistakable from each other, which is what
 * picked these rather than the more literal options.
 *
 * `check-circle` for what happened, `arrow-right` for what to do next,
 * `lightbulb` for why, `warning-circle` for what to watch. The last two are
 * deliberately different OUTLINES — a bulb and a circle — because at 14px a
 * reader tells them apart by silhouette before colour, and two round glyphs
 * would need the colour to do the work the shape should.
 *
 * Every field also keeps its word on the row's `title`, so the legend is one
 * hover away rather than something to be memorised.
 */
export function CheckCircle({ className }: IconProps) {
  return (
    <Icon
      className={className}
      d="M173.66,98.34a8,8,0,0,1,0,11.32l-56,56a8,8,0,0,1-11.32,0l-24-24a8,8,0,0,1,11.32-11.32L112,148.69l50.34-50.35A8,8,0,0,1,173.66,98.34ZM232,128A104,104,0,1,1,128,24,104.11,104.11,0,0,1,232,128Zm-16,0a88,88,0,1,0-88,88A88.1,88.1,0,0,0,216,128Z"
    />
  )
}

export function ArrowRight({ className }: IconProps) {
  return (
    <Icon
      className={className}
      d="M221.66,133.66l-72,72a8,8,0,0,1-11.32-11.32L196.69,136H40a8,8,0,0,1,0-16H196.69L138.34,61.66a8,8,0,0,1,11.32-11.32l72,72A8,8,0,0,1,221.66,133.66Z"
    />
  )
}

export function Lightbulb({ className }: IconProps) {
  return (
    <Icon
      className={className}
      d="M176,232a8,8,0,0,1-8,8H88a8,8,0,0,1,0-16h80A8,8,0,0,1,176,232Zm40-128a87.55,87.55,0,0,1-33.64,69.21A16.24,16.24,0,0,0,176,186v6a16,16,0,0,1-16,16H96a16,16,0,0,1-16-16v-6a16,16,0,0,0-6.23-12.66A87.59,87.59,0,0,1,40,104.49C39.74,56.83,78.26,17,125.88,16A88,88,0,0,1,216,104Zm-16,0a72,72,0,0,0-73.74-72c-39,.79-70.47,33.42-70.26,72.75a71.61,71.61,0,0,0,27.64,56.3A32,32,0,0,1,96,186v6h64v-6a32.12,32.12,0,0,1,12.47-25.35A71.65,71.65,0,0,0,200,104Z"
    />
  )
}

export function WarningCircle({ className }: IconProps) {
  return (
    <Icon
      className={className}
      d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm-8-80V80a8,8,0,0,1,16,0v56a8,8,0,0,1-16,0Zm20,36a12,12,0,1,1-12-12A12,12,0,0,1,140,172Z"
    />
  )
}

export function Minus({ className }: IconProps) {
  return (
    <Icon
      className={className}
      d="M224,128a8,8,0,0,1-8,8H40a8,8,0,0,1,0-16H216A8,8,0,0,1,224,128Z"
    />
  )
}

/**
 * A column the wall is not drawing.
 *
 * `eye-slash` on the control that hides one and `eye` on the one that brings it
 * back — two shapes rather than one toggling its own meaning, because the button
 * that reveals lives in a different place from the button that hides (the wall's
 * header, not the column's) and they are never on screen saying opposite things
 * about the same project.
 *
 * It sits beside `forget`'s ✕ in the same header, which is the reason it is not
 * a ✕ of its own or a `Minus`: those read as removal, and the whole point of
 * hiding is that it takes nothing away. A struck-through eye is the one shape at
 * 12px that says "not being shown" rather than "gone".
 */
export function EyeSlash({ className }: IconProps) {
  return (
    <Icon
      className={className}
      d="M53.92,34.62A8,8,0,1,0,42.08,45.38L61.32,66.55C25,88.84,9.38,123.2,8.69,124.76a8,8,0,0,0,0,6.5c.35.79,8.82,19.57,27.65,38.4C61.43,194.74,93.12,208,128,208a127.11,127.11,0,0,0,52.07-10.83l22,24.21a8,8,0,1,0,11.84-10.76Zm47.33,75.84,41.67,45.85a32,32,0,0,1-41.67-45.85ZM128,192c-30.78,0-57.67-11.19-79.93-33.25A133.16,133.16,0,0,1,25,128c4.69-8.79,19.66-33.39,47.35-49.38l18,19.75a48,48,0,0,0,63.66,70l14.73,16.2A112,112,0,0,1,128,192Zm6-95.43a8,8,0,0,1,3-15.72,48.16,48.16,0,0,1,38.77,42.72,8,8,0,0,1-7.22,8.71,6.39,6.39,0,0,1-.75,0,8,8,0,0,1-8-7.26A32.09,32.09,0,0,0,134,96.57Zm113.28,34.69c-.42.94-10.55,23.37-33.36,43.8a8,8,0,1,1-10.67-11.92A132.77,132.77,0,0,0,231,128c-4.69-8.79-19.66-33.39-47.35-49.38l-18,19.75A48,48,0,0,0,128,80a49.14,49.14,0,0,0-7.55.58l-11-12.09A128.6,128.6,0,0,1,128,64c34.88,0,66.57,13.26,91.66,38.35,18.83,18.83,27.3,37.62,27.65,38.41A8,8,0,0,1,247.31,131.26Z"
    />
  )
}

/** `eye`, for the control that brings a hidden column back. */
export function Eye({ className }: IconProps) {
  return (
    <Icon
      className={className}
      d="M247.31,124.76c-.35-.79-8.82-19.58-27.65-38.41C194.57,61.26,162.88,48,128,48S61.43,61.26,36.34,86.35C17.51,105.18,9,124,8.69,124.76a8,8,0,0,0,0,6.5c.35.79,8.82,19.57,27.65,38.4C61.43,194.74,93.12,208,128,208s66.57-13.26,91.66-38.34c18.83-18.83,27.3-37.61,27.65-38.4A8,8,0,0,0,247.31,124.76ZM128,192c-30.78,0-57.67-11.19-79.93-33.25A133.47,133.47,0,0,1,25,128,133.33,133.33,0,0,1,48.07,97.25C70.33,75.19,97.22,64,128,64s57.67,11.19,79.93,33.25A133.46,133.46,0,0,1,231.05,128C223.84,141.46,192.43,192,128,192Zm0-112a48,48,0,1,0,48,48A48.05,48.05,0,0,0,128,80Zm0,80a32,32,0,1,1,32-32A32,32,0,0,1,128,160Z"
    />
  )
}

/**
 * Whether a folder in the tree is open, as one icon that turns.
 *
 * `caret-right`, rotated 90° by the call site, rather than Phosphor's separate
 * `caret-down`. Two paths would be two shapes swapping at the moment of a click,
 * and a rotation is the one thing here that can be animated into a state change
 * rather than replaced by it.
 */
export function CaretRight({ className }: IconProps) {
  return (
    <Icon
      className={className}
      d="M181.66,133.66l-80,80a8,8,0,0,1-11.32-11.32L164.69,128,90.34,53.66a8,8,0,0,1,11.32-11.32l80,80A8,8,0,0,1,181.66,133.66Z"
    />
  )
}

export function Folder({ className }: IconProps) {
  return (
    <Icon
      className={className}
      d="M216,72H131.31L104,44.69A15.86,15.86,0,0,0,92.69,40H40A16,16,0,0,0,24,56V200.62A15.4,15.4,0,0,0,39.38,216H216.89A15.13,15.13,0,0,0,232,200.89V88A16,16,0,0,0,216,72ZM40,56H92.69l16,16H40ZM216,200H40V88H216Z"
    />
  )
}

/** `file`, for a leaf. Deliberately not `file-text`: at 12px the ruled lines fill it in. */
export function File({ className }: IconProps) {
  return (
    <Icon
      className={className}
      d="M213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34ZM160,51.31,188.69,80H160ZM200,216H56V40h88V88a8,8,0,0,0,8,8h48V216Z"
    />
  )
}

// ---------------------------------------------------------------------------
// What KIND of file — the tree's gutter
//
// Phosphor again, and the same rule: the shape has to survive 12px in a 16rem
// column. That rules out the obvious pick for most of these, which is a page
// with something drawn ON it — at this size the page's outline eats the detail
// and every one of them becomes the same grey rectangle. So these are the
// SYMBOL alone, no page around it, which is also how Seti draws its own.
//
// The set is deliberately small. A pack has a glyph per language and spends
// thousands of shapes doing it; what a tree actually has to answer is "code,
// config, words, or a picture", and one distinguishable shape per ANSWER beats
// forty that are indistinguishable at the size they render. Colour carries the
// language — see `filetypes.ts`.
// ---------------------------------------------------------------------------

/** `brackets-angle`. Markup and anything that reads as a tag. */
export function CodeTag({ className }: IconProps) {
  return (
    <Icon
      className={className}
      d="M79.39,204.87A8,8,0,0,1,68.61,208C66.44,206.85,16,178.83,16,128S66.44,49.15,68.61,48a8,8,0,0,1,7.5,14.13C75.66,62.37,32,86.72,32,128s43.66,65.63,44.11,65.87A8,8,0,0,1,79.39,204.87Zm108,3.16c2.17-1.18,52.61-29.2,52.61-80s-50.44-78.82-52.61-80a8,8,0,0,0-7.5,14.13c.45.24,44.11,24.59,44.11,65.87s-43.66,65.63-44.11,65.87a8,8,0,0,0,7.5,14.13Z"
    />
  )
}

/** `code-simple` — a pair of chevrons. Source files: the thing you came to read. */
export function CodeGlyph({ className }: IconProps) {
  return (
    <Icon
      className={className}
      d="M69.12,94.15,28.5,128l40.62,33.85a8,8,0,1,1-10.24,12.29l-48-40a8,8,0,0,1,0-12.29l48-40a8,8,0,0,1,10.24,12.3Zm176,27.7-48-40a8,8,0,1,0-10.24,12.3L227.5,128l-40.62,33.85a8,8,0,1,0,10.24,12.29l48-40a8,8,0,0,0,0-12.29ZM162.73,32.48a8,8,0,0,0-10.25,4.79l-64,176a8,8,0,0,0,4.79,10.26A8.14,8.14,0,0,0,96,224a8,8,0,0,0,7.52-5.27l64-176A8,8,0,0,0,162.73,32.48Z"
    />
  )
}

/** `gear-six`. Config, lockfiles, dotfiles — the machinery, not the work. */
export function Gear({ className }: IconProps) {
  return (
    <Icon
      className={className}
      d="M128,80a48,48,0,1,0,48,48A48.05,48.05,0,0,0,128,80Zm0,80a32,32,0,1,1,32-32A32,32,0,0,1,128,160Zm88-29.84q.06-2.16,0-4.32l14.92-18.64a8,8,0,0,0,1.48-7.06,107.21,107.21,0,0,0-10.88-26.25,8,8,0,0,0-6-3.93l-23.72-2.64q-1.48-1.56-3-3L186,40.54a8,8,0,0,0-3.94-6,107.71,107.71,0,0,0-26.25-10.87,8,8,0,0,0-7.06,1.49L130.16,40Q128,40,125.84,40L107.2,25.11a8,8,0,0,0-7.06-1.48A107.6,107.6,0,0,0,73.89,34.51a8,8,0,0,0-3.93,6L67.32,64.27q-1.56,1.49-3,3L40.54,70a8,8,0,0,0-6,3.94,107.71,107.71,0,0,0-10.87,26.25,8,8,0,0,0,1.49,7.06L40,125.84Q40,128,40,130.16L25.11,148.8a8,8,0,0,0-1.48,7.06,107.21,107.21,0,0,0,10.88,26.25,8,8,0,0,0,6,3.93l23.72,2.64q1.49,1.56,3,3L70,215.46a8,8,0,0,0,3.94,6,107.71,107.71,0,0,0,26.25,10.87,8,8,0,0,0,7.06-1.49L125.84,216q2.16.06,4.32,0l18.64,14.92a8,8,0,0,0,7.06,1.48,107.21,107.21,0,0,0,26.25-10.88,8,8,0,0,0,3.93-6l2.64-23.72q1.56-1.48,3-3L215.46,186a8,8,0,0,0,6-3.94,107.71,107.71,0,0,0,10.87-26.25,8,8,0,0,0-1.49-7.06Zm-16.1-6.5a73.93,73.93,0,0,1,0,8.68,8,8,0,0,0,1.74,5.48l14.19,17.73a91.57,91.57,0,0,1-6.23,15L187,173.11a8,8,0,0,0-5.1,2.64,74.11,74.11,0,0,1-5.86,5.86,8,8,0,0,0-2.64,5.1l-2.51,22.58a91.32,91.32,0,0,1-15,6.23L138.14,201.3a8,8,0,0,0-5-1.74h-.48a73.93,73.93,0,0,1-8.68,0,8,8,0,0,0-5.48,1.74L100.77,215.5a91.57,91.57,0,0,1-15-6.23L83.3,186.69a8,8,0,0,0-2.64-5.1,74.11,74.11,0,0,1-5.86-5.86,8,8,0,0,0-5.1-2.64L47.12,170.58a91.32,91.32,0,0,1-6.23-15L55.08,137.8a8,8,0,0,0,1.74-5.48,73.93,73.93,0,0,1,0-8.68,8,8,0,0,0-1.74-5.48L40.89,100.43a91.57,91.57,0,0,1,6.23-15l22.58-2.51a8,8,0,0,0,5.1-2.64,74.11,74.11,0,0,1,5.86-5.86A8,8,0,0,0,83.3,69.31L85.81,46.73a91.32,91.32,0,0,1,15-6.23l17.73,14.19a8,8,0,0,0,5.48,1.74,73.93,73.93,0,0,1,8.68,0,8,8,0,0,0,5.48-1.74L155.57,40.5a91.57,91.57,0,0,1,15,6.23l2.51,22.58a8,8,0,0,0,2.64,5.1,74.11,74.11,0,0,1,5.86,5.86,8,8,0,0,0,5.1,2.64l22.58,2.51a91.32,91.32,0,0,1,6.23,15L201.3,117.86A8,8,0,0,0,199.56,123.34Z"
    />
  )
}

/** `article`. Prose — markdown, a licence, a plain text note. */
export function Article({ className }: IconProps) {
  return (
    <Icon
      className={className}
      d="M88,104a8,8,0,0,1,8-8h64a8,8,0,0,1,0,16H96A8,8,0,0,1,88,104Zm8,40h64a8,8,0,0,0,0-16H96a8,8,0,0,0,0,16ZM232,56V184a24,24,0,0,1-24,24H32A24,24,0,0,1,8,184.4V152a8,8,0,0,1,16,0v32a8,8,0,0,0,16,0V56A16,16,0,0,1,56,40H216A16,16,0,0,1,232,56ZM55.4,192H208a8,8,0,0,0,8-8V56H56V184A23.84,23.84,0,0,1,55.4,192Z"
    />
  )
}

/** `image`. Every picture format, because which one it is is not the question. */
export function Image({ className }: IconProps) {
  return (
    <Icon
      className={className}
      d="M216,40H40A16,16,0,0,0,24,56V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40Zm0,16V158.75l-26.07-26.07a16,16,0,0,0-22.63,0l-20,20-44-44a16,16,0,0,0-22.62,0L40,149.37V56ZM40,172l52-52,80,80H40Zm176,28H194.63l-36-36,20-20L216,181.38V200ZM144,100a12,12,0,1,1,12,12A12,12,0,0,1,144,100Z"
    />
  )
}

/** `database`. Data that is read as rows rather than as text: SQL, csv. */
export function Database({ className }: IconProps) {
  return (
    <Icon
      className={className}
      d="M128,24C74.17,24,32,48.6,32,80v96c0,31.4,42.17,56,96,56s96-24.6,96-56V80C224,48.6,181.83,24,128,24Zm80,104c0,9.62-7.88,19.43-21.61,26.92C170.93,163.35,150.19,168,128,168s-42.93-4.65-58.39-13.08C55.88,147.43,48,137.62,48,128V111.36c17.06,15,46.23,24.64,80,24.64s62.94-9.68,80-24.64ZM69.61,53.08C85.07,44.65,105.81,40,128,40s42.93,4.65,58.39,13.08C200.12,60.57,208,70.38,208,80s-7.88,19.43-21.61,26.92C170.93,115.35,150.19,120,128,120s-42.93-4.65-58.39-13.08C55.88,99.43,48,89.62,48,80S55.88,60.57,69.61,53.08ZM186.39,202.92C170.93,211.35,150.19,216,128,216s-42.93-4.65-58.39-13.08C55.88,195.43,48,185.62,48,176V159.36c17.06,15,46.23,24.64,80,24.64s62.94-9.68,80-24.64V176C208,185.62,200.12,195.43,186.39,202.92Z"
    />
  )
}

/** `paint-brush`. Stylesheets — the one kind of source that is not logic. */
export function Brush({ className }: IconProps) {
  return (
    <Icon
      className={className}
      d="M225.94,49.94a8,8,0,0,0-11.32,0l-.06.06C201.3,63.22,183.66,72,164.61,79.2a119.06,119.06,0,0,0-27.35-19.6C152.6,45.68,169.6,32,192,32a8,8,0,0,0,0-16c-33.86,0-57.35,23.8-72.6,40.94A87.85,87.85,0,0,0,104,56a88.1,88.1,0,0,0-88,88c0,31.4-9.42,45.11-13.1,49.5A8,8,0,0,0,8,208H104a88.1,88.1,0,0,0,88-88,87.85,87.85,0,0,0-1.06-13.53c17.16-15.25,41-38.74,41-72.53A8,8,0,0,0,225.94,49.94ZM104,192H26.34C31.63,180.83,40,161.34,40,144a72,72,0,1,1,72,72Zm-8-56a12,12,0,1,1-12-12A12,12,0,0,1,96,136Z"
    />
  )
}

/** `package`. Manifests and lockfiles — what the project is made OF. */
export function Package({ className }: IconProps) {
  return (
    <Icon
      className={className}
      d="M223.68,66.15,135.68,18a15.88,15.88,0,0,0-15.36,0l-88,48.15a16,16,0,0,0-8.32,14v95.64a16,16,0,0,0,8.32,14l88,48.17a15.88,15.88,0,0,0,15.36,0l88-48.17a16,16,0,0,0,8.32-14V80.18A16,16,0,0,0,223.68,66.15ZM128,32l80.34,44-29.77,16.3-80.35-44ZM128,120,47.66,76l33.9-18.56,80.34,44ZM40,90l80,43.78v85.79L40,175.82Zm176,85.78h0l-80,43.79V133.82l32-17.51V152a8,8,0,0,0,16,0V107.55L216,90v85.77Z"
    />
  )
}

/** `terminal-window`. Shell scripts, and anything else you run rather than import. */
export function Terminal({ className }: IconProps) {
  return (
    <Icon
      className={className}
      d="M117.31,134l-72,64a8,8,0,1,1-10.63-12L100,128,34.69,70A8,8,0,1,1,45.32,58l72,64a8,8,0,0,1,0,12ZM216,184H120a8,8,0,0,0,0,16h96a8,8,0,0,0,0-16Z"
    />
  )
}
