"use client"

/**
 * A seekable citation (M4 C5): action items, key quotes and Ask answers.
 *
 * "No citation, no claim": renders nothing unless the source resolves to a
 * real transcript segment. Clicking seeks (no autoplay, works without media)
 * and opens a peek with the speaker, time and quote, "Play from here" and
 * "Open in transcript".
 */
import { bcp47Lang } from "@/lib/i18n/lang-attribute"
import { useState } from "react"
import { PlayIcon, TextQuoteIcon } from "lucide-react"

import { useMeetingPlayer, type SeekSource } from "@/components/player/meeting-player-provider"
import { Button } from "@/components/ui/button"
import { CitationChip, formatTimecode } from "@/components/ui/meeting-atoms"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { directionForLanguage } from "@/components/speaker-display"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import { formatMessage } from "@/lib/i18n/messages"
import { cn } from "@/lib/utils"

export function PlayerCitation({
  segmentId,
  startMs,
  number,
  source = "citation",
  dictionary: t,
  className,
}: {
  segmentId?: string
  startMs?: number
  /** Shown as a numbered chip ("1") in Ask answers. */
  number?: number
  source?: SeekSource
  dictionary: Dictionary
  className?: string
}) {
  const player = useMeetingPlayer()
  const [open, setOpen] = useState(false)
  const resolved = player.resolve({ segmentId, startMs })

  if (!resolved) return null

  const segment = player.segments[resolved.segmentIndex]
  const speaker = player.speakerNameAt(resolved.segmentIndex)
  const seconds = resolved.startMs / 1000
  const ariaLabel =
    number !== undefined
      ? formatMessage(t.askCitation, { n: number, time: formatTimecode(seconds) })
      : formatMessage(t.transcriptPlayFrom, { time: formatTimecode(seconds) })
  const quoteDir = directionForLanguage(segment?.language) ?? undefined

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <CitationChip
            seconds={seconds}
            aria-label={ariaLabel}
            className={className}
            onClick={() => {
              player.seek(resolved.startMs, { source, segmentId: resolved.segmentId })
            }}
          />
        }
      />
      <PopoverContent align="start" className="w-80 gap-2">
        <div className="flex items-center gap-2 text-sm">
          {speaker ? (
            <b className="font-semibold">
              <bdi>{speaker}</bdi>
            </b>
          ) : null}
          <span className="font-mono text-xs text-fg-3 tabular-nums [direction:ltr] [unicode-bidi:isolate]">
            {formatTimecode(seconds)}
          </span>
        </div>
        {segment ? (
          <blockquote
            dir={quoteDir}
            lang={bcp47Lang(segment.language)}
            className="line-clamp-4 text-base text-fg"
          >
            {segment.text}
          </blockquote>
        ) : null}
        <div className="flex flex-wrap gap-1.5">
          {player.hasMedia ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                player.seek(resolved.startMs, { source, segmentId: resolved.segmentId, play: true })
                setOpen(false)
              }}
            >
              <PlayIcon className="fill-current" />
              {formatMessage(t.transcriptPlayFrom, { time: formatTimecode(seconds) })}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            className={cn(!player.hasMedia && "ps-2")}
            onClick={() => {
              player.emitCommand("openTranscript")
              player.seek(resolved.startMs, { source: "search", segmentId: resolved.segmentId })
              setOpen(false)
            }}
          >
            <TextQuoteIcon />
            {t.transcript}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
