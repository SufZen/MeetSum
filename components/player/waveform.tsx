"use client"

/**
 * Waveform canvas (M4 C3). Two identical canvases: the unplayed one in
 * `--fg-3`, the played one in `--brand`, clipped to the playhead. Both are
 * redrawn only when the size, peaks or theme change; playback only moves the
 * clip. Time runs left to right in every language.
 */
import { useEffect, useRef, useState } from "react"

import { downsamplePeaks, normalizePeaks, type PeaksFile } from "@/lib/media/peaks"
import { cn } from "@/lib/utils"

const BAR_WIDTH = 2
const BAR_GAP = 1

function drawBars(canvas: HTMLCanvasElement, heights: number[], color: string) {
  const context = canvas.getContext("2d")

  if (!context) return

  const ratio = window.devicePixelRatio || 1
  const width = canvas.clientWidth
  const height = canvas.clientHeight

  canvas.width = Math.max(1, Math.round(width * ratio))
  canvas.height = Math.max(1, Math.round(height * ratio))
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  context.clearRect(0, 0, width, height)
  context.fillStyle = color

  const step = BAR_WIDTH + BAR_GAP

  heights.forEach((value, index) => {
    const barHeight = Math.max(1.5, value * height)

    context.fillRect(index * step, (height - barHeight) / 2, BAR_WIDTH, barHeight)
  })
}

export function Waveform({
  peaks,
  progress,
  className,
}: {
  peaks: PeaksFile | null
  /** 0..1 played fraction. */
  progress: number
  className?: string
}) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const baseRef = useRef<HTMLCanvasElement>(null)
  const playedRef = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(0)
  const [themeTick, setThemeTick] = useState(0)

  useEffect(() => {
    const wrapper = wrapperRef.current

    if (!wrapper) return

    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)))

    observer.observe(wrapper)

    const themeObserver = new MutationObserver(() => setThemeTick((tick) => tick + 1))

    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })

    return () => {
      observer.disconnect()
      themeObserver.disconnect()
    }
  }, [])

  useEffect(() => {
    const base = baseRef.current
    const played = playedRef.current

    if (!base || !played || width <= 0) return

    const bars = Math.max(1, Math.floor(width / (BAR_WIDTH + BAR_GAP)))
    const heights = peaks?.peaks.length
      ? normalizePeaks(downsamplePeaks(peaks.peaks, bars), peaks.max || 255)
      : new Array<number>(bars).fill(0.08)

    drawBars(base, heights, getComputedStyle(base).color)
    drawBars(played, heights, getComputedStyle(played).color)
  }, [peaks, themeTick, width])

  const clipped = Math.min(100, Math.max(0, (1 - progress) * 100))

  return (
    <div ref={wrapperRef} aria-hidden className={cn("relative h-7 w-full", className)} dir="ltr">
      <canvas ref={baseRef} className="absolute inset-0 size-full text-fg-3 opacity-60" />
      <canvas
        ref={playedRef}
        className="absolute inset-0 size-full text-brand"
        style={{ clipPath: `inset(0 ${clipped}% 0 0)` }}
      />
    </div>
  )
}
