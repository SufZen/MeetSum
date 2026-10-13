import type {
  MeetingParticipant,
  MeetingSpeaker,
  SpeakerSuggestionUpdate,
} from "@/lib/meetings/repository"
import {
  isGenericSpeakerName,
  normalizeName,
  sanitizeDisplayName,
} from "@/lib/meetings/speakers/names"
import type { MeetSpeakerIdentity } from "@/lib/meetings/speakers/types"

/**
 * Weight of a name-only Meet match. Display names are self-chosen (anyone can
 * join as "Dana"), so a name never confirms — it only suggests.
 */
export const MEET_NAME_ONLY_WEIGHT = 0.6

function sameEmail(a?: string, b?: string) {
  return Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase())
}

function nameMatches(participant: MeetingParticipant, key: string): boolean {
  return normalizeName(participant.name) === key
}

/**
 * Mapping updates for speakers of an imported Meet transcript. Security model
 * (Meet display names are attacker-controlled):
 * - confirmed + participant only when the label's Meet participant is a
 *   signed-in user whose Google identity resolved to a verified email equal
 *   to exactly one meeting participant's email;
 * - everything else (anonymous, phone, unresolved signed-in users, unknown
 *   identity) is at most `suggested` (meet_alignment, weight 0.6), pointing
 *   at a participant only when the name matches exactly one;
 * - never touches speaker profiles (only an explicit user confirmation does).
 * Already confirmed/rejected speakers and generic labels are left alone.
 */
export function planMeetSpeakerMappings(
  speakers: readonly MeetingSpeaker[],
  participants: readonly MeetingParticipant[],
  options: { identities?: readonly MeetSpeakerIdentity[]; now?: Date } = {}
): SpeakerSuggestionUpdate[] {
  const computedAt = (options.now ?? new Date()).toISOString()
  const identities = new Map((options.identities ?? []).map((identity) => [identity.label, identity]))
  const realParticipants = participants.filter(
    (participant) =>
      !participant.id.startsWith("derived_") && !isGenericSpeakerName(participant.name)
  )

  return speakers.flatMap((speaker): SpeakerSuggestionUpdate[] => {
    if (speaker.source !== "meet") return []
    if (speaker.mappingStatus === "confirmed" || speaker.mappingStatus === "rejected") return []
    if (isGenericSpeakerName(speaker.label)) return []

    const name = sanitizeDisplayName(speaker.label)

    if (!name) return []

    const identity = identities.get(speaker.label)
    const verifiedEmail =
      identity?.kind === "signedin" && identity.userId ? identity.verifiedEmail : undefined
    const emailMatches = verifiedEmail
      ? realParticipants.filter((participant) => sameEmail(participant.email, verifiedEmail))
      : []

    if (emailMatches.length === 1) {
      const [participant] = emailMatches

      return [
        {
          speakerId: speaker.id,
          participantId: participant.id,
          mappingStatus: "confirmed",
          suggestion: {
            participantId: participant.id,
            name: sanitizeDisplayName(participant.name) ?? name,
            email: participant.email,
            score: 1,
            reasons: [
              {
                kind: "meet_alignment",
                detail: "Signed-in Google Meet participant with a verified matching email",
                weight: 1,
              },
            ],
            computedAt,
          },
        },
      ]
    }

    const key = normalizeName(name)
    const nameMatched = realParticipants.filter((participant) => nameMatches(participant, key))
    const participant = nameMatched.length === 1 ? nameMatched[0] : undefined

    return [
      {
        speakerId: speaker.id,
        mappingStatus: "suggested",
        suggestion: {
          ...(participant
            ? { participantId: participant.id, email: participant.email }
            : {}),
          name: participant ? (sanitizeDisplayName(participant.name) ?? name) : name,
          score: MEET_NAME_ONLY_WEIGHT,
          reasons: [
            {
              kind: "meet_alignment",
              detail: "Display name from the Google Meet transcript (not verified)",
              weight: MEET_NAME_ONLY_WEIGHT,
            },
          ],
          computedAt,
        },
      },
    ]
  })
}
