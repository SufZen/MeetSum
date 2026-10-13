import type {
  MeetingParticipant,
  MeetingRepository,
  MeetingSpeaker,
  SpeakerProfile,
  SpeakerSuggestion,
  TranscriptSegment,
} from "@/lib/meetings/repository"

/** A Meet participant's speaking interval, relative to meeting start. */
export type MeetTimelineEntry = {
  name: string
  email?: string
  startMs: number
  endMs: number
}

export type SuggestSpeakerMappingsInput = {
  speakers: MeetingSpeaker[]
  segments: TranscriptSegment[]
  participants: MeetingParticipant[]
  profiles: SpeakerProfile[]
  meetTimeline?: MeetTimelineEntry[]
  meetingSource?: string
  /** (speakerId, participantId|profileId) pairs the user rejected. */
  rejectedPairs?: Array<{ speakerId: string; candidateId: string }>
  now?: Date
}

export type SpeakerMappingSuggestion = {
  speakerId: string
  suggestion: SpeakerSuggestion
  mappingStatus: "suggested" | "confirmed"
}

/**
 * Pure speaker → participant/profile suggestion engine (M3).
 * Stub: suggests nothing until the M3 engine lands.
 */
export function suggestSpeakerMappings(
  input: SuggestSpeakerMappingsInput
): SpeakerMappingSuggestion[] {
  void input
  return []
}

/**
 * Recomputes and stores suggestions for a meeting; returns how many speakers
 * got a suggestion. Stub: 0.
 */
export async function refreshSpeakerSuggestions(
  repo: MeetingRepository,
  meetingId: string
): Promise<number> {
  void repo
  void meetingId
  return 0
}
