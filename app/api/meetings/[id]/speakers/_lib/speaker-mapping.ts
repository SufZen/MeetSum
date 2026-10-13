import { creatorUserId } from "@/app/api/_lib/meeting-access"
import type { AuthContext } from "@/lib/auth/authz"
import type {
  MeetingParticipant,
  MeetingSpeaker,
  MeetingSpeakerPatch,
} from "@/lib/meetings/repository"

/**
 * Shared speaker-mapping operations for the /speakers routes (M3 C5).
 * Mapping only touches the `speakers` row (and the workspace speaker
 * profile); segment text and words are never rewritten — names resolve
 * through the participant join when the transcript is read.
 */

type Ctx = Pick<AuthContext, "meetings" | "principal" | "user" | "apiKey">

export function speakerNotFound() {
  return Response.json({ error: "Speaker not found" }, { status: 404 })
}

export function participantNotFound() {
  return Response.json({ error: "Participant not found" }, { status: 404 })
}

export async function findSpeaker(
  ctx: Pick<AuthContext, "meetings">,
  meetingId: string,
  match: { id?: string; label?: string }
): Promise<{ speaker?: MeetingSpeaker; speakers: MeetingSpeaker[] }> {
  const speakers = await ctx.meetings.listMeetingSpeakers(meetingId)
  const speaker = speakers.find((candidate) =>
    match.id ? candidate.id === match.id : candidate.label === match.label
  )

  return { speaker, speakers }
}

function uniqueAliases(values: Array<string | undefined>, name: string) {
  const key = (value: string) => value.trim().toLocaleLowerCase()

  return [
    ...new Map(
      values
        .filter((value): value is string => Boolean(value?.trim()))
        .filter((value) => key(value) !== key(name))
        .map((value) => [key(value), value.trim()])
    ).values(),
  ]
}

/**
 * Confirms a speaker as a participant (or a free-text name) and remembers
 * the person in the workspace speaker profiles.
 */
export async function confirmSpeaker(
  ctx: Ctx,
  meetingId: string,
  speaker: MeetingSpeaker,
  target: { participant?: MeetingParticipant; displayName?: string }
): Promise<MeetingSpeaker> {
  const displayName = target.displayName?.trim() || undefined
  const name = target.participant?.name ?? displayName

  if (!name) throw new Error("A participant or display name is required")

  const fromSuggestion =
    speaker.suggestion &&
    (target.participant
      ? speaker.suggestion.participantId === target.participant.id
      : speaker.suggestion.name === name)
  const patch: MeetingSpeakerPatch = {
    mappingStatus: "confirmed",
    participantId: target.participant?.id ?? null,
    displayName: displayName ?? null,
    confirmedByUserId: creatorUserId(ctx) ?? null,
  }

  if (fromSuggestion && speaker.suggestion?.profileId) {
    patch.profileId = speaker.suggestion.profileId
  }

  const updated = await ctx.meetings.updateMeetingSpeaker(meetingId, speaker.id, patch)

  await ctx.meetings.recordConfirmedSpeaker({
    meetingId,
    speakerId: speaker.id,
    participant: {
      name,
      ...(target.participant?.email ? { email: target.participant.email } : {}),
    },
    aliases: uniqueAliases([displayName, speaker.displayName, speaker.suggestion?.name], name),
  })

  return updated
}

/** Marks the current suggestion as wrong; the (speaker, candidate) pair stays recorded. */
export function rejectSpeaker(ctx: Ctx, meetingId: string, speaker: MeetingSpeaker) {
  return ctx.meetings.updateMeetingSpeaker(meetingId, speaker.id, {
    mappingStatus: "rejected",
    participantId: null,
    confirmedByUserId: creatorUserId(ctx) ?? null,
  })
}

export function resetSpeaker(ctx: Ctx, meetingId: string, speaker: MeetingSpeaker) {
  return ctx.meetings.updateMeetingSpeaker(meetingId, speaker.id, {
    mappingStatus: "unmapped",
    participantId: null,
    displayName: null,
    profileId: null,
    suggestion: null,
    confirmedByUserId: null,
  })
}

/** Case-insensitive participant lookup by name or email. */
export function findParticipantByName(participants: MeetingParticipant[], person: string) {
  const needle = person.trim().toLocaleLowerCase()

  return participants.find(
    (participant) =>
      participant.name.trim().toLocaleLowerCase() === needle ||
      participant.email?.trim().toLocaleLowerCase() === needle
  )
}
