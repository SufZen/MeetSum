import { speakerColor, type SpeakerColor } from "@/components/ui/meeting-atoms"
import { formatMessage } from "@/lib/i18n/messages"
import type {
  MeetingParticipant,
  MeetingSpeaker,
  SpeakerSuggestionReason,
  TranscriptSegment,
} from "@/lib/meetings/repository"

/**
 * Pure display helpers for diarized speakers (M3 C6): localized generic
 * labels ("דובר 2"), resolved names, unconfirmed state, colours by first
 * speech, talk-time share and text direction from a known language.
 */

const GENERIC_LABEL = /^Speaker (\d+)$/

/** `Speaker 3` → 3; anything else → undefined. */
export function genericSpeakerNumber(label: string): number | undefined {
  const match = GENERIC_LABEL.exec(label.trim())

  return match ? Number(match[1]) : undefined
}

/** Localizes `Speaker N` with a `{n}` template; other labels pass through. */
export function localizeSpeakerLabel(label: string, template: string): string {
  const n = genericSpeakerNumber(label)

  return n === undefined ? label : formatMessage(template, { n })
}

export type SpeakerDisplay = {
  name: string
  /** A real name that no person has confirmed yet (show "unconfirmed"). */
  unconfirmed: boolean
  /** Still a generic diarization label. */
  generic: boolean
}

/**
 * Display = participant name → speaker display name → localized label.
 * Suggestions are never shown as the name: they appear as a separate chip
 * until confirmed.
 */
export function speakerDisplay(
  speaker: Pick<MeetingSpeaker, "label" | "displayName" | "participantId" | "mappingStatus">,
  participants: Pick<MeetingParticipant, "id" | "name">[],
  template: string
): SpeakerDisplay {
  const participantName = speaker.participantId
    ? participants.find((participant) => participant.id === speaker.participantId)?.name
    : undefined
  const realName = participantName ?? speaker.displayName

  if (realName?.trim()) {
    return {
      name: realName,
      unconfirmed: speaker.mappingStatus !== "confirmed",
      generic: false,
    }
  }

  return { name: localizeSpeakerLabel(speaker.label, template), unconfirmed: false, generic: true }
}

/** Speakers ordered by first speech (stable colour order). */
export function orderSpeakers<T extends Pick<MeetingSpeaker, "id" | "label" | "firstStartMs">>(speakers: T[]): T[] {
  return [...speakers].sort((a, b) => {
    const first = (a.firstStartMs ?? Number.MAX_SAFE_INTEGER) - (b.firstStartMs ?? Number.MAX_SAFE_INTEGER)

    if (first) return first

    return (genericSpeakerNumber(a.label) ?? 0) - (genericSpeakerNumber(b.label) ?? 0) || a.label.localeCompare(b.label)
  })
}

/** Speaker id → colour, assigned in order of first speech. */
export function speakerColors(
  speakers: Pick<MeetingSpeaker, "id" | "label" | "firstStartMs">[]
): Map<string, SpeakerColor> {
  return new Map(orderSpeakers(speakers).map((speaker, index) => [speaker.id, speakerColor(index)]))
}

/** Avatar initials: the number for generic labels, else first letters. */
export function speakerInitials(display: SpeakerDisplay, label: string): string {
  if (display.generic) {
    const n = genericSpeakerNumber(label)

    return n === undefined ? Array.from(display.name.trim())[0] ?? "?" : String(n)
  }

  const words = display.name.trim().split(/\s+/).filter(Boolean)

  return words
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? "")
    .join("")
    .toLocaleUpperCase()
}

/** Talk-time share as a whole percent string, e.g. "42%". */
export function talkTimeShare(talkTimeMs: number, totalTalkTimeMs: number): string {
  if (!totalTalkTimeMs || talkTimeMs <= 0) return "0%"

  return `${Math.round((talkTimeMs / totalTalkTimeMs) * 100)}%`
}

const RTL_LANGUAGES = new Set(["he", "iw", "heb", "ar", "fa", "ur", "yi"])

/**
 * Paragraph direction from a known language code (segment or meeting).
 * Returns undefined when the language is unknown or mixed, so the caller can
 * fall back to `dir="auto"`.
 */
export function directionForLanguage(language?: string): "rtl" | "ltr" | undefined {
  const code = language?.toLowerCase().split(/[-_]/)[0]

  if (!code || code === "mixed" || code === "auto" || code === "unknown") return undefined

  return RTL_LANGUAGES.has(code) ? "rtl" : "ltr"
}

export type SegmentSpeaker = SpeakerDisplay & { color: SpeakerColor; speakerId?: string; initials: string }

/** Resolves the speaker shown on a transcript segment. */
export function resolveSegmentSpeaker(
  segment: Pick<TranscriptSegment, "speaker" | "speakerId">,
  speakers: MeetingSpeaker[],
  participants: Pick<MeetingParticipant, "id" | "name">[],
  colors: Map<string, SpeakerColor>,
  template: string
): SegmentSpeaker {
  const speaker = segment.speakerId
    ? speakers.find((candidate) => candidate.id === segment.speakerId)
    : speakers.find((candidate) => candidate.label === segment.speaker)

  if (speaker) {
    const display = speakerDisplay(speaker, participants, template)

    return {
      ...display,
      speakerId: speaker.id,
      color: colors.get(speaker.id) ?? speakerColor(0),
      initials: speakerInitials(display, speaker.label),
    }
  }

  // Legacy segments: the stored name is already resolved by the read join.
  const generic = genericSpeakerNumber(segment.speaker) !== undefined
  const display = {
    name: localizeSpeakerLabel(segment.speaker, template),
    unconfirmed: false,
    generic,
  }
  const n = genericSpeakerNumber(segment.speaker)

  return {
    ...display,
    color: speakerColor(n === undefined ? 0 : n - 1),
    initials: speakerInitials(display, segment.speaker),
  }
}

/** Dictionary key of the human-readable reason for a suggestion signal. */
export const SUGGESTION_REASON_KEYS = {
  meet_alignment: "speakersReasonMeetAlignment",
  self_intro: "speakersReasonSelfIntro",
  addressed_by_name: "speakersReasonAddressedByName",
  single_remaining: "speakersReasonSingleRemaining",
  organizer_owner: "speakersReasonOrganizerOwner",
  workspace_memory: "speakersReasonWorkspaceMemory",
  voiceprint: "speakersReasonVoiceprint",
} as const satisfies Record<SpeakerSuggestionReason["kind"], string>

/** Strongest reason first. */
export function sortReasons(reasons: SpeakerSuggestionReason[]): SpeakerSuggestionReason[] {
  return [...reasons].sort((a, b) => b.weight - a.weight)
}
