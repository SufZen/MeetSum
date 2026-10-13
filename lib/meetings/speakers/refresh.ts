import type {
  MeetingRepository,
  MeetingSpeaker,
  SpeakerSuggestionUpdate,
} from "@/lib/meetings/repository"
import { planMeetSpeakerMappings } from "@/lib/meetings/speakers/meet-import"
import { normalizeName } from "@/lib/meetings/speakers/names"
import { suggestSpeakerMappings } from "@/lib/meetings/speakers/suggest"
import {
  speakerSuggestOptionsFromEnv,
  type MeetTimelineEntry,
} from "@/lib/meetings/speakers/types"

export type RefreshSpeakerSuggestionsOptions = {
  /** Meet transcript timeline, when the caller already has it. */
  meetTimeline?: MeetTimelineEntry[]
  /** Best-effort loader (e.g. Google Meet); failures are ignored. */
  loadMeetTimeline?: () => Promise<MeetTimelineEntry[] | undefined>
  env?: NodeJS.ProcessEnv
  now?: Date
}

/** The candidate a rejected speaker's stored suggestion pointed at. */
function rejectedCandidateId(speaker: MeetingSpeaker): string | undefined {
  const suggestion = speaker.suggestion

  if (!suggestion) return undefined
  return (
    suggestion.participantId ??
    suggestion.profileId ??
    (suggestion.name ? `name:${normalizeName(suggestion.name)}` : undefined)
  )
}

/**
 * Recomputes and stores suggestions for a meeting; returns how many speakers
 * got a suggestion. Meet-imported speakers are mapped by their Meet name
 * (participant match → confirmed, else suggested); diarized speakers go
 * through the suggestion engine. Confirmed/rejected speakers are left alone;
 * stale suggestions of other speakers are cleared back to `unmapped`.
 */
export async function refreshSpeakerSuggestions(
  repo: MeetingRepository,
  meetingId: string,
  options: RefreshSpeakerSuggestionsOptions = {}
): Promise<number> {
  const suggestOptions = speakerSuggestOptionsFromEnv(options.env)
  const meeting = await repo.getMeeting(meetingId)

  if (!meeting) return 0

  const speakers = await repo.listMeetingSpeakers(meetingId, {
    includeEmbeddings: suggestOptions.voiceprintEnabled,
  })

  if (!speakers.length) return 0

  const [participants, profiles] = await Promise.all([
    repo.listMeetingParticipants(meetingId),
    repo.listSpeakerProfiles(),
  ])
  let meetTimeline = options.meetTimeline

  if (!meetTimeline && suggestOptions.useMeetTimeline && options.loadMeetTimeline) {
    meetTimeline = await options.loadMeetTimeline().catch(() => undefined)
  }

  const suggestions = suggestSpeakerMappings({
    speakers,
    segments: meeting.transcript ?? [],
    participants,
    profiles,
    meetTimeline,
    meetingSource: meeting.source,
    rejectedPairs: speakers.flatMap((speaker) => {
      const candidateId =
        speaker.mappingStatus === "rejected" ? rejectedCandidateId(speaker) : undefined

      return candidateId ? [{ speakerId: speaker.id, candidateId }] : []
    }),
    now: options.now,
    options: suggestOptions,
  })
  const bySpeaker = new Map(suggestions.map((item) => [item.speakerId, item]))
  // Speakers of an imported Meet transcript are named by Meet itself.
  const meetPlans = new Map(
    planMeetSpeakerMappings(speakers, participants, options.now).map((plan) => [
      plan.speakerId,
      plan,
    ])
  )
  const updates: SpeakerSuggestionUpdate[] = []
  let suggested = 0

  for (const speaker of speakers) {
    if (speaker.mappingStatus === "confirmed" || speaker.mappingStatus === "rejected") continue

    const meetPlan = meetPlans.get(speaker.id)
    const item = bySpeaker.get(speaker.id)

    if (meetPlan) {
      updates.push(meetPlan)
      suggested += 1
    } else if (item) {
      suggested += 1
      updates.push({
        speakerId: speaker.id,
        suggestion: item.suggestion,
        mappingStatus: item.mappingStatus,
        ...(item.mappingStatus === "confirmed" && item.suggestion.participantId
          ? { participantId: item.suggestion.participantId }
          : {}),
      })
    } else if (speaker.mappingStatus === "suggested" || speaker.suggestion) {
      updates.push({ speakerId: speaker.id, suggestion: null, mappingStatus: "unmapped" })
    }
  }

  if (updates.length) await repo.setSpeakerSuggestions(meetingId, updates)

  return suggested
}
