/**
 * Resolves an action item's spoken owner to a speaker, participant and
 * workspace member (owner: Package B). Step 0 stub: keeps the text only.
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

export function resolveOwner(input: ResolveOwnerInput): OwnerResolution {
  return {
    ownerText: input.ownerText,
    displayName: input.ownerText,
    confidence: 0,
    method: "none",
  }
}
