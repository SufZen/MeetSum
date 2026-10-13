/**
 * HTTP `Range` parsing for the media proxy (M4 Package A, pure).
 *
 * Only single `bytes=` ranges are honoured; anything else (other units,
 * multi-range, malformed or inverted specs) is ignored and the whole entity
 * is served, as RFC 9110 §14.2 allows. Partial responses are capped at
 * `maxChunkBytes` so an open range (`bytes=0-`) never streams a 2 h file in
 * one response.
 */

export const DEFAULT_MEDIA_MAX_RANGE_BYTES = 8 * 1024 * 1024

export type ParsedRange =
  | { type: "full" }
  | { type: "partial"; start: number; end: number }
  | { type: "unsatisfiable" }

export type ParseRangeOptions = { maxChunkBytes?: number }

const FULL: ParsedRange = { type: "full" }
const UNSATISFIABLE: ParsedRange = { type: "unsatisfiable" }

/** `MEETSUM_MEDIA_MAX_RANGE_BYTES` (positive integer) or 8 MiB. */
export function mediaMaxRangeBytes(
  env: Record<string, string | undefined> = process.env
): number {
  const parsed = Number(env.MEETSUM_MEDIA_MAX_RANGE_BYTES)

  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MEDIA_MAX_RANGE_BYTES
}

function toOffset(text: string): number | undefined {
  if (!/^\d+$/.test(text)) return undefined

  const value = Number(text)

  return Number.isSafeInteger(value) ? value : undefined
}

export function parseRange(
  header: string | null | undefined,
  size: number,
  options: ParseRangeOptions = {}
): ParsedRange {
  if (!header || !Number.isSafeInteger(size) || size <= 0) return FULL

  const match = /^\s*bytes\s*=\s*(.*)$/i.exec(header)

  if (!match) return FULL

  const spec = match[1].trim()

  if (!spec || spec.includes(",")) return FULL

  const dash = spec.indexOf("-")

  if (dash === -1) return FULL

  const startText = spec.slice(0, dash).trim()
  const endText = spec.slice(dash + 1).trim()
  const maxChunk =
    options.maxChunkBytes !== undefined &&
    Number.isSafeInteger(options.maxChunkBytes) &&
    options.maxChunkBytes > 0
      ? options.maxChunkBytes
      : DEFAULT_MEDIA_MAX_RANGE_BYTES
  let start: number
  let end: number

  if (!startText) {
    // Suffix range: the last N bytes.
    const suffix = toOffset(endText)

    if (suffix === undefined) return FULL
    if (suffix === 0) return UNSATISFIABLE

    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    const first = toOffset(startText)

    if (first === undefined) return FULL

    if (endText) {
      const last = toOffset(endText)

      if (last === undefined || last < first) return FULL
      end = last
    } else {
      end = size - 1
    }

    if (first >= size) return UNSATISFIABLE
    start = first
  }

  end = Math.min(end, size - 1, start + maxChunk - 1)

  return { type: "partial", start, end }
}
