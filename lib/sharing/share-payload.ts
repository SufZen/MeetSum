/**
 * Public share payload (M4 security). The share page renders, and the
 * `SharedMeetingPlayer` client island receives, ONLY what this pure builder
 * returns — never the hydrated `MeetingRecord`. Every field is gated on the
 * share's `includedSections`:
 *
 * - always: title, start time, source, language, document locale, duration
 * - `participants`: participant display names (never emails/ids) + count
 * - `summary`: overview; `decisions`: decision strings
 * - `action_items`: title/owner/due/priority (no ids, quotes or AI metadata)
 * - `transcript`: segments + words with opaque per-payload ids, sanitized
 *   speakers (resolved display name + talk stats; no participant/profile ids,
 *   suggestions or embeddings) and the transcription provider/model
 * - `media`: playback summary with opaque asset ids (the routes gate media
 *   separately)
 *
 * Internal ids (meeting, workspace, owner, segment, speaker, asset), storage
 * keys and AI run metadata never appear. Call it only after the password
 * gate has passed.
 */
import { describeMeetingMedia, type MeetingMediaSummary } from "@/lib/media/playback-select"
import { getMeetingDurationMs } from "@/lib/meetings/duration"
import type {
  MeetingRecord,
  MeetingShare,
  MeetingSpeaker,
} from "@/lib/meetings/repository"
import type { TranscriptSegmentWire } from "@/lib/meetings/transcript-wire"
import { encodeWords } from "@/lib/meetings/transcript-words"
import { verifyShareAccessCookie } from "@/lib/sharing/share-access"
import { getShareDocumentLocale } from "@/lib/sharing/share-locale"

export type ShareActionItem = {
  key: string
  title: string
  owner?: string
  dueDate?: string
  priority?: string
}

export type ShareTranscript = {
  segments: TranscriptSegmentWire[]
  /** `MeetingSpeaker`-shaped for the shared TranscriptView; ids are opaque. */
  speakers: MeetingSpeaker[]
  transcription?: { provider: string; model?: string }
}

export type SharePayload = {
  title: string
  startedAt: string
  source: string
  language: string
  lang: "he" | "en"
  durationMs?: number
  participants?: string[]
  overview?: string
  decisions?: string[]
  actionItems?: ShareActionItem[]
  transcript?: ShareTranscript
  media?: MeetingMediaSummary
}

type ShareMeeting = Pick<
  MeetingRecord,
  | "title"
  | "startedAt"
  | "source"
  | "language"
  | "languageMetadata"
  | "participants"
  | "participantDetails"
  | "summary"
  | "transcript"
  | "speakers"
  | "aiRuns"
  | "mediaAssets"
  | "durationMs"
  | "meetConferenceRecords"
>

function participantNames(meeting: ShareMeeting): string[] {
  const names = meeting.participantDetails?.length
    ? meeting.participantDetails.map((participant) => participant.name)
    : meeting.participants.map((participant) =>
        // Legacy participants can be raw emails: show the local part only.
        participant.includes("@") ? participant.split("@")[0] : participant
      )

  return [...new Set(names.map((name) => name.trim()).filter(Boolean))]
}

