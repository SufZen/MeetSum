import type {
  MeetingParticipant,
  MeetingSpeaker,
  SpeakerProfile,
  SpeakerSuggestion,
  SpeakerSuggestionReason,
  TranscriptSegment,
} from "@/lib/meetings/repository"
import {
  buildCandidates,
  candidateIds,
  combineWeights,
  ReasonBook,
  type SpeakerCandidate,
} from "@/lib/meetings/speakers/candidates"
import { addressedByNameSignal } from "@/lib/meetings/speakers/signals/addressed-by-name"
import type { SignalContext } from "@/lib/meetings/speakers/signals/context"
import { meetAlignmentSignal } from "@/lib/meetings/speakers/signals/meet-alignment"
import { organizerOwnerSignal } from "@/lib/meetings/speakers/signals/organizer-owner"
import { selfIntroSignal } from "@/lib/meetings/speakers/signals/self-intro"
import { voiceprintSignal } from "@/lib/meetings/speakers/signals/voiceprint"
import {
  speakerSuggestOptionsFromEnv,
  type MeetTimelineEntry,
  type SpeakerSuggestOptions,
} from "@/lib/meetings/speakers/types"

export type { MeetTimelineEntry, SpeakerSuggestOptions } from "@/lib/meetings/speakers/types"
export { speakerSuggestOptionsFromEnv } from "@/lib/meetings/speakers/types"
export { refreshSpeakerSuggestions } from "@/lib/meetings/speakers/refresh"

export type SuggestSpeakerMappingsInput = {
  speakers: MeetingSpeaker[]
  segments: TranscriptSegment[]
  participants: MeetingParticipant[]
  profiles: SpeakerProfile[]
  meetTimeline?: MeetTimelineEntry[]
  meetingSource?: string
  /** (speakerId, participantId|profileId|`name:<normalized>`) pairs the user rejected. */
  rejectedPairs?: Array<{ speakerId: string; candidateId: string }>
  now?: Date
  /** Defaults to the documented defaults (not the process env). */
  options?: Partial<SpeakerSuggestOptions>
}

export type SpeakerMappingSuggestion = {
  speakerId: string
  suggestion: SpeakerSuggestion
  mappingStatus: "suggested" | "confirmed"
}

export const SINGLE_REMAINING_WEIGHT = 0.55

const LOCKED_STATUSES = new Set(["confirmed", "rejected"])

function roundScore(value: number) {
  return Math.round(value * 1000) / 1000
}

function isRejected(
  rejected: ReadonlySet<string>,
  speakerId: string,
  candidate: SpeakerCandidate
) {
  return candidateIds(candidate).some((id) => rejected.has(`${speakerId}\u0000${id}`))
}

/** Candidates already owned by a confirmed speaker. */
function takenByConfirmed(
  speakers: readonly MeetingSpeaker[],
  candidates: readonly SpeakerCandidate[]
): Set<string> {
  const taken = new Set<string>()

  for (const speaker of speakers) {
    if (speaker.mappingStatus !== "confirmed") continue

    for (const candidate of candidates) {
      if (
        (speaker.participantId && candidate.participantId === speaker.participantId) ||
        (speaker.profileId && candidate.profileId === speaker.profileId)
      ) {
        taken.add(candidate.key)
      }
    }
  }

  return taken
}

/**
 * Pure speaker → participant/profile suggestion engine (M3).
 *
 * Signals (meet_alignment, self_intro, addressed_by_name, organizer_owner,
 * workspace_memory, voiceprint when enabled) are combined per pair by
 * noisy-OR, then assigned greedily one-to-one (highest score first);
 * single_remaining fills the last unmapped speaker with the last free
 * participant. Confirmed/rejected speakers are never touched, rejected pairs
 * never suggested, candidates of confirmed speakers never reused.
 */
