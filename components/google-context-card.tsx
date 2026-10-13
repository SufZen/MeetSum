"use client"

import {
  CalendarDaysIcon,
  FileIcon,
  FileTextIcon,
  NotebookTabsIcon,
  RadioTowerIcon,
  VideoIcon,
} from "lucide-react"

import { useI18n } from "@/components/i18n-provider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  getMeetingCaptureReadiness,
  type CaptureReadiness,
  type CaptureReadinessCheck,
} from "@/lib/meetings/capture-readiness"
import type { MeetingRecord } from "@/lib/meetings/repository"

type Translate = (key: string, values?: Record<string, string | number | undefined>) => string

const CHECK_KEYS: Record<CaptureReadinessCheck["key"], string> = {
  calendar: "mtgCheckCalendar",
  meet_record: "mtgCheckMeetRecord",
  recording: "mtgCheckRecording",
  transcript: "mtgCheckTranscript",
  smart_notes: "mtgCheckSmartNotes",
  media: "mtgCheckMedia",
}

const CHECK_STATE_KEYS: Record<CaptureReadinessCheck["state"], string> = {
  ready: "mtgCheckStateReady",
  pending: "mtgCheckStatePending",
  missing: "mtgCheckStateMissing",
}

/** Localized label of a capture-readiness check (the lib label is English). */
export function readinessCheckLabel(check: CaptureReadinessCheck, t: Translate): string {
  return t(CHECK_KEYS[check.key])
}

export function readinessCheckState(check: CaptureReadinessCheck, t: Translate): string {
  return t(CHECK_STATE_KEYS[check.state])
}

/** Localized title and description of a capture readiness (the lib text is English). */
export function readinessText(
  readiness: Pick<CaptureReadiness, "status">,
  source: MeetingRecord["source"] | undefined,
  t: Translate
): { title: string; description: string } {
  switch (readiness.status) {
    case "processed":
      return { title: t("mtgReadinessProcessedTitle"), description: t("mtgReadinessProcessedDescription") }
    case "ready_to_process":
      return { title: t("mtgReadinessReadyTitle"), description: t("mtgReadinessReadyDescription") }
    case "capture_armed":
      return { title: t("mtgReadinessArmedTitle"), description: t("mtgReadinessArmedDescription") }
    case "needs_artifact_sync":
      return { title: t("mtgReadinessNeedsSyncTitle"), description: t("mtgReadinessNeedsSyncDescription") }
    default:
      return {
        title: t("mtgReadinessManualTitle"),
        description:
          source === "desktop_recorder"
            ? t("mtgReadinessManualDesktopDescription")
            : t("mtgReadinessManualDescription"),
      }
  }
}

const ARTIFACT_TYPE_KEYS: Record<string, string> = {
  recording: "mtgCheckRecording",
  transcript: "mtgCheckTranscript",
  smart_notes: "mtgCheckSmartNotes",
}

