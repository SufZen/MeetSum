import type { MeetingSpeaker, TranscriptSegment } from "@/lib/meetings/repository"
import type { ReasonBook, SpeakerCandidate } from "@/lib/meetings/speakers/candidates"

/** Shared input of every suggestion signal. */
export type SignalContext = {
  /** Speakers that may receive a suggestion (not confirmed / rejected). */
  speakers: MeetingSpeaker[]
  /** All diarized segments (with speakerId), in start order. */
  segments: TranscriptSegment[]
  segmentsBySpeaker: Map<string, TranscriptSegment[]>
  candidates: SpeakerCandidate[]
  book: ReasonBook
}