export function suggestSpeakerMappings(
  input: SuggestSpeakerMappingsInput
): SpeakerMappingSuggestion[] {
  const options: SpeakerSuggestOptions = {
    ...speakerSuggestOptionsFromEnv({} as NodeJS.ProcessEnv),
    ...input.options,
  }
  const computedAt = (input.now ?? new Date()).toISOString()
  const timeline = options.useMeetTimeline ? (input.meetTimeline ?? []) : []
  const candidates = buildCandidates(input.participants, input.profiles, timeline)
  const eligible = input.speakers.filter((speaker) => !LOCKED_STATUSES.has(speaker.mappingStatus))

  if (!eligible.length || !candidates.length) return []

  const segments = input.segments
    .filter((segment) => segment.speakerId)
    .sort((a, b) => a.startMs - b.startMs)
  const segmentsBySpeaker = new Map<string, TranscriptSegment[]>()

  for (const segment of segments) {
    const list = segmentsBySpeaker.get(segment.speakerId as string) ?? []

    list.push(segment)
    segmentsBySpeaker.set(segment.speakerId as string, list)
  }

  const book = new ReasonBook()
  const context: SignalContext = {
    speakers: eligible,
    segments,
    segmentsBySpeaker,
    candidates,
    book,
  }

  meetAlignmentSignal(context, timeline)
  selfIntroSignal(context)
  addressedByNameSignal(context)
  organizerOwnerSignal(context, input.meetingSource)
  if (options.voiceprintEnabled) voiceprintSignal(context, options.voiceprintThreshold)

  const rejected = new Set(
    (input.rejectedPairs ?? []).map((pair) => `${pair.speakerId}\u0000${pair.candidateId}`)
  )
  const candidateByKey = new Map(candidates.map((candidate) => [candidate.key, candidate]))
  const talk = new Map(eligible.map((speaker) => [speaker.id, speaker.talkTimeMs]))
  const takenCandidates = takenByConfirmed(input.speakers, candidates)
  const assignedSpeakers = new Set<string>()
  const results = new Map<string, { candidate: SpeakerCandidate; reasons: SpeakerSuggestionReason[]; score: number }>()

  const pairs = book
    .pairs()
    .map((pair) => ({
      ...pair,
      candidate: candidateByKey.get(pair.candidateKey) as SpeakerCandidate,
      score: combineWeights(pair.reasons),
    }))
    .filter(
      (pair) =>
        talk.has(pair.speakerId) &&
        pair.score >= options.threshold &&
        !isRejected(rejected, pair.speakerId, pair.candidate)
    )
    .sort(
      (a, b) =>
        b.score - a.score ||
        (talk.get(b.speakerId) ?? 0) - (talk.get(a.speakerId) ?? 0) ||
        a.candidateKey.localeCompare(b.candidateKey)
    )

  for (const pair of pairs) {
    if (assignedSpeakers.has(pair.speakerId) || takenCandidates.has(pair.candidateKey)) continue

    assignedSpeakers.add(pair.speakerId)
    takenCandidates.add(pair.candidateKey)
    results.set(pair.speakerId, {
      candidate: pair.candidate,
      reasons: pair.reasons,
      score: pair.score,
    })
  }

  // single_remaining: one unmapped speaker and one free participant left.
  const remainingSpeakers = eligible.filter((speaker) => !assignedSpeakers.has(speaker.id))
  const remainingParticipants = candidates.filter(
    (candidate) => candidate.isParticipant && !takenCandidates.has(candidate.key)
  )

  if (remainingSpeakers.length === 1 && remainingParticipants.length === 1) {
    const [speaker] = remainingSpeakers
    const [candidate] = remainingParticipants

    if (!isRejected(rejected, speaker.id, candidate)) {
      const reasons: SpeakerSuggestionReason[] = [
        ...book.get(speaker.id, candidate.key),
        {
          kind: "single_remaining",
          detail: "The only participant not matched to another speaker",
          weight: SINGLE_REMAINING_WEIGHT,
        },
      ]
      const score = combineWeights(reasons)

      if (score >= options.threshold) {
        results.set(speaker.id, { candidate, reasons, score })
      }
    }
  }

  return eligible.flatMap((speaker) => {
    const result = results.get(speaker.id)

    if (!result) return []

    const score = roundScore(result.score)
    const suggestion: SpeakerSuggestion = {
      name: result.candidate.name,
      score,
      reasons: result.reasons,
      computedAt,
    }

    if (result.candidate.participantId) suggestion.participantId = result.candidate.participantId
    if (result.candidate.profileId) suggestion.profileId = result.candidate.profileId
    if (result.candidate.email) suggestion.email = result.candidate.email

    return [
      {
        speakerId: speaker.id,
        suggestion,
        // Meet timeline evidence rests on self-chosen display names: it may
        // suggest, never auto-confirm (verified Meet identities confirm via
        // planMeetSpeakerMappings instead).
        mappingStatus:
          options.autoConfirmScore !== undefined &&
          score >= options.autoConfirmScore &&
          !result.reasons.some((reason) => reason.kind === "meet_alignment")
            ? ("confirmed" as const)
            : ("suggested" as const),
      },
    ]
  })
}