export function GoogleContextCard({
  meeting,
  onProcessMeeting,
}: {
  meeting: MeetingRecord | null
  onProcessMeeting?: () => void
}) {
  const { t, plural, fmt, text } = useI18n()
  const formatDate = (value?: string) => (value ? fmt.date(value, "dateTime") || undefined : undefined)
  const artifactTypeLabel = (value: string) =>
    ARTIFACT_TYPE_KEYS[value] ? t(ARTIFACT_TYPE_KEYS[value]) : value.replaceAll("_", " ")
  const title = meeting ? text(meeting.title, meeting.language) : t("mtgGoogleNoMeeting")
  const conferenceRecords = meeting?.meetConferenceRecords ?? []
  const artifacts = conferenceRecords.flatMap((record) => record.artifacts)
  const recordings = artifacts.filter((artifact) => artifact.artifactType === "recording")
  const transcripts = artifacts.filter((artifact) => artifact.artifactType === "transcript")
  const smartNotes = artifacts.filter((artifact) => artifact.artifactType === "smart_notes")
  const artifactCountLabel = artifacts.length
    ? plural("mtgGoogleArtifactsLinked", artifacts.length)
    : t("mtgGoogleNoArtifacts")
  // M4: the detail no longer carries the transcript, only its segment count.
  const segmentCount = meeting?.transcriptSegmentCount ?? meeting?.transcript?.length ?? 0
  const hasProcessSource = Boolean(
      meeting?.mediaAssets?.some((asset) => asset.storageKey) ||
      segmentCount ||
      transcripts.length ||
      smartNotes.length ||
      recordings.length
  )
  const hasArtifactContext = artifacts.length > 0 || conferenceRecords.length > 0
  const primaryConferenceRecord = conferenceRecords[0]
  const importedRecording = meeting?.mediaAssets?.[0]
  const readiness = meeting ? getMeetingCaptureReadiness(meeting) : undefined
  const readinessCopy = readiness ? readinessText(readiness, meeting?.source, t) : undefined
  const items = [
    {
      key: "event",
      icon: CalendarDaysIcon,
      label: t("mtgGoogleEvent"),
      value: title,
      isTitle: Boolean(meeting),
      detail: meeting ? formatDate(meeting.startedAt) : undefined,
    },
    {
      key: "meet_record",
      icon: RadioTowerIcon,
      label: t("mtgCheckMeetRecord"),
      value: primaryConferenceRecord
        ? primaryConferenceRecord.conferenceRecordName
        : t("mtgGoogleNoConference"),
      isTitle: false,
      detail: primaryConferenceRecord
        ? formatDate(primaryConferenceRecord.startTime)
        : undefined,
    },
    {
      key: "recording",
      icon: VideoIcon,
      label: t("mtgCheckRecording"),
      value: importedRecording?.filename
        ? t("mtgGoogleRecordingImported", { name: importedRecording.filename })
        : recordings.length
          ? plural("mtgGoogleRecordingsFound", recordings.length)
          : t("mtgGoogleNoRecording"),
      isTitle: false,
      detail: recordings[0]?.driveFileName,
    },
    {
      key: "transcript",
      icon: FileTextIcon,
      label: t("mtgCheckTranscript"),
      value: segmentCount
        ? plural("mtgGoogleSegments", segmentCount)
        : transcripts.length
          ? plural("mtgGoogleTranscriptsFound", transcripts.length)
          : t("mtgGoogleNoTranscript"),
      isTitle: false,
      detail: transcripts[0]?.documentName,
    },
    {
      key: "smart_notes",
      icon: NotebookTabsIcon,
      label: t("mtgCheckSmartNotes"),
      value: smartNotes.length
        ? plural("mtgGoogleSmartNotesFound", smartNotes.length)
        : t("mtgGoogleNoSmartNotes"),
      isTitle: false,
      detail: smartNotes[0]?.documentName,
    },
  ]

  return (
    <section className="rounded-md border border-line bg-surface p-4">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t("mtgGoogleTitle")}</h3>
        <Badge
          variant="outline"
          className={
            hasArtifactContext
              ? "rounded-md border-brand/40 text-brand-text"
              : "rounded-md"
          }
        >
          {hasArtifactContext ? t("mtgGoogleLinked") : t("mtgGooglePending")}
        </Badge>
      </div>
      <div className="mb-3 rounded-md border border-line bg-surface-2 px-3 py-2 text-xs leading-5 text-muted-foreground">
        <span className="font-medium text-foreground">{artifactCountLabel}</span>
        {" · "}
        {primaryConferenceRecord?.startTime
          ? t("mtgGoogleMeetRecordAt", { date: formatDate(primaryConferenceRecord.startTime) ?? "" })
          : t("mtgGoogleSyncHint")}
      </div>
      {readinessCopy ? (
        <div className="mb-4 rounded-md border border-line bg-surface-2 p-3">
          <div className="text-xs font-semibold text-foreground">
            {readinessCopy.title}
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {readinessCopy.description}
          </p>
        </div>
      ) : null}
      <div className="grid gap-3">
        {items.map((item) => {
          const Icon = item.icon

          return (
            <div key={item.key} className="grid grid-cols-[22px_minmax(0,1fr)] gap-3">
              <Icon aria-hidden="true" className="mt-0.5 size-5 text-brand-text" />
              <div className="min-w-0">
                <div className="text-xs font-semibold text-foreground">{item.label}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {item.isTitle ? <bdi>{item.value}</bdi> : item.value}
                </div>
                {item.detail ? (
                  <div className="mt-0.5 truncate text-2xs text-muted-foreground">
                    <bdi>{item.detail}</bdi>
                  </div>
                ) : null}
              </div>
            </div>
          )
        })}
        {artifacts.length ? (
          <div className="flex flex-wrap gap-1.5 border-t border-line pt-3">
            {artifacts.slice(0, 5).map((artifact) => (
              <span
                key={artifact.id}
                className="rounded-sm bg-brand-soft px-2 py-0.5 text-2xs font-medium text-brand-text"
                title={artifact.artifactName}
              >
                {artifactTypeLabel(artifact.artifactType)}
              </span>
            ))}
            {artifacts.length > 5 ? (
              <span className="rounded-sm bg-surface-2 px-2 py-0.5 text-2xs text-muted-foreground [direction:ltr] [unicode-bidi:isolate]">
                +{fmt.number(artifacts.length - 5)}
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
              ? t("mtgGoogleProcessHint")
              : hasArtifactContext
                ? t("mtgGoogleImportFirstHint")
                : t("mtgGoogleSyncFirstHint")
          }
        >
          {(transcripts.length || smartNotes.length || recordings.length) &&
          !segmentCount &&
          !meeting?.mediaAssets?.length
            ? transcripts.length
              ? t("mtgGoogleImportTranscript")
              : smartNotes.length
                ? t("mtgGoogleImportSmartNotes")
                : t("mtgGoogleImportRecording")
            : hasProcessSource
              ? transcripts.length || smartNotes.length || recordings.length
                ? t("mtgSummaryProcessFromGoogle")
                : t("mtgGoogleProcessAttached")
            : hasArtifactContext
              ? t("mtgGoogleSourceNeeded")
              : t("mtgGoogleNoSource")}
        </Button>
        {!meeting && (
          <div className="flex items-center gap-2 rounded-md border border-dashed border-line p-3 text-xs text-muted-foreground">
            <FileIcon aria-hidden="true" className="size-4" />
            {t("mtgGoogleSelectMeeting")}
          </div>
        )}
      </div>
    </section>
  )
}