function shareTranscript(meeting: ShareMeeting): ShareTranscript {
  const participantName = new Map(
    (meeting.participantDetails ?? []).map((participant) => [participant.id, participant.name])
  )
  const speakerIds = new Map<string, string>()
  const speakers: MeetingSpeaker[] = (meeting.speakers ?? []).map((speaker, index) => {
    const id = `spk_${index + 1}`
    const resolvedName =
      (speaker.participantId ? participantName.get(speaker.participantId) : undefined) ??
      speaker.displayName

    speakerIds.set(speaker.id, id)

    return {
      id,
      meetingId: "",
      label: speaker.label,
      ...(resolvedName?.trim() ? { displayName: resolvedName } : {}),
      mappingStatus: speaker.mappingStatus === "confirmed" ? "confirmed" : "unmapped",
      source: "share",
      talkTimeMs: speaker.talkTimeMs,
      wordCount: speaker.wordCount,
      segmentCount: speaker.segmentCount,
      ...(speaker.firstStartMs !== undefined ? { firstStartMs: speaker.firstStartMs } : {}),
    }
  })
  const segments: TranscriptSegmentWire[] = (meeting.transcript ?? []).map((segment, index) => {
    const speakerId = segment.speakerId ? speakerIds.get(segment.speakerId) : undefined

    return {
      id: `seg_${index + 1}`,
      speaker: segment.speaker,
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
      ...(segment.language ? { language: segment.language } : {}),
      ...(speakerId ? { speakerId } : {}),
      ...(segment.turnIndex !== undefined ? { turnIndex: segment.turnIndex } : {}),
      ...(segment.words?.length ? { words: encodeWords(segment.words, segment.language) } : {}),
    }
  })
  const run = meeting.aiRuns?.find(
    (candidate) => candidate.task === "audio.transcribe" && candidate.status === "completed"
  )

  return {
    segments,
    speakers,
    ...(run
      ? { transcription: { provider: run.provider, ...(run.model ? { model: run.model } : {}) } }
      : {}),
  }
}

function shareMedia(meeting: ShareMeeting): MeetingMediaSummary {
  const summary = describeMeetingMedia(meeting.mediaAssets ?? [])

  // Asset ids are internal; the share routes pick the asset themselves.
  return {
    ...summary,
    ...(summary.audio ? { audio: { ...summary.audio, assetId: "audio" } } : {}),
    ...(summary.video ? { video: { ...summary.video, assetId: "video" } } : {}),
  }
}

export function buildSharePayload(
  share: Pick<MeetingShare, "includedSections">,
  meeting: ShareMeeting
): SharePayload {
  const includes = new Set(share.includedSections)
  const { lang } = getShareDocumentLocale(meeting)
  const durationMs = getMeetingDurationMs(meeting)
  const summary = meeting.summary

  return {
    title: meeting.title,
    startedAt: meeting.startedAt,
    source: meeting.source,
    language: meeting.language,
    lang,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(includes.has("participants") ? { participants: participantNames(meeting) } : {}),
    ...(includes.has("summary") ? { overview: summary?.overview ?? "" } : {}),
    ...(includes.has("decisions") ? { decisions: [...(summary?.decisions ?? [])] } : {}),
    ...(includes.has("action_items")
      ? {
          actionItems: (summary?.actionItems ?? []).map((item, index) => ({
            key: `ai_${index + 1}`,
            title: item.title,
            ...(item.owner ? { owner: item.owner } : {}),
            ...(item.dueDate ? { dueDate: item.dueDate } : {}),
            ...(item.priority ? { priority: item.priority } : {}),
          })),
        }
      : {}),
    ...(includes.has("transcript") ? { transcript: shareTranscript(meeting) } : {}),
    ...(includes.has("media") ? { media: shareMedia(meeting) } : {}),
  }
}

export type SharePageData =
  | { status: "password_required" }
  | { status: "ok"; payload: SharePayload }

export type SharePageDeps = {
  /** Share lookup (the page passes its per-request memoized loader). */
  lookup: (token: string) => Promise<{ share: MeetingShare; meeting: MeetingRecord } | undefined>
  /** Raw value of the share-access cookie, if any. */
  accessCookie?: string
  secret: () => string
  now?: () => number
}

/**
 * Data loader of the public share page: resolves the token, enforces the
 * password gate (signed share-access cookie) BEFORE anything about the
 * meeting is derived, then returns the section-gated payload. `undefined`
 * means "not found".
 */
export async function loadSharePageData(
  token: string,
  deps: SharePageDeps
): Promise<SharePageData | undefined> {
  const result = await deps.lookup(token)

  if (!result) return undefined

  const { share, meeting } = result

  if (share.passwordHash) {
    const valid = verifyShareAccessCookie(deps.accessCookie, {
      token,
      passwordHash: share.passwordHash,
      secret: deps.secret(),
      ...(deps.now ? { now: deps.now() } : {}),
    })

    if (!valid) return { status: "password_required" }
  }

  return { status: "ok", payload: buildSharePayload(share, meeting) }
}
