/**
 * Icons, drawn inline.
 *
 * Phosphor's geometry, not Phosphor's package. `@phosphor-icons/react` is nine
 * thousand components and a build-time dependency to render one padlock, in a
 * web package that has four dependencies and a rule about adding a fifth. The
 * paths are MIT-licensed and are copied verbatim from the regular weight, so
 * they can be checked against the real thing rather than eyeballed.
 *
 * `currentColor` and no explicit size: these are pieces of text, and every place
 * that uses one has already decided what colour it is and how big.
 */
export function Lock({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 256 256"
      fill="currentColor"
      className={className}
      // Decorative. The sentence saying WHY the control is locked is on the
      // button's own title and, for the ones that matter, written out beside it
      // — so a screen reader announcing "lock" here would be reading the icon
      // instead of the reason.
      aria-hidden="true"
      focusable="false"
    >
      <path d="M208,80H176V56a48,48,0,0,0-96,0V80H48A16,16,0,0,0,32,96V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V96A16,16,0,0,0,208,80ZM96,56a32,32,0,0,1,64,0V80H96ZM208,208H48V96H208V208Z" />
    </svg>
  )
}
