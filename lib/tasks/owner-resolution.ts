/**
 * Resolves an action item's spoken owner to an M3 speaker, a meeting
 * participant and a workspace member (docs/parity/m5.md B2; owner: Package B).
 * Pure and isomorphic.
 *
 * Order: first person ("אני", "I'll") or `ownerIsSourceSpeaker` → the source
 * speaker; otherwise a normalized match (exact full name → unique first name
 * → speaker-profile alias → email local part). Hebrew↔Latin matches happen
 * only through aliases. Ambiguous or unknown owners keep `ownerText` only.
 */
import type { MeetingParticipant, MeetingSpeaker } from "@/lib/meetings/repository"
import type { TaskMember } from "@/lib/tasks/types"

export type ResolveOwnerInput = {
  ownerText?: string
  /** The model says the source speaker owns the task ("I'll send it"). */
  ownerIsSourceSpeaker?: boolean
  sourceSpeakerId?: string
  /** M3 speakers with resolved display names. */
  speakers: MeetingSpeaker[]
  participants: MeetingParticipant[]
  members: TaskMember[]
  /** Speaker-profile aliases (Hebrew<->Latin names), keyed by email or name. */
  profileAliases?: Array<{ name: string; email?: string; aliases: string[] }>
}

export type OwnerResolutionMethod =
  | "source_speaker"
  | "full_name"
  | "first_name"
  | "alias"
  | "email"
  | "none"

export type OwnerResolution = {
  ownerText?: string
  participantId?: string
  speakerId?: string
  userId?: string
  displayName?: string
  confidence: number
  method: OwnerResolutionMethod
}

const CONFIDENCE: Record<OwnerResolutionMethod, number> = {
  source_speaker: 0.9,
  full_name: 0.95,
  alias: 0.85,
  first_name: 0.8,
  email: 0.75,
  none: 0,
}

const NIQQUD = /[֑-ֽֿ-ׇ]/g
const HEBREW_PREFIXES = "לוהבשמכ"

