"use client"

/**
 * The share page's client island as its own chunk (M10 C, lever 5): the
 * player provider, store and transcript wiring leave the share route's first
 * load. It still renders on the server, so the skeleton (player bar plus
 * transcript block, the island's own boxes) only shows before the chunk
 * lands on a client-side render.
 */
import dynamic from "next/dynamic"

export const SharedMeetingPlayer = dynamic(
  () => import("@/components/share/shared-meeting-player").then((mod) => mod.SharedMeetingPlayer),
  {
    loading: () => (
      <div aria-busy="true" className="grid gap-6">
        <div className="h-14 animate-pulse rounded-md bg-surface-2" />
        <div className="h-64 animate-pulse rounded-md bg-surface-2" />
      </div>
    ),
  }
)
