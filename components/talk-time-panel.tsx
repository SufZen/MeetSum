"use client"

/**
 * Talk time per speaker (M4 C6): stored `speakers.talk_time_ms`, share bar,
 * duration (spoken in aria), words, WPM and longest monologue. Speakers who
 * never spoke are hidden; the panel hides when there is nothing to show.
 */
import { useId, useMemo } from "react"

import { useI18n } from "@/components/i18n-provider"
import { useSpeakerDirectory } from "@/components/player/speaker-directory"
import { SpeakerAvatar } from "@/components/ui/meeting-atoms"
import { formatMessage, type Dictionary } from "@/lib/i18n/dictionaries"
import type { MeetingParticipant, MeetingSpeaker } from "@/lib/meetings/repository"
import { speakerColorVar } from "@/lib/player/speaker-colors"
import { buildTalkTimeRows, type TimelineSegment } from "@/lib/player/speaker-timeline"
import { formatClock } from "@/lib/player/time-format"
import { cn } from "@/lib/utils"

export function TalkTimePanel({
  dictionary: t,
  speakers,
  participants = [],
  segments = [],
  className,
}: {
  dictionary: Dictionary
  /** Kept for callers; formatting follows the I18nProvider locale. */
  locale?: string
  speakers: readonly MeetingSpeaker[]
  participants?: readonly MeetingParticipant[]
  segments?: readonly TimelineSegment[]
  className?: string
}) {
  const { plural, fmt } = useI18n()
  const directory = useSpeakerDirectory(speakers, participants, t.speakersGenericLabel)
  const rows = useMemo(() => buildTalkTimeRows(speakers, segments), [segments, speakers])
  const titleId = useId()

  if (!rows.length) return null

  return (
    <section className={cn("grid gap-3", className)} aria-labelledby={titleId}>
      <h3 id={titleId} className="text-sm font-semibold">
        {t.talkTimeTitle}
      </h3>
      <ul className="grid gap-2.5">
        {rows.map((row) => {
          const speaker = speakers.find((candidate) => candidate.id === row.speakerId)
          const display = directory.forSegment({ speaker: speaker?.label ?? "", speakerId: row.speakerId })
          const percent = Math.round(row.share * 100)

          return (
            <li key={row.speakerId} className="grid gap-1">
              <div className="flex min-w-0 items-center gap-2 text-sm">
                <SpeakerAvatar
                  initials={display.initials}
                  color={display.color}
                  size="xs"
                  unconfirmed={display.unconfirmed}
                />
                <bdi className="min-w-0 flex-1 truncate font-medium">{display.name}</bdi>
                <span className="shrink-0 font-mono text-xs text-fg-2 tabular-nums [direction:ltr] [unicode-bidi:isolate]">
                  {fmt.percent(row.share)}
                </span>
                <time
                  dir="ltr"
                  aria-label={fmt.duration(row.talkTimeMs)}
                  className="w-14 shrink-0 text-end font-mono text-xs text-fg-3 tabular-nums"
                >
                  {formatClock(row.talkTimeMs)}
                </time>
              </div>
              <div
                aria-hidden
                className="h-1.5 overflow-hidden rounded-full bg-surface-3 forced-color-adjust-none"
              >
                <div
                  className="h-full rounded-full"
                  style={{ width: `${Math.max(1, percent)}%`, backgroundColor: speakerColorVar(display.color) }}
                />
              </div>
              <div className="flex flex-wrap gap-x-3 text-xs text-fg-3">
                {row.wordCount ? (
                  <span>{plural("mtgWordCount", row.wordCount, { count: fmt.number(row.wordCount) })}</span>
                ) : null}
                {row.wpm ? <span>{formatMessage(t.talkTimeWpm, { count: fmt.number(row.wpm) })}</span> : null}
                {row.longestMonologueMs ? (
                  <span>
                    {formatMessage(t.talkTimeLongest, { time: "" }).trim()}{" "}
                    <time dir="ltr" className="font-mono tabular-nums">
                      {formatClock(row.longestMonologueMs)}
                    </time>
                  </span>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
