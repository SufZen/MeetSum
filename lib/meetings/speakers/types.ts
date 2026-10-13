/** A Meet participant's speaking interval, relative to meeting start. */
export type MeetTimelineEntry = {
  name: string
  email?: string
  startMs: number
  endMs: number
}

/**
 * Identity behind a Meet transcript speaker label. Display names are chosen
 * by participants (anonymous/phone guests freely), so only a signed-in user
 * whose Google identity resolved to a verified email can confirm a mapping.
 */
export type MeetSpeakerIdentity = {
  /** Sanitised display name used as the speaker label. */
  label: string
  kind: "signedin" | "anonymous" | "phone" | "unknown"
  /** `users/{id}` of a signed-in participant. */
  userId?: string
  /** Email the Google identity verifiably resolved to (lowercase). */
  verifiedEmail?: string
}

/** Tunables of the speaker suggestion engine (defaults per docs/parity/m3.md). */
export type SpeakerSuggestOptions = {
  /** Minimum combined score to suggest (MEETSUM_SPEAKER_SUGGEST_THRESHOLD). */
  threshold: number
  /** Score at/above which a suggestion is confirmed; undefined = never. */
  autoConfirmScore?: number
  /** Voiceprint matching (MEETSUM_VOICEPRINT_MATCHING). */
  voiceprintEnabled: boolean
  voiceprintThreshold: number
  /** Use the Meet transcript timeline for alignment (MEETSUM_SPEAKER_SUGGEST_USE_MEET). */
  useMeetTimeline: boolean
}

function numberFrom(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function speakerSuggestOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): SpeakerSuggestOptions {
  const autoConfirm = env.MEETSUM_SPEAKER_AUTO_CONFIRM_SCORE?.trim()

  return {
    threshold: numberFrom(env.MEETSUM_SPEAKER_SUGGEST_THRESHOLD, 0.5),
    autoConfirmScore: autoConfirm ? numberFrom(autoConfirm, Number.POSITIVE_INFINITY) : undefined,
    voiceprintEnabled: env.MEETSUM_VOICEPRINT_MATCHING === "true",
    voiceprintThreshold: numberFrom(env.MEETSUM_VOICEPRINT_THRESHOLD, 0.72),
    useMeetTimeline: env.MEETSUM_SPEAKER_SUGGEST_USE_MEET !== "false",
  }
}
