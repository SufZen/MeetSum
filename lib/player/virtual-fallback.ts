/**
 * Safety net for the virtualized transcript: TanStack Virtual renders no
 * items while its scroll element measures 0px tall (before layout, inside a
 * collapsed flex parent, hidden tab…). Rather than show an empty transcript,
 * fall back to the first rows' estimated measurements so content never
 * disappears; the virtualizer takes over as soon as the viewport has a size.
 */

/** Rows rendered when the scroll viewport has no measurable height. */
export const FALLBACK_ROW_COUNT = 12

export function withFallbackRange<T>(
  items: readonly T[],
  measurements: readonly T[],
  count: number,
  limit: number = FALLBACK_ROW_COUNT
): readonly T[] {
  if (items.length || count <= 0 || limit <= 0) return items

  return measurements.slice(0, Math.min(count, limit))
}
