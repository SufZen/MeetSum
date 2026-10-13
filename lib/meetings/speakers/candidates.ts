import type {
  MeetingParticipant,
  SpeakerProfile,
  SpeakerSuggestionReason,
} from "@/lib/meetings/repository"
import {
  isGenericSpeakerName,
  nameTokens,
  normalizeName,
  startsWithTokens,
} from "@/lib/meetings/speakers/names"
import type { MeetTimelineEntry } from "@/lib/meetings/speakers/types"

/** Someone a speaker can be mapped to: a participant, a profile, or both. */
export type SpeakerCandidate = {
  key: string
  participantId?: string
  profileId?: string
  name: string
  email?: string
  role?: MeetingParticipant["role"]
  /** Attendee of this meeting (participant row). */
  isParticipant: boolean
  /** Normalized token lists of the candidate's own name (full + first). */
  nameForms: string[][]
  /** Normalized token lists of aliases (workspace memory). */
  aliasForms: string[][]
  embedding?: number[]
  embeddingModel?: string
}

export type NameMatch = "full" | "first" | "alias"

/** Ids a rejection may refer to (participant, profile, or name for Meet-only). */
export function candidateIds(candidate: SpeakerCandidate): string[] {
  return [
    candidate.participantId,
    candidate.profileId,
    `name:${normalizeName(candidate.name)}`,
  ].filter((id): id is string => Boolean(id))
}

function forms(name: string): string[][] {
  const tokens = nameTokens(name)

  if (!tokens.length) return []
  return tokens.length > 1 ? [tokens, [tokens[0]]] : [tokens]
}

function aliasForms(aliases: readonly string[]): string[][] {
  return aliases.map(nameTokens).filter((tokens) => tokens.length > 0)
}

function sameEmail(a?: string, b?: string) {
  return Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase())
}

function knownNames(candidate: SpeakerCandidate): Set<string> {
  return new Set([
    normalizeName(candidate.name),
    ...candidate.aliasForms.map((tokens) => tokens.join(" ")),
  ])
}

/**
 * Candidates = meeting participants (generic "Speaker N" rows excluded) +
 * workspace profiles (merged into the participant they match by email or
 * name/alias) + Meet timeline names not matching anyone else.
 */
export function buildCandidates(
  participants: readonly MeetingParticipant[],
  profiles: readonly SpeakerProfile[],
  meetTimeline: readonly MeetTimelineEntry[] = []
): SpeakerCandidate[] {
  const candidates: SpeakerCandidate[] = participants
    .filter((participant) => !isGenericSpeakerName(participant.name))
    .filter((participant) => !participant.id.startsWith("derived_"))
    .map((participant) => ({
      key: `participant:${participant.id}`,
      participantId: participant.id,
      name: participant.name,
      email: participant.email,
      role: participant.role,
      isParticipant: true,
      nameForms: forms(participant.name),
      aliasForms: [],
    }))

  for (const profile of profiles) {
    const profileNames = new Set([
      normalizeName(profile.displayName),
      ...profile.aliases.map(normalizeName),
    ])
    const match = candidates.find(
      (candidate) =>
        !candidate.profileId &&
        (sameEmail(candidate.email, profile.email) ||
          profileNames.has(normalizeName(candidate.name)))
    )

    if (match) {
      match.profileId = profile.id
      match.aliasForms.push(...aliasForms([profile.displayName, ...profile.aliases]))
      match.embedding = profile.voiceEmbedding
      match.embeddingModel = profile.embeddingModel
      continue
    }

    candidates.push({
      key: `profile:${profile.id}`,
      profileId: profile.id,
      name: profile.displayName,
      email: profile.email,
      isParticipant: false,
      nameForms: forms(profile.displayName),
      aliasForms: aliasForms(profile.aliases),
      embedding: profile.voiceEmbedding,
      embeddingModel: profile.embeddingModel,
    })
  }

  for (const entry of meetTimeline) {
    if (findCandidateForPerson(candidates, entry) || isGenericSpeakerName(entry.name)) continue

    candidates.push({
      key: `meet:${normalizeName(entry.name)}`,
      name: entry.name,
      email: entry.email,
      isParticipant: false,
      nameForms: forms(entry.name),
      aliasForms: [],
    })
  }

  return candidates
}

/** The candidate a named person (Meet timeline entry) refers to. */
export function findCandidateForPerson(
  candidates: readonly SpeakerCandidate[],
  person: { name: string; email?: string }
): SpeakerCandidate | undefined {
  const name = normalizeName(person.name)

  return (
    candidates.find((candidate) => sameEmail(candidate.email, person.email)) ??
    candidates.find((candidate) => knownNames(candidate).has(name))
  )
}

/**
 * How a phrase (normalized tokens, e.g. what follows "אני") names the
 * candidate: full name, first name, or an alias. Only the phrase start counts.
 */
export function matchPhrase(
  tokens: readonly string[],
  candidate: SpeakerCandidate
): NameMatch | undefined {
  const [full, first] = candidate.nameForms

  if (full && startsWithTokens(tokens, full)) return "full"
  if (first && startsWithTokens(tokens, first)) return "first"
  if (candidate.aliasForms.some((alias) => startsWithTokens(tokens, alias))) return "alias"

  return undefined
}

/** Accumulates reasons per (speaker id, candidate key). */
export class ReasonBook {
  private readonly reasons = new Map<string, Map<string, SpeakerSuggestionReason[]>>()

  add(speakerId: string, candidateKey: string, reason: SpeakerSuggestionReason) {
    let bySpeaker = this.reasons.get(speakerId)

    if (!bySpeaker) {
      bySpeaker = new Map()
      this.reasons.set(speakerId, bySpeaker)
    }

    const list = bySpeaker.get(candidateKey) ?? []

    list.push(reason)
    bySpeaker.set(candidateKey, list)
  }

  get(speakerId: string, candidateKey: string): SpeakerSuggestionReason[] {
    return this.reasons.get(speakerId)?.get(candidateKey) ?? []
  }

  pairs(): Array<{ speakerId: string; candidateKey: string; reasons: SpeakerSuggestionReason[] }> {
    return [...this.reasons.entries()].flatMap(([speakerId, byCandidate]) =>
      [...byCandidate.entries()].map(([candidateKey, reasons]) => ({
        speakerId,
        candidateKey,
        reasons,
      }))
    )
  }
}

/** Noisy-OR of independent evidence weights. */
export function combineWeights(reasons: readonly SpeakerSuggestionReason[]): number {
  const miss = reasons.reduce(
    (product, reason) => product * (1 - Math.min(Math.max(reason.weight, 0), 0.999)),
    1
  )

  return 1 - miss
}
