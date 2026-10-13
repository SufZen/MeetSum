"use client"

import { useEffect, useState } from "react"

import { botApi } from "@/components/bot/bot-api"
import {
  liveSegmentDir,
  parseLiveEvent,
  upsertLiveSegment,
} from "@/components/bot/live-transcript-state"
import type { BotLiveSegmentEvent } from "@/lib/bot/api-types"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import { cn } from "@/lib/utils"

/**
 * Live draft transcript (M7 B8, behind MEETSUM_LIVE_TRANSCRIPT). Mounted only
 * while the bot records. It renders nothing until the SSE stream opens, so
 * with the flag off (404 live_unavailable) it never appears. ASR text, not
 * AI-written: no iris styling. No aria-live on the stream (README §9).
 */
export function LiveTranscriptPanel({
  meetingId,
  meetingLanguage,
  dictionary,
}: {
  meetingId: string
  meetingLanguage?: string | null
  dictionary: Dictionary
}) {
  const [open, setOpen] = useState(false)
  const [segments, setSegments] = useState<BotLiveSegmentEvent[]>([])

  useEffect(() => {
    if (typeof EventSource === "undefined") return

    const source = new EventSource(botApi.liveUrl(meetingId))

    source.onopen = () => setOpen(true)
    source.onerror = () => {
      // 404 (flag off) or a dropped stream: stop instead of reconnecting forever.
      if (source.readyState === EventSource.CLOSED) setOpen(false)
    }
    source.addEventListener("segment", (event) => {
      const segment = parseLiveEvent<BotLiveSegmentEvent>((event as MessageEvent<string>).data)

      if (segment) setSegments((current) => upsertLiveSegment(current, segment))
    })
    source.addEventListener("end", () => {
      source.close()
    })

    return () => source.close()
  }, [meetingId])

  if (!open && segments.length === 0) return null

  return (
    <section className="grid gap-2 rounded-lg border border-line bg-surface-2 p-3">
      <h3 className="text-xs font-medium text-fg-3">{dictionary.botLiveLabel}</h3>
      <ol className="ms-scrollbar grid max-h-48 gap-1.5 overflow-y-auto text-sm leading-6">
        {segments.map((segment) => (
          <li
            key={segment.id}
            dir={liveSegmentDir(segment.language, meetingLanguage)}
            className={cn(segment.final ? "text-fg" : "text-fg-3")}
          >
            <bdi className="me-1.5 font-medium">
              {segment.speaker || dictionary.botLiveSpeakerUnknown}
            </bdi>
            {segment.text}
          </li>
        ))}
      </ol>
    </section>
  )
}
