"use client"

/**
 * Client island of the public share page (M4 C8): the player (only when the
 * share includes the recording; media streams from `/api/share/<token>`) and
 * a read-only transcript. `?t=` positions the player; copied links point at
 * `/share/<token>?t=`.
 */
import { useCallback, useEffect, useMemo, useState } from "react"

import { MeetingPlayer } from "@/components/player/meeting-player"
import { MeetingPlayerProvider } from "@/components/player/meeting-player-provider"
import { useSpeakerDirectory } from "@/components/player/speaker-directory"
import { TranscriptView } from "@/components/transcript/transcript-view"
import { dictionaries } from "@/lib/i18n/dictionaries"
import type { MeetingMediaSummary } from "@/lib/media/playback-select"
import type { MeetingParticipant, MeetingSpeaker } from "@/lib/meetings/repository"
import type { TranscriptSegmentWire } from "@/lib/meetings/transcript-wire"
import { parseTimeParam } from "@/lib/player/deep-link"

export function SharedMeetingPlayer({
  token,
  meetingId,
  locale,
  language,
  media,
  segments,
  speakers,
  participants,
  durationMs,
  showTranscript,
}: {
  token: string
  meetingId: string
  locale: "he" | "en"
  language?: string
  /** Present only when the share includes the `media` section. */
  media?: MeetingMediaSummary
  segments: TranscriptSegmentWire[]
  speakers: MeetingSpeaker[]
  participants: MeetingParticipant[]
  durationMs?: number
  showTranscript: boolean
}) {
  const t = dictionaries[locale]
  const [initialMs, setInitialMs] = useState<number | undefined>()
  const directory = useSpeakerDirectory(speakers, participants, t.speakersGenericLabel)
  const speakerName = useCallback(
    (segment: { speaker: string; speakerId?: string }) => directory.forSegment(segment).name,
    [directory]
  )
  const visibleSegments = useMemo(() => (showTranscript ? segments : []), [segments, showTranscript])

  useEffect(() => {
    const ms = parseTimeParam(new URLSearchParams(window.location.search).get("t"))

    if (ms !== undefined) queueMicrotask(() => setInitialMs(ms))
  }, [])

  return (
    <MeetingPlayerProvider
      meetingId={meetingId}
      mediaBaseUrl={media?.available ? `/api/share/${encodeURIComponent(token)}` : undefined}
      media={media}
      segments={visibleSegments}
      durationMs={durationMs}
      initialMs={initialMs}
      dictionary={t}
      speakerName={speakerName}
    >
      <div className="grid gap-6">
        {media?.available ? (
          <div className="sticky top-0 z-(--z-sticky) bg-surface pt-2">
            <MeetingPlayer dictionary={t} locale={locale} directory={directory} />
          </div>
        ) : null}
        {showTranscript ? (
          <section className="grid gap-3">
            <h2 className="text-xl font-semibold">{t.transcript}</h2>
            <TranscriptView
              dictionary={t}
              locale={locale}
              shareToken={token}
              meetingLanguage={language}
              segments={visibleSegments}
              speakers={speakers}
              participants={participants}
              status="ready"
            />
          </section>
        ) : null}
      </div>
    </MeetingPlayerProvider>
  )
}
