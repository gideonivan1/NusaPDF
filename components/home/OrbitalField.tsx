/**
 * Thin Light Signal Orange arcs tracing paths between the circular portraits.
 *
 * Per PRD §6 these imply that the tools are one family rather than a list, and
 * they only make sense against asymmetric placement — so the whole layer is
 * hidden below `lg`, where the constellation collapses to a plain stack.
 * Purely decorative, hence `aria-hidden`.
 */
export function OrbitalField({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      focusable="false"
      className={className}
      viewBox="0 0 1280 620"
      fill="none"
      preserveAspectRatio="none"
    >
      <g
        stroke="var(--color-signal-light)"
        strokeWidth="1.25"
        strokeLinecap="round"
        opacity="0.5"
      >
        {/* Two arcs, each threading the gap between rows of the six-across
            grid. Slight control-point irregularity keeps them feeling drawn
            rather than generated. */}
        <path
          d="M-40 214 C 232 148, 448 262, 676 208 S 1064 118, 1330 196"
          className="orbital-draw"
          style={{ ['--orbital-length' as string]: 1650, animationDelay: '120ms' }}
        />
        <path
          d="M-40 452 C 288 388, 520 500, 764 438 S 1108 348, 1330 428"
          className="orbital-draw"
          style={{ ['--orbital-length' as string]: 1700, animationDelay: '380ms' }}
        />
      </g>
    </svg>
  );
}
