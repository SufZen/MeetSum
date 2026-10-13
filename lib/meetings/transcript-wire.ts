/**
 * Wire types of the M4 meeting/transcript APIs (client-safe, types only).
 *
 * Segment words travel as the compact stored tuples (see transcript-words.ts)
 * and are decoded lazily on the client.
 */
import type {
  MeetingRecord,
  MeetingSpeaker,
  TranscriptSegment,
} from "@/lib/meetings/repository"
import type { EncodedTranscriptWord } from "@/lib/meetings/transcript-words"

export type TranscriptSegmentWire = Omit<TranscriptSegment, "words"> & {
  /** Raw word tuples; absent on legacy segments. */
  words?: EncodedTranscriptWord[]
}

/** `GET /api/meetings/[id]/transcript` */
export type TranscriptResponse = {
  meetingId: string
  /** `meetings.transcript_version`; also the ETag `"t-<meetingId>-<version>"`. */
  version: number
  /** Meeting primary language (segment language fallback for `dir`). */
  language?: string
  segments: TranscriptSegmentWire[]
  speakers: MeetingSpeaker[]
}

/** `GET /api/meetings/[id]` */
export type MeetingDetailResponse = {
  meeting: MeetingRecord
  permissions: {
    /** `meeting:write`: edit segments, undo, rename. */
    canWrite: boolean
    /** `canManageMeeting`: delete (owner/admin). */
    canManage: boolean
  }
}

/** `PATCH .../transcript/segments/[segmentId]` and `POST .../undo` */
export type SegmentMutationResponse = {
  segment: TranscriptSegmentWire
  /** Present when speakers changed. */
  speakers?: MeetingSpeaker[]
  version: number
}
