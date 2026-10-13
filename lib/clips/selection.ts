/**
 * Transcript-side helpers for clips and chapter headings (M5 C5; pure,
 * client-safe).
 */
import type { Chapter } from "@/lib/intelligence/types"

type SegmentLike = { id: string; startMs: number; endMs: number }

/**
 * Chapters keyed by the id of the segment their heading sits above. Only
 * chapters that resolve to a real segment get a heading: the chapter's
 * `startSegmentId` when it exists, else the first segment starting at or
 * after the chapter start. Never two headings on one segment.
 */
export function chapterHeadings(
  chapters: readonly Chapter[] | undefined,
  segments: readonly SegmentLike[]
): Map<string, Chapter> {
  const headings = new Map<string, Chapter>()

  if (!chapters?.length || !segments.length) return headings

  const ids = new Set(segments.map((segment) => segment.id))

  for (const chapter of chapters) {
    const segmentId = ids.has(chapter.startSegmentId)
      ? chapter.startSegmentId
      : segments.find((segment) => segment.startMs >= chapter.startMs)?.id

    if (segmentId && !headings.has(segmentId)) headings.set(segmentId, chapter)
  }

  return headings
}

/**
 * Next selection after clicking the "select" toggle of `index`: a plain
 * click toggles that row and makes it the anchor; shift-click selects the
 * contiguous range from the anchor to `index`.
 */
export function nextSelection(
  current: { ids: ReadonlySet<string>; anchor?: number },
  segments: readonly SegmentLike[],
  index: number,
  shiftKey: boolean
): { ids: Set<string>; anchor?: number } {
  const segment = segments[index]

  if (!segment) return { ids: new Set(current.ids), anchor: current.anchor }

  if (shiftKey && current.anchor !== undefined && segments[current.anchor]) {
    const [from, to] = current.anchor <= index ? [current.anchor, index] : [index, current.anchor]

    return {
      ids: new Set(segments.slice(from, to + 1).map((item) => item.id)),
      anchor: current.anchor,
    }
  }

  const ids = new Set(current.ids)

  if (ids.has(segment.id)) ids.delete(segment.id)
  else ids.add(segment.id)

  return { ids, anchor: ids.size ? index : undefined }
}

/** min start / max end of the selected segments, or undefined. */
export function selectionRange(
  ids: ReadonlySet<string>,
  segments: readonly SegmentLike[]
): { startMs: number; endMs: number; segmentIds: string[] } | undefined {
  const picked = segments.filter((segment) => ids.has(segment.id))

  if (!picked.length) return undefined

  return {
    startMs: Math.min(...picked.map((segment) => segment.startMs)),
    endMs: Math.max(...picked.map((segment) => segment.endMs)),
    segmentIds: picked.map((segment) => segment.id),
  }
}
