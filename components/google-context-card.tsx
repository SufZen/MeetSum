import {
  CalendarDaysIcon,
  FileIcon,
  FileTextIcon,
  NotebookTabsIcon,
  RadioTowerIcon,
  VideoIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { MeetingRecord } from "@/lib/meetings/repository"

function formatArtifactType(value: string) {
  if (value === "smart_notes") return "Smart notes"
  return value[0]?.toUpperCase() + value.slice(1)
}

function formatDate(value?: string) {
  if (!value) return undefined
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) return undefined

  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)
}

export function GoogleContextCard({
  meeting,
  onProcessMeeting,
}: {
  meeting: MeetingRecord | null
  onProcessMeeting?: () => void
}) {
  const title = meeting?.title ?? "No meeting selected"
  const conferenceRecords = meeting?.meetConferenceRecords ?? []
  const artifacts = conferenceRecords.flatMap((record) => record.artifacts)
  const recordings = artifacts.filter((artifact) => artifact.artifactType === "recording")
  const transcripts = artifacts.filter((artifact) => artifact.artifactType === "transcript")
  const smartNotes = artifacts.filter((artifact) => artifact.artifactType === "smart_notes")
  const hasProcessSource = Boolean(
      meeting?.mediaAssets?.some((asset) => asset.storageKey) ||
      meeting?.transcript?.length ||
      transcripts.length ||
      smartNotes.length ||
      recordings.length
  )
  const hasArtifactContext = artifacts.length > 0 || conferenceRecords.length > 0
  const primaryConferenceRecord = conferenceRecords[0]
  const importedRecording = meeting?.mediaAssets?.[0]
  const items = [
    {
      icon: CalendarDaysIcon,
      label: "Event",
      value: title,
      detail: meeting ? formatDate(meeting.startedAt) : undefined,
    },
    {
      icon: RadioTowerIcon,
      label: "Meet record",
      value: primaryConferenceRecord
        ? primaryConferenceRecord.conferenceRecordName
        : "No conference record linked yet",
      detail: primaryConferenceRecord
        ? formatDate(primaryConferenceRecord.startTime)
        : undefined,
    },
    {
      icon: VideoIcon,
      label: "Recording",
      value: importedRecording?.filename
        ? `${importedRecording.filename} imported`
        : recordings.length
          ? `${recordings.length} recording artifact${recordings.length === 1 ? "" : "s"} found`
          : "No recording artifact linked yet",
      detail: recordings[0]?.driveFileName,
    },
    {
      icon: FileTextIcon,
      label: "Transcript",
      value: meeting?.transcript?.length
        ? `${meeting.transcript.length} transcript segments in MeetSum`
        : transcripts.length
          ? `${transcripts.length} transcript artifact${transcripts.length === 1 ? "" : "s"} found`
          : "No transcript artifact linked yet",
      detail: transcripts[0]?.documentName,
    },
    {
      icon: NotebookTabsIcon,
      label: "Smart notes",
      value: smartNotes.length
        ? `${smartNotes.length} smart notes artifact${smartNotes.length === 1 ? "" : "s"} found`
        : "No smart notes linked yet",
      detail: smartNotes[0]?.documentName,
    },
  ]

  return (
    <section className="rounded-md border border-[var(--divider)] bg-[var(--surface)] p-4">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Google Context</h3>
        <Badge
          variant="outline"
          className={
            hasArtifactContext
              ? "rounded-md border-[var(--primary)]/40 text-[var(--primary)]"
              : "rounded-md"
          }
        >
          {hasArtifactContext ? "linked" : "pending"}
        </Badge>
      </div>
      <div className="grid gap-3">
        {items.map((item) => {
          const Icon = item.icon

          return (
            <div key={item.label} className="grid grid-cols-[22px_minmax(0,1fr)] gap-3">
              <Icon aria-hidden="true" className="mt-0.5 size-5 text-[var(--primary)]" />
              <div className="min-w-0">
                <div className="text-xs font-semibold text-foreground">{item.label}</div>
                <div className="truncate text-xs text-muted-foreground">{item.value}</div>
                {item.detail ? (
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {item.detail}
                  </div>
                ) : null}
              </div>
            </div>
          )
        })}
        {artifacts.length ? (
          <div className="flex flex-wrap gap-1.5 border-t border-[var(--divider)] pt-3">
            {artifacts.slice(0, 5).map((artifact) => (
              <span
                key={artifact.id}
                className="rounded-sm bg-[var(--selected)] px-2 py-0.5 text-[11px] font-medium text-[var(--primary)]"
                title={artifact.artifactName}
              >
                {formatArtifactType(artifact.artifactType)}
              </span>
            ))}
            {artifacts.length > 5 ? (
              <span className="rounded-sm bg-[var(--surface-subtle)] px-2 py-0.5 text-[11px] text-muted-foreground">
                +{artifacts.length - 5}
              </span>
            ) : null}
          </div>
        ) : null}
        <Button
          variant={hasProcessSource ? "default" : "outline"}
          size="sm"
          className="h-9 w-full"
          disabled={!meeting || !hasProcessSource}
          onClick={onProcessMeeting}
          title={
            hasProcessSource
              ? "Queue processing from the attached media, transcript, or Google Meet recording/transcript/smart-notes artifact"
              : hasArtifactContext
                ? "Artifact metadata is linked. Import the Drive recording, transcript, or smart notes content before processing."
                : "Sync Meet artifacts or import a recording first."
          }
        >
          {(transcripts.length || smartNotes.length || recordings.length) &&
          !meeting?.transcript?.length &&
          !meeting?.mediaAssets?.length
            ? transcripts.length
              ? "Import transcript artifact"
              : smartNotes.length
                ? "Import smart notes"
                : "Import recording artifact"
            : hasProcessSource
              ? "Process from attached source"
            : hasArtifactContext
              ? "Artifact linked; source needed"
              : "No Google source attached"}
        </Button>
        {!meeting && (
          <div className="flex items-center gap-2 rounded-md border border-dashed border-[var(--divider)] p-3 text-xs text-muted-foreground">
            <FileIcon aria-hidden="true" className="size-4" />
            Select a meeting to see linked Workspace context.
          </div>
        )}
      </div>
    </section>
  )
}
