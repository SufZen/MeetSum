"use client"

/**
 * Speaker lanes under the scrubber (M4 C3). Expanded: one lane per speaker,
 * ordered by first speech, avatar at the start. Collapsed (compact player):
 * one colour-coded lane. The speaking lane lifts while playing and the rest
 * dim. A physical LTR time axis in every language; click seeks. The lanes
 * are a pointer shortcut (the scrubber and transcript are the accessible
 * controls), so they are hidden from assistive tech; markers stay focusable.
 */
import type { MouseEvent } from "react"

import { usePlayerState } from "@/components/player/meeting-player-provider"
import { SpeakerAvatar, type SpeakerColor } from "@/components/ui/meeting-atoms"
import type { PlayerMarker } from "@/lib/player/citations"
import { speakerColorVar } from "@/lib/player/speaker-colors"
import type { SpeakerLane } from "@/lib/player/speaker-timeline"
import { formatClock } from "@/lib/player/time-format"
import { formatMessage } from "@/lib/i18n/dictionaries"
import { cn } from "@/lib/utils"

export type LaneSpeaker = { name: string; initials: string; color: SpeakerColor; unconfirmed?: boolean }

function percent(ms: number, durationMs: number) {
  return durationMs > 0 ? Math.min(100, Math.max(0, (ms / durationMs) * 100)) : 0
}

export function SpeakerTimelineBar({
  lanes,
  durationMs,
  speakerFor,
  activeLaneKey,
  compact,
  markers,
  markerLabels,
  speakerAtTemplate,
  onSeek,
}: {
  lanes: readonly SpeakerLane[]
  durationMs: number
  speakerFor: (lane: SpeakerLane) => LaneSpeaker
  activeLaneKey?: string
  compact: boolean
  markers: readonly PlayerMarker[]
  markerLabels: Record<PlayerMarker["kind"], string>
  /** "{speaker} · {time}" */
  speakerAtTemplate: string
  onSeek: (ms: number, source: "speaker_bar" | "marker") => void
}) {
  const playing = usePlayerState((state) => state.playing)

  const seekFromClick = (event: MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()

    if (rect.width <= 0 || durationMs <= 0) return
    onSeek(((event.clientX - rect.left) / rect.width) * durationMs, "speaker_bar")
  }

  if (!lanes.length && !markers.length) return null

  return (
    <div dir="ltr" className="grid gap-0.5">
      {lanes.length ? (
        <div
          aria-hidden
          className={cn(
            "relative cursor-pointer transition-[height] duration-(--dur-4) ease-out",
            compact ? "h-4" : ""
          )}
          style={compact ? undefined : { height: `${lanes.length * 1.25}rem` }}
          onClick={seekFromClick}
        >
          {lanes.map((lane, laneIndex) => {
            const speaker = speakerFor(lane)
            const color = speakerColorVar(speaker.color)
            const speaking = playing && lane.key === activeLaneKey

            return (
              <div
                key={lane.key}
                className="absolute inset-x-0 h-5 transition-[top] duration-(--dur-4) ease-out"
                style={{ top: compact ? 0 : `${laneIndex * 1.25}rem` }}
              >
                {!compact || laneIndex === 0 ? (
                  <span className="absolute inset-x-0 top-2.5 h-px rounded-full bg-line" />
                ) : null}
                {!compact ? (
                  <SpeakerAvatar
                    initials={speaker.initials}
                    color={speaker.color}
                    size="xs"
                    unconfirmed={speaker.unconfirmed}
                    className="absolute -start-7 top-0 hidden rail:inline-grid"
                  />
                ) : null}
                {lane.runs.map((run) => (
                  <span
                    key={run.startMs}
                    title={formatMessage(speakerAtTemplate, {
                      speaker: speaker.name,
                      time: formatClock(run.startMs),
                    })}
                    className={cn(
                      "absolute rounded-xs forced-color-adjust-none transition-[opacity,top,height,box-shadow] duration-(--dur-2) ease-standard",
                      speaking ? "top-1 h-3 opacity-100" : "top-1.5 h-2",
                      playing && !speaking ? "opacity-45" : !speaking ? "opacity-85" : ""
                    )}
                    style={{
                      left: `${percent(run.startMs, durationMs)}%`,
                      width: `max(2px, ${percent(run.endMs - run.startMs, durationMs)}%)`,
                      backgroundColor: color,
                      ...(speaking
                        ? { boxShadow: `0 0 0 3px color-mix(in oklch, ${color} 22%, transparent)` }
                        : {}),
                    }}
                  />
                ))}
              </div>
            )
          })}
        </div>
      ) : null}
      {markers.length ? (
        <div className="relative h-4">
          {markers.map((marker) => (
            <button
              key={marker.id}
              type="button"
              aria-label={`${markerLabels[marker.kind]}: ${marker.label}, ${formatClock(marker.startMs)}`}
              title={marker.label}
              className="group/marker absolute top-0.5 size-3.5 -translate-x-1/2 rounded-full outline-none focus-visible:shadow-focus focus-visible:outline-2 focus-visible:outline-transparent"
              style={{ left: `${percent(marker.startMs, durationMs)}%` }}
              onClick={() => onSeek(marker.startMs, "marker")}
            >
              <span
                aria-hidden
                className={cn(
                  "absolute inset-0.75 transition-transform duration-(--dur-2) ease-standard group-hover/marker:scale-140",
                  marker.kind === "action_item" && "rounded-full bg-mark-action",
                  marker.kind === "search_match" && "rounded-full bg-surface-2 ring-2 ring-info ring-inset",
                  marker.kind === "chapter" && "rotate-45 rounded-xs bg-brand"
                )}
              />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
