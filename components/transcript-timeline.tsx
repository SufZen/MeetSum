"use client"

import { useMemo, useState } from "react"
import { SearchIcon, UsersIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { TranscriptSegment } from "@/lib/meetings/repository"

function formatTime(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  return `${minutes}:${String(seconds).padStart(2, "0")}`
}

export function TranscriptTimeline({
  segments,
  onEditSpeakers,
}: {
  segments?: TranscriptSegment[]
  onEditSpeakers?: () => void
}) {
  const [query, setQuery] = useState("")
  const filteredSegments = useMemo(() => {
    const needle = query.trim().toLowerCase()

    if (!needle) return segments ?? []

    return (segments ?? []).filter((segment) =>
      [segment.speaker, segment.text, segment.language]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(needle)
    )
  }, [query, segments])

  if (!segments?.length) {
    return (
      <div className="flex min-h-56 items-center justify-center rounded-md border border-dashed bg-muted/30 p-6 text-center text-sm text-muted-foreground">
        Transcript segments will appear here after upload, Drive import, or
        recorder processing.
      </div>
    )
  }

  return (
    <div className="grid gap-4">
      <div className="sticky top-0 z-10 flex min-h-10 flex-wrap items-center gap-2 rounded-lg border border-[var(--divider)] bg-[var(--surface-subtle)] px-3 py-1.5">
        <SearchIcon aria-hidden="true" className="size-4 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find in transcript..."
          className="h-9 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
        />
        <span className="font-mono text-xs text-muted-foreground">
          {filteredSegments.length}/{segments.length}
        </span>
        {onEditSpeakers ? (
          <Button
            size="sm"
            variant="outline"
            className="ms-auto h-8"
            onClick={onEditSpeakers}
          >
            <UsersIcon data-icon="inline-start" className="size-4" />
            Edit speakers
          </Button>
        ) : null}
      </div>

      <div className="grid gap-2">
      {filteredSegments.map((segment) => (
        <article
          key={segment.id}
          className="grid gap-2 rounded-lg border border-[var(--divider)] bg-[var(--surface)] p-3 text-sm"
        >
          <div className="flex min-h-7 flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="font-medium">{segment.speaker}</span>
              {segment.language && (
                <Badge variant="secondary" className="h-6 rounded-sm">
                  {segment.language}
                </Badge>
              )}
            </div>
            <span className="font-mono text-xs text-muted-foreground">
              {formatTime(segment.startMs)}
            </span>
          </div>
          <p className="leading-7 text-foreground/80">{segment.text}</p>
        </article>
      ))}
      {!filteredSegments.length && (
        <div className="rounded-lg border border-dashed border-[var(--divider)] bg-[var(--surface)] p-6 text-center text-sm text-muted-foreground">
          No transcript segments match this search.
        </div>
      )}
      </div>
    </div>
  )
}
