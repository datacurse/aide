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

export function Minus({ className }: IconProps) {
  return (
    <Icon
      className={className}
      d="M224,128a8,8,0,0,1-8,8H40a8,8,0,0,1,0-16H216A8,8,0,0,1,224,128Z"
    />
  )
}
