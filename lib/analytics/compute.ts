/**
 * Pure per-speaker talk analytics (owner: Package D). Step 0 stub: returns
 * empty metrics.
 */
import type { MeetingAnalyticsMetrics } from "@/lib/analytics/types"
import type { MeetingSpeaker, TranscriptSegment } from "@/lib/meetings/repository"

export function computeMeetingAnalytics(
  segments: TranscriptSegment[],
  speakers: MeetingSpeaker[]
): MeetingAnalyticsMetrics {
  void speakers

  return {
    basis: segments.some((segment) => segment.words?.length) ? "words" : "text",
    totalTalkTimeMs: 0,
    totalWords: 0,
    totalQuestions: 0,
    fillerPer100Words: 0,
    interruptions: 0,
    speakers: [],
  }
}

/** sha1 of segment ids, text and speaker ids (Step 0 stub: empty). */
export function transcriptHash(segments: TranscriptSegment[]): string {
  void segments
  return ""
}
