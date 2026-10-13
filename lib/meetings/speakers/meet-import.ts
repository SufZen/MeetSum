import type {
  MeetingParticipant,
  MeetingSpeaker,
  SpeakerSuggestionUpdate,
} from "@/lib/meetings/repository"
import { isGenericSpeakerName, normalizeName } from "@/lib/meetings/speakers/names"

/** Weight of a Meet transcript naming a speaker (no matching participant). */
export const MEET_NAMED_WEIGHT = 0.9

function participantKeys(participant: MeetingParticipant): string[] {
  const keys = [normalizeName(participant.name)]

  if (participant.email) {
    keys.push(normalizeName(participant.email), normalizeName(participant.email.split("@")[0]))
  }
  return keys.filter(Boolean)
}

/**
 * Mapping updates for speakers of an imported Meet transcript (labels are
 * real display names): a label matching one participant's name/email →
 * confirmed with that participant; otherwise suggested by name. Speakers that
 * are already confirmed/rejected, generic labels and ambiguous names are left
 * alone.
 */
export function planMeetSpeakerMappings(
  speakers: readonly MeetingSpeaker[],
  participants: readonly MeetingParticipant[],
  now: Date = new Date()
): SpeakerSuggestionUpdate[] {
  const computedAt = now.toISOString()
  const realParticipants = participants.filter(
    (participant) =>
      !participant.id.startsWith("derived_") && !isGenericSpeakerName(participant.name)
  )

  return speakers.flatMap((speaker): SpeakerSuggestionUpdate[] => {
    if (speaker.source !== "meet") return []
    if (speaker.mappingStatus === "confirmed" || speaker.mappingStatus === "rejected") return []
    if (isGenericSpeakerName(speaker.label)) return []

    const key = normalizeName(speaker.label)
    const matches = realParticipants.filter((participant) =>
      participantKeys(participant).includes(key)
    )

    if (matches.length === 1) {
      const [participant] = matches

      return [
        {
          speakerId: speaker.id,
          participantId: participant.id,
          mappingStatus: "confirmed",
          suggestion: {
            participantId: participant.id,
            name: participant.name,
            email: participant.email,
            score: 1,
            reasons: [
              {
                kind: "meet_alignment",
                detail: "Named by the Google Meet transcript",
                weight: 1,
              },
            ],
            computedAt,
          },
        },
      ]
    }

    return [
      {
        speakerId: speaker.id,
        mappingStatus: "suggested",
        suggestion: {
          name: speaker.label,
          score: MEET_NAMED_WEIGHT,
          reasons: [
            {
              kind: "meet_alignment",
              detail: "Named by the Google Meet transcript",
              weight: MEET_NAMED_WEIGHT,
            },
          ],
          computedAt,
        },
      },
    ]
  })
}
