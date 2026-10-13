"use client"

import { useMemo, useState } from "react"
import { SearchIcon } from "lucide-react"

import {
  directionForLanguage,
  resolveSegmentSpeaker,
  speakerColors,
} from "@/components/speaker-display"
import { SpeakerMappingPanel } from "@/components/speaker-mapping-panel"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { SpeakerAvatar } from "@/components/ui/meeting-atoms"
import { dictionaries, type Dictionary } from "@/lib/i18n/dictionaries"
import { formatTimestamp } from "@/lib/meetings/duration"
import type {
  MeetingParticipant,
  MeetingSpeaker,
  TranscriptSegment,
} from "@/lib/meetings/repository"

export function TranscriptTimeline({
  dictionary: t = dictionaries.en,
  meetingId,
  meetingLanguage,
  segments,
  speakers = [],
  participants = [],
  onEditSpeakers,
  onSpeakersChanged,
}: {
  dictionary?: Dictionary
  /** Mounts the speaker mapping panel when set. */
  meetingId?: string
  meetingLanguage?: string
  segments?: TranscriptSegment[]
  speakers?: MeetingSpeaker[]
  participants?: MeetingParticipant[]
  onEditSpeakers?: () => void
  onSpeakersChanged?: () => void
}) {
  const [query, setQuery] = useState("")
  const colors = useMemo(() => speakerColors(speakers), [speakers])
  const resolved = useMemo(
    () =>
      (segments ?? []).map((segment) => ({
        segment,
        speaker: resolveSegmentSpeaker(segment, speakers, participants, colors, t.speakersGenericLabel),
      })),
    [colors, participants, segments, speakers, t.speakersGenericLabel]
  )
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()

    if (!needle) return resolved

    return resolved.filter(({ segment, speaker }) =>
      [speaker.name, segment.speaker, segment.text, segment.language]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase()
        .includes(needle)
    )
  }, [query, resolved])
  const meetingDir = directionForLanguage(meetingLanguage)

  if (!segments?.length) {
    return (
      <div className="flex min-h-56 items-center justify-center rounded-md border border-dashed border-line bg-surface-2 p-6 text-center text-sm text-fg-3">
        {t.transcriptEmptyState}
      </div>
    )
  }

  return (
    <div className="grid gap-4">
      <div className="sticky top-0 z-10 flex min-h-10 flex-wrap items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-1.5">
        <SearchIcon aria-hidden="true" className="size-4 text-fg-3" />
        <Input
          dir="auto"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t.transcriptSearchPlaceholder}
          aria-label={t.transcriptSearchPlaceholder}
          className="h-9 flex-1 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
        />
        <span className="font-mono text-xs text-fg-3 tabular-nums [direction:ltr] [unicode-bidi:isolate]">
          {filtered.length}/{segments.length}
        </span>
      </div>

      {meetingId ? (
        <SpeakerMappingPanel
          meetingId={meetingId}
          dictionary={t}
          meetingLanguage={meetingLanguage}
          onChanged={onSpeakersChanged}
          onManageParticipants={onEditSpeakers}
        />
      ) : null}

      <div className="grid gap-2">
        {filtered.map(({ segment, speaker }) => {
          const textDir = directionForLanguage(segment.language) ?? meetingDir ?? "auto"

          return (
            <article
              key={segment.id}
              className="grid gap-2 rounded-lg border border-line bg-surface p-3 text-sm"
            >
              <div className="flex min-h-7 flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <SpeakerAvatar
                    initials={speaker.initials}
                    color={speaker.color}
                    size="xs"
                    unconfirmed={speaker.unconfirmed}
                  />
                  <span className="min-w-0 truncate font-medium text-fg">
                    <bdi dir="auto">{speaker.name}</bdi>
                  </span>
                  {speaker.unconfirmed ? (
                    <small className="text-xs text-warn-text">{t.speakersUnconfirmed}</small>
                  ) : null}
                  {segment.language && (
                    <Badge variant="secondary" className="h-6 rounded-sm">
                      {segment.language}
                    </Badge>
                  )}
                </div>
                <span className="font-mono text-xs text-fg-3 tabular-nums [direction:ltr] [unicode-bidi:isolate]">
                  {formatTimestamp(segment.startMs)}
                </span>
              </div>
              <p dir={textDir} className="text-start leading-7 text-fg-2">
                {segment.text}
              </p>
            </article>
          )
        })}
        {!filtered.length && (
          <div className="rounded-lg border border-dashed border-line bg-surface p-6 text-center text-sm text-fg-3">
            {t.transcriptNoMatches}
          </div>
        )}
      </div>
    </div>
  )
}
