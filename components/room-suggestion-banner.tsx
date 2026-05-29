"use client"

import { useState, useEffect } from "react"
import { LightbulbIcon, PlusIcon, XIcon, FolderOpenIcon, Loader2Icon } from "lucide-react"

import type { RoomSuggestion } from "@/lib/rooms"

export function RoomSuggestionBanner({
  meetingId,
  meetingContexts,
}: {
  meetingId: string
  meetingContexts?: string[]
}) {
  const [suggestions, setSuggestions] = useState<RoomSuggestion[]>([])
  const [dismissed, setDismissed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState<string | null>(null)

  // Don't show if meeting already has room contexts
  const hasContext = meetingContexts && meetingContexts.length > 0

  useEffect(() => {
    if (hasContext || dismissed) return

    fetch("/api/rooms/suggestions")
      .then((r) => r.json())
      .then((data) => {
        const relevant = (data.suggestions ?? []).filter(
          (s: RoomSuggestion) => s.meetingIds?.includes(meetingId)
        )
        setSuggestions(relevant.slice(0, 3))
      })
      .catch(() => {})
  }, [meetingId, hasContext, dismissed])

  if (hasContext || dismissed || suggestions.length === 0) return null

  async function handleCreate(suggestion: RoomSuggestion) {
    setCreating(suggestion.name)
    setLoading(true)

    try {
      const res = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: suggestion.name,
          meetingIds: suggestion.meetingIds,
        }),
      })

      if (res.ok) {
        setDismissed(true)
      }
    } catch {
      // Silently fail
    } finally {
      setLoading(false)
      setCreating(null)
    }
  }

  return (
    <div className="relative rounded-lg border border-amber-500/20 bg-amber-500/5 p-4">
      <button
        onClick={() => setDismissed(true)}
        className="absolute end-3 top-3 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        aria-label="Dismiss"
      >
        <XIcon className="size-4" />
      </button>

      <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-600">
        <LightbulbIcon className="size-4" />
        Room Suggestion
      </div>

      <p className="mb-3 text-sm text-[var(--text-muted)]">
        This meeting isn&apos;t linked to a room yet. Based on patterns in your meetings:
      </p>

      <div className="space-y-2">
        {suggestions.map((s) => (
          <div
            key={s.name}
            className="flex items-center justify-between gap-3 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <FolderOpenIcon className="size-3.5 text-[var(--primary)]" />
                <span className="text-sm font-medium text-[var(--text-primary)]">
                  {s.name}
                </span>
              </div>
              <div className="mt-0.5 text-xs text-[var(--text-muted)]">{s.reason}</div>
            </div>
            <button
              onClick={() => handleCreate(s)}
              disabled={loading}
              className="flex shrink-0 items-center gap-1.5 rounded-md bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            >
              {creating === s.name ? (
                <Loader2Icon className="size-3 animate-spin" />
              ) : (
                <PlusIcon className="size-3" />
              )}
              Create Room
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
