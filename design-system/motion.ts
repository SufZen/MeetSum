/**
 * MeetSum Cadence — motion tokens for TypeScript.
 *
 * CSS is the source of truth (design-system/tokens.css). Use CSS utilities
 * (`duration-[var(--dur-3)]`, `ease-out-expo`, `animate-ms-rise`) for anything
 * that can be expressed as a transition. Reach for these constants only when
 * JavaScript drives the animation (Web Animations API, scroll, canvas, or the
 * `motion` library if it is adopted later).
 *
 * Two speeds:
 *   productive  (dur1–dur3) confirms that something happened
 *   expressive  (dur4–dur5) only for moments that change what the user knows
 * Springs move things; opacity and colour never bounce.
 */

export const duration = {
  instant: 0,
  hover: 70, //    --dur-1  hover, press, colour
  toggle: 120, //  --dur-2  toggles, checkboxes
  menu: 160, //    --dur-3  menus, tooltips, popovers in, toasts out
  panel: 240, //   --dur-4  panels, sheets, tab content
  reveal: 400, //  --dur-5  summary reveal, view change
  ambient: 700, // --dur-6  shimmer sweep, waveform cycle (loops only)
  spring: 520, //  --dur-spring  docks and pills that carry meaning
} as const

/** Named moments: the only motion allowed past 400ms, each explains something. */
export const moment = {
  flash: 1200, //  --dur-flash   a landed citation fades its highlight
  trace: 900, //   --dur-trace   cited speaker lanes glow as a line lands
  scan: 1300, //   --dur-scan    source-trace scan line across the timeline
  sigma: 760, //   --dur-sigma   speaker lanes rotate into the Σ mark
  reveal: 480, //  --dur-reveal  theme switch reveal
} as const

export const stagger = 35 // ms per item, cap at 8 items

export const easing = {
  standard: "cubic-bezier(0.2, 0, 0.38, 0.9)",
  out: "cubic-bezier(0.16, 1, 0.3, 1)",
  in: "cubic-bezier(0.4, 0, 1, 1)",
  emphasized: "cubic-bezier(0.3, 0, 0, 1)",
  spring:
    "linear(0, 0.06 2.5%, 0.24 6%, 0.53 11%, 0.8 17%, 0.96 23%, 1.03 29%, 1.042 34%, 1.03 41%, 1.01 50%, 0.998 62%, 1)",
} as const

/** Same curves as arrays, for libraries that want bezier points. */
export const bezier = {
  standard: [0.2, 0, 0.38, 0.9],
  out: [0.16, 1, 0.3, 1],
  in: [0.4, 0, 1, 1],
  emphasized: [0.3, 0, 0, 1],
} as const

/** Presets for motion.dev (`motion/react`) if the project adopts it. */
export const spring = {
  /** UI default — no overshoot. */
  ui: { type: "spring", visualDuration: 0.25, bounce: 0 },
  /** Docks, pills, toasts — gentle overshoot, spatial only. */
  gentle: { type: "spring", visualDuration: 0.4, bounce: 0.15 },
} as const

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

/**
 * Scale a duration for reduced motion: travel is removed, feedback stays.
 * Expressive durations collapse to a short fade; productive ones are kept.
 */
export function dur(ms: number): number {
  if (!prefersReducedMotion()) return ms
  return ms > duration.menu ? duration.toggle : ms
}

/** Stagger delay for the nth item, capped so long lists don't crawl. */
export function staggerDelay(index: number): number {
  return prefersReducedMotion() ? 0 : Math.min(index, 8) * stagger
}

/**
 * Brand flash for a landed citation (transcript segment, summary item).
 * Colour fade is kept under reduced motion; it carries meaning.
 */
export function flash(el: Element): Animation | undefined {
  if (!("animate" in el)) return undefined
  return el.animate(
    [
      { backgroundColor: "color-mix(in oklch, var(--brand) 26%, transparent)" },
      { backgroundColor: "transparent" },
    ],
    { duration: moment.flash, easing: easing.out }
  )
}

/** Smooth scroll that respects reduced motion. */
export function scrollIntoViewSoft(el: Element, block: ScrollLogicalPosition = "center") {
  el.scrollIntoView({ block, behavior: prefersReducedMotion() ? "auto" : "smooth" })
}
