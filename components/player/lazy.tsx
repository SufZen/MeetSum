"use client"

/**
 * Code-split entry points for the meeting view and the public share page:
 * the player (waveform, speaker lanes, video) and the virtualized transcript
 * load as their own chunks, behind skeletons sized like the real thing so
 * the layout doesn't jump. Both are browser-only (media elements, canvas,
 * scroll measurement), so they skip SSR.
 */
import dynamic from "next/dynamic"

import { TranscriptSkeleton } from "@/components/transcript/transcript-skeleton"
import { cn } from "@/lib/utils"

export function MeetingPlayerSkeleton({ className }: { className?: string }) {
  return (
    <div
      aria-busy="true"
      className={cn("h-34 animate-pulse rounded-xl bg-surface-2 ring-1 ring-line ring-inset", className)}
    />
  )
}

export const LazyMeetingPlayer = dynamic(
  () => import("@/components/player/meeting-player").then((mod) => mod.MeetingPlayer),
  { ssr: false, loading: () => <MeetingPlayerSkeleton className="mx-auto w-full max-w-5xl" /> }
)

export const LazyTranscriptView = dynamic(
  () => import("@/components/transcript/transcript-view").then((mod) => mod.TranscriptView),
  { ssr: false, loading: () => <TranscriptSkeleton /> }
)
