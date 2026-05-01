"use client"

import { useMemo, useState } from "react"
import { SearchIcon, UsersIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type {
  MeetingParticipant,
  TranscriptSegment,
} from "@/lib/meetings/repository"

function formatTime(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  return `${minutes}:${String(seconds).padStart(2, "0")}`
}

export function TranscriptTimeline({
  segments,
  participants = [],
  onEditSpeakers,
  onAssignSpeaker,
}: {
  segments?: TranscriptSegment[]
  participants?: MeetingParticipant[]
  onEditSpeakers?: () => void
  onAssignSpeaker?: (speakerLabel: string, participantId: string) => void
}) {
  const [query, setQuery] = useState("")
  const speakerLabels = useMemo(
    () => [...new Set((segments ?? []).map((segment) => segment.speaker))],
    [segments]
  )
  const assignableParticipants = useMemo(
    () =>
      participants.filter((participant) =>
        ["organizer", "attendee", "speaker", "unknown"].includes(participant.role)
      ),
    [participants]
  )
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

      {speakerLabels.length && assignableParticipants.length && onAssignSpeaker ? (
        <section className="grid gap-2 rounded-lg border border-[var(--divider)] bg-[var(--surface-subtle)] p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-foreground">Speaker mapping</h3>
              <p className="text-xs leading-5 text-muted-foreground">
                Map transcript labels to real participants. The transcript refreshes after saving.
              </p>
            </div>
            <Button size="sm" variant="ghost" onClick={onEditSpeakers}>
              Manage participants
            </Button>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {speakerLabels.map((speaker) => {
              const mappedParticipant = participants.find(
                (participant) =>
                  participant.speakerLabel === speaker ||
                  (participant.speakerLabel && participant.name === speaker)
              )
              const rawSpeakerLabel = mappedParticipant?.speakerLabel ?? speaker

              return (
                <label
                  key={speaker}
                  className="grid gap-1 rounded-md border border-[var(--divider)] bg-[var(--surface)] p-2 text-xs"
                >
                  <span className="font-medium text-foreground">{speaker}</span>
                  <select
                    className="h-8 rounded-md border border-[var(--divider)] bg-[var(--surface)] px-2 text-sm text-foreground"
                    value={mappedParticipant?.id ?? ""}
                    onChange={(event) => {
                      if (event.target.value) {
                        onAssignSpeaker(rawSpeakerLabel, event.target.value)
                      }
                    }}
                  >
                    <option value="">Assign participant...</option>
                    {assignableParticipants.map((participant) => (
                      <option key={participant.id} value={participant.id}>
                        {participant.name}
                        {participant.email ? ` (${participant.email})` : ""}
                      </option>
                    ))}
                  </select>
                </label>
              )
            })}
          </div>
        </section>
      ) : null}

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