/** Canonical name: NFKC, lowercase, no niqqud, letters/digits/spaces only. */
export function normalizeOwnerName(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/־/g, " ")
    .replace(NIQQUD, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}@.\s'-]+/gu, " ")
    .replace(/['.-]+(?=\s|$)/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

const FIRST_PERSON =
  /^(?:אני|אנוכי|אנחנו|עליי|עלי|אצלי|i|i'll|i'm|i will|ill|me|myself|we|we'll|us)(?:\s|$)/u

/** "אני", "אני אשלח", "I'll do it", "me". */
export function isFirstPersonOwner(ownerText: string | undefined): boolean {
  if (!ownerText) return false

  return FIRST_PERSON.test(normalizeOwnerName(ownerText).replace(/’/g, "'"))
}

type Person = {
  key: string
  names: Set<string>
  /** First tokens of every name. */
  firstNames: Set<string>
  email?: string
  participantId?: string
  speakerIds: string[]
  userId?: string
  displayName?: string
}

function emailKey(email: string | undefined): string | undefined {
  const trimmed = email?.trim().toLowerCase()

  return trimmed ? trimmed : undefined
}

function addName(person: Person, name: string | undefined) {
  if (!name) return

  const normalized = normalizeOwnerName(name)

  if (!normalized) return
  person.names.add(normalized)
  person.firstNames.add(normalized.split(" ")[0])
  person.displayName ??= name.trim()
}

/**
 * One entry per real person: participants first, speakers merged into their
 * participant, members merged by email.
 */
function buildPeople(input: ResolveOwnerInput): Person[] {
  const people: Person[] = []
  const byParticipant = new Map<string, Person>()
  const byEmail = new Map<string, Person>()

  const create = (key: string): Person => {
    const person: Person = { key, names: new Set(), firstNames: new Set(), speakerIds: [] }

    people.push(person)
    return person
  }

  for (const participant of input.participants) {
    const email = emailKey(participant.email)
    const existing = email ? byEmail.get(email) : undefined
    const person = existing ?? create(`p:${participant.id}`)

    person.participantId ??= participant.id
    addName(person, participant.name)
    if (email) {
      person.email ??= email
      byEmail.set(email, person)
    }
    byParticipant.set(participant.id, person)
  }

  for (const speaker of input.speakers) {
    const person =
      (speaker.participantId ? byParticipant.get(speaker.participantId) : undefined) ??
      create(`s:${speaker.id}`)

    person.speakerIds.push(speaker.id)
    // Only resolved names count: "Speaker 2" is a label, not a person.
    addName(person, speaker.displayName)
  }

  for (const member of input.members) {
    const email = emailKey(member.email)
    const person = (email ? byEmail.get(email) : undefined) ?? create(`u:${member.userId}`)

    person.userId ??= member.userId
    addName(person, member.name)
    if (email) {
      person.email ??= email
      byEmail.set(email, person)
    }
  }

  return people
}

function emailLocalParts(email: string | undefined): string[] {
  if (!email) return []

  const local = email.split("@")[0] ?? ""
  const parts = local.split(/[._+-]+/).filter(Boolean)

  return [...new Set([local, parts.join(" "), parts[0]].filter(Boolean))]
}

/** The query plus its form with a one-letter Hebrew prefix peeled ("לדנה" → "דנה"). */
function queryVariants(normalized: string): string[] {
  const variants = [normalized]
  const [first, ...rest] = normalized.split(" ")

  if (first && first.length > 2 && HEBREW_PREFIXES.includes(first[0])) {
    variants.push([first.slice(1), ...rest].join(" "))
  }

  return variants
}

function speakerById(input: ResolveOwnerInput, id: string | undefined) {
  return id ? input.speakers.find((speaker) => speaker.id === id) : undefined
}

function resolved(
  person: Person,
  method: OwnerResolutionMethod,
  ownerText: string | undefined,
  preferredSpeakerId?: string
): OwnerResolution {
  return {
    ownerText,
    participantId: person.participantId,
    speakerId: preferredSpeakerId ?? person.speakerIds[0],
    userId: person.userId,
    displayName: person.displayName ?? ownerText,
    confidence: CONFIDENCE[method],
    method,
  }
}

function unresolved(ownerText: string | undefined): OwnerResolution {
  const text = ownerText?.trim() || undefined

  return { ownerText: text, displayName: text, confidence: 0, method: "none" }
}

export function resolveOwner(input: ResolveOwnerInput): OwnerResolution {
  const ownerText = input.ownerText?.trim() || undefined
  const people = buildPeople(input)

  // 1. First person / model says the speaker owns it.
  if (input.ownerIsSourceSpeaker || isFirstPersonOwner(ownerText)) {
    const speaker = speakerById(input, input.sourceSpeakerId)

    if (speaker) {
      const person = people.find((candidate) => candidate.speakerIds.includes(speaker.id))

      if (person) return resolved(person, "source_speaker", ownerText, speaker.id)
    }
    // A first-person owner without a known speaker cannot be resolved.
    if (isFirstPersonOwner(ownerText) || !ownerText) return unresolved(ownerText)
  }

  if (!ownerText) return unresolved(ownerText)

  const normalized = normalizeOwnerName(ownerText)

  if (!normalized) return unresolved(ownerText)

  const variants = queryVariants(normalized)
  const tiers: Array<[OwnerResolutionMethod, (person: Person, query: string) => boolean]> = [
    ["full_name", (person, query) => person.names.has(query)],
    [
      "first_name",
      (person, query) => !query.includes(" ") && person.firstNames.has(query),
    ],
    [
      "alias",
      (person, query) =>
        (input.profileAliases ?? []).some((profile) => {
          const aliasHit = profile.aliases.some((alias) => normalizeOwnerName(alias) === query)

          if (!aliasHit) return false

          const profileEmail = emailKey(profile.email)

          if (profileEmail && person.email === profileEmail) return true

          return person.names.has(normalizeOwnerName(profile.name))
        }),
    ],
    [
      "email",
      (person, query) =>
        (person.email !== undefined && person.email === query) ||
        emailLocalParts(person.email).includes(query),
    ],
  ]

  for (const [method, matches] of tiers) {
    for (const query of variants) {
      const hits = people.filter((person) => matches(person, query))

      if (hits.length === 1) return resolved(hits[0], method, ownerText)
      // Two different people answer to this name: keep the text only.
      if (hits.length > 1) return unresolved(ownerText)
    }
  }

  return unresolved(ownerText)
}
