"use client"

/**
 * Keyboard + pointer scrubber over the waveform (M4 C3, C9).
 *
 * ARIA slider: arrows ±5 s (Shift ±1 s), Page Up/Down ±30 s, Home/End.
 * The track is a physical LTR time axis in every language
 * (`dir="ltr"`); click or drag to seek (WCAG 2.5.7: the keyboard slider is
 * the non-drag alternative).
 */
import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react"

import { usePlayerState } from "@/components/player/meeting-player-provider"
import { sliderActionForKey } from "@/lib/player/keyboard"
import { formatSpokenDuration } from "@/lib/meetings/duration"
import { formatClock } from "@/lib/player/time-format"
import { formatMessage } from "@/lib/i18n/messages"
import { cn } from "@/lib/utils"

export function Scrubber({
  durationMs,
  label,
  timeOfTemplate,
  locale,
  onSeek,
  onToggle,
  children,
  className,
}: {
  durationMs: number
  label: string
  /** "{current} of {total}" */
  timeOfTemplate: string
  locale: string
  onSeek: (ms: number, source: "scrubber" | "keyboard") => void
  onToggle: () => void
  /** Waveform / lanes drawn under the playhead. */
  children?: ReactNode
  className?: string
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [dragMs, setDragMs] = useState<number | null>(null)
  const [hoverRatio, setHoverRatio] = useState<number | null>(null)
  const currentMs = usePlayerState((state) => state.currentMs)
  const bufferedMs = usePlayerState((state) => state.bufferedMs)
  const shownMs = dragMs ?? currentMs
  const ratio = durationMs > 0 ? Math.min(1, Math.max(0, shownMs / durationMs)) : 0
  const bufferedRatio = durationMs > 0 ? Math.min(1, bufferedMs / durationMs) : 0

  const msFromPointer = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect()

    if (!rect || rect.width <= 0 || durationMs <= 0) return 0

    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * durationMs
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || durationMs <= 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragMs(msFromPointer(event.clientX))
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const rect = trackRef.current?.getBoundingClientRect()

    if (rect && rect.width > 0) {
      setHoverRatio(Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)))
    }
    if (dragMs !== null) setDragMs(msFromPointer(event.clientX))
  }

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (dragMs === null) return
    onSeek(msFromPointer(event.clientX), "scrubber")
    setDragMs(null)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.code === "Space" || event.code === "Enter") {
      event.preventDefault()
      event.stopPropagation()
      onToggle()
      return
    }

    const action = sliderActionForKey(event)

    if (!action) return
    event.preventDefault()
    event.stopPropagation()
    if (action.type === "skip") onSeek(currentMs + action.ms, "keyboard")
    if (action.type === "seekPercent") onSeek((durationMs * action.percent) / 100, "keyboard")
  }

  const valueText = formatMessage(timeOfTemplate, {
    current: formatSpokenDuration(shownMs, locale),
    total: formatSpokenDuration(durationMs, locale),
  })

  return (
    <div dir="ltr" className={cn("relative select-none", className)}>
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={Math.round(durationMs / 1000)}
        aria-valuenow={Math.round(shownMs / 1000)}
        aria-valuetext={valueText}
        aria-disabled={durationMs <= 0 || undefined}
        className="group/scrub relative cursor-pointer touch-none rounded-sm outline-none focus-visible:shadow-focus focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-transparent"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDragMs(null)}
        onPointerLeave={() => setHoverRatio(null)}
        onKeyDown={onKeyDown}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 rounded-sm bg-surface-3"
          style={{ left: 0, width: `${bufferedRatio * 100}%`, opacity: 0.5 }}
        />
        <div className="relative">{children}</div>
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-full bg-fg"
          style={{ left: `${ratio * 100}%` }}
        >
          <span className="absolute -top-1 start-1/2 size-2 -translate-x-1/2 rounded-full bg-fg" />
        </div>
        {hoverRatio !== null && durationMs > 0 ? (
          <span
            aria-hidden
            className="pointer-events-none absolute -top-6 -translate-x-1/2 rounded-xs bg-fg px-1.5 py-0.5 font-mono text-2xs text-surface tabular-nums"
            style={{ left: `${hoverRatio * 100}%` }}
          >
            {formatClock(hoverRatio * durationMs)}
          </span>
        ) : null}
      </div>
    </div>
  )
}
