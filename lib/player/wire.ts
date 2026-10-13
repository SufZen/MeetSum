/**
 * Record → wire conversion for transcript segments (M4, pure, server- and
 * client-safe). Used where a transcript is already loaded with the meeting
 * (share page, pre-M4 detail) instead of `GET .../transcript`.
 */
import type { TranscriptSegment } from "@/lib/meetings/repository"
import type { TranscriptSegmentWire } from "@/lib/meetings/transcript-wire"
import { encodeWords } from "@/lib/meetings/transcript-words"

export function toWireSegments(segments: readonly TranscriptSegment[]): TranscriptSegmentWire[] {
  return segments.map((segment) => {
    const { words, ...rest } = segment

    return words?.length ? { ...rest, words: encodeWords(words, segment.language) } : rest
  })
}
