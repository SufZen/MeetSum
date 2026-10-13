/**
 * Seek sources → real segments (M4, client-safe, pure).
 *
 * "No citation, no claim": a timecode/citation chip renders only when it
 * resolves to a transcript segment. Action items (`sourceStartMs`), key
 * quotes (`segmentId`, `startMs`) and Ask citations (`segmentId`,
 * `startMs`) all go through `resolveCitation`.
 */
import { findSegmentAt, type TranscriptIndex } from "@/lib/player/word-index"

export type CitationSegment = { id: string; startMs: number; endMs: number }

export type ResolvedCitation = {
  segmentIndex: number
  segmentId: string
  /** Where playback should start. */
  startMs: number
}

/** A timestamp this close to a segment (silence around it) still resolves. */
export const CITATION_TOLERANCE_MS = 1_500

export function resolveCitation(
  segments: readonly CitationSegment[],
  index: TranscriptIndex,
  source: { segmentId?: string; startMs?: number }
): ResolvedCitation | undefined {
  const { segmentId, startMs } = source
  const hasMs = typeof startMs === "number" && Number.isFinite(startMs) && startMs >= 0

  if (segmentId) {
    const segmentIndex = segments.findIndex((segment) => segment.id === segmentId)

    if (segmentIndex >= 0) {
      const segment = segments[segmentIndex]
      const within = hasMs && startMs >= segment.startMs && startMs < segment.endMs

      return { segmentIndex, segmentId, startMs: within ? startMs : segment.startMs }
    }
  }

  if (!hasMs || index.length === 0) return undefined

  const { index: found, inGap } = findSegmentAt(index, startMs)

  if (found >= 0 && !inGap) {
    return { segmentIndex: found, segmentId: segments[found].id, startMs }
  }

  // In silence: snap to the nearer neighbour if it is close enough.
  const previous = found >= 0 ? segments[found] : undefined
  const next = segments[found + 1]
  const previousDistance = previous ? startMs - previous.endMs : Number.POSITIVE_INFINITY
  const nextDistance = next ? next.startMs - startMs : Number.POSITIVE_INFINITY

  if (nextDistance <= CITATION_TOLERANCE_MS && nextDistance <= previousDistance && next) {
    return { segmentIndex: found + 1, segmentId: next.id, startMs: next.startMs }
  }
  if (previous && previousDistance <= CITATION_TOLERANCE_MS) {
    return { segmentIndex: found, segmentId: previous.id, startMs }
  }

  return undefined
}

export type PlayerMarkerKind = "chapter" | "action_item" | "search_match"

/** Ticks on the timeline (chapters stay `[]` until M5). */
export type PlayerMarker = {
  id: string
  startMs: number
  endMs?: number
  kind: PlayerMarkerKind
  label: string
}

export function buildActionItemMarkers(
  items: readonly { id: string; title: string; sourceStartMs?: number }[],
  segments: readonly CitationSegment[],
  index: TranscriptIndex
): PlayerMarker[] {
  const markers: PlayerMarker[] = []

  for (const item of items) {
    if (item.sourceStartMs === undefined) continue

    const resolved = resolveCitation(segments, index, { startMs: item.sourceStartMs })

    if (resolved) {
      markers.push({ id: `action:${item.id}`, startMs: resolved.startMs, kind: "action_item", label: item.title })
    }
  }

  return markers
}
