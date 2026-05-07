import {
  CheckCircle2Icon,
  CopyIcon,
  FileAudioIcon,
  PlayCircleIcon,
  RadioTowerIcon,
  RefreshCwIcon,
  UploadIcon,
} from "lucide-react"

import { AudioPlaybackBar } from "@/components/audio-playback-bar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import { getMeetingCaptureReadiness } from "@/lib/meetings/capture-readiness"
import type { ActionItem, JobRecord, MeetingRecord } from "@/lib/meetings/repository"
import { getMeetingWorkStatus } from "@/lib/meetings/work-status"

function quoteTime(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  return `00:${String(Math.floor(totalSeconds / 60)).padStart(2, "0")}:${String(totalSeconds % 60).padStart(2, "0")}`
}

function priorityClass(priority?: ActionItem["priority"]) {
  if (priority === "urgent" || priority === "high") {
    return "border-[var(--accent)] bg-[var(--tag-action)] text-[var(--tag-action-fg)]"
  }
  if (priority === "low") {
    return "border-[var(--status-success)] bg-[var(--tag-business)] text-[var(--tag-business-fg)]"
  }
  return "border-[var(--accent)] bg-[var(--tag-action)] text-[var(--tag-action-fg)]"
}

function readinessBadgeClass(status: ReturnType<typeof getMeetingCaptureReadiness>["status"]) {
  if (status === "ready_to_process" || status === "processed") {
    return "border-[var(--status-success)]/40 bg-[var(--tag-business)] text-[var(--tag-business-fg)]"
  }
  if (status === "capture_armed") {
    return "border-[var(--primary)]/30 bg-[var(--selected)] text-[var(--primary)]"
  }

  return "border-[var(--accent)]/40 bg-[var(--tag-action)] text-[var(--tag-action-fg)]"
}

function checkDotClass(state: "ready" | "pending" | "missing") {
  if (state === "ready") return "bg-[var(--status-success)]"
  if (state === "missing") return "bg-[var(--status-error)]"

  return "bg-[var(--muted-foreground)]/40"
}

export function MeetingSummaryView({
  dictionary,
  meeting,
  jobs,
  onToggleActionItem,
  onReprocessMeeting,
  onProcessMeeting,
  onRetryJob,
  onOpenUpload,
  onFindDriveRecordings,
  onSyncMeetArtifacts,
  onCopyText,
}: {
  dictionary: Dictionary
  meeting: MeetingRecord
  jobs: JobRecord[]
  onToggleActionItem: (item: ActionItem) => void
  onReprocessMeeting: (mode: "full" | "summary" | "tasks" | "transcript-cleanup") => void
  onProcessMeeting: () => void
  onRetryJob: (job: JobRecord) => void
  onOpenUpload: () => void
  onFindDriveRecordings: () => void
  onSyncMeetArtifacts: () => void
  onCopyText: (text: string, label: string) => void
}) {
  const actionItems = meeting.summary?.actionItems ?? []
  const quotes = meeting.transcript?.slice(0, 2) ?? []
  const isUpcoming = meeting.status === "scheduled" && !meeting.summary
  const hasMedia = Boolean(meeting.mediaAssets?.some((asset) => asset.storageKey))
  const hasTranscript = Boolean(meeting.transcript?.length)
  const hasMeetImportableArtifact = meeting.meetConferenceRecords?.some((record) =>
    record.artifacts.some((artifact) =>
      ["transcript", "smart_notes", "recording"].includes(artifact.artifactType)
    )
  )
  const canFullReprocess = hasMedia || hasMeetImportableArtifact
  const canProcess = hasMedia || hasTranscript || hasMeetImportableArtifact
  const showContentGap = !meeting.summary?.overview
  const readiness = getMeetingCaptureReadiness(meeting)
  const workStatus = getMeetingWorkStatus(meeting, jobs)
  const latestJob = workStatus.jobId
    ? jobs.find((job) => job.id === workStatus.jobId)
    : undefined
  const showWorkStatus =
    workStatus.kind === "processing" || workStatus.kind === "failed"

  return (
    <div className="px-5 py-6 md:px-8">
      <div className="mx-auto max-w-5xl">
      {showWorkStatus ? (
        <section
          className={`mb-5 rounded-lg border p-4 text-sm leading-6 ${
            workStatus.kind === "failed"
              ? "border-[var(--status-error)]/40 bg-[var(--tag-action)] text-[var(--tag-action-fg)]"
              : "border-[var(--primary)]/30 bg-[var(--selected)] text-[var(--primary)]"
          }`}
        >
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="font-semibold">{workStatus.title}</div>
              <p className="mt-1 opacity-90">{workStatus.description}</p>
              {workStatus.stage ? (
                <div className="mt-2 font-mono text-xs opacity-80">
                  {workStatus.stage}
                  {workStatus.jobId ? ` · ${workStatus.jobId}` : ""}
                </div>
              ) : null}
            </div>
            {workStatus.primaryAction === "retry" && latestJob ? (
              <Button size="sm" variant="outline" onClick={() => onRetryJob(latestJob)}>
                <RefreshCwIcon data-icon="inline-start" className="size-4" />
                Retry job
              </Button>
            ) : null}
          </div>
          {workStatus.kind === "processing" && typeof workStatus.progress === "number" ? (
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--surface)]/70">
              <div
                className="h-full rounded-full bg-[var(--primary)]"
                style={{ width: `${Math.round(workStatus.progress * 100)}%` }}
              />
            </div>
          ) : null}
        </section>
      ) : null}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{dictionary.overview}</h2>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-[var(--primary)]"
              disabled={!canFullReprocess}
              title={
                hasMedia
                  ? "Run the full media pipeline again"
                  : hasMeetImportableArtifact
                    ? "Import Google Meet recording, transcript entries, or smart notes and rerun intelligence"
                    : "Attach a recording or sync a Meet artifact before full reprocessing"
              }
              onClick={() => onReprocessMeeting("full")}
            >
              <RefreshCwIcon data-icon="inline-start" className="size-4" />
              Reprocess
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-muted-foreground"
              onClick={() =>
                onCopyText(
                  meeting.summary?.overview ??
                    "No summary is available for this meeting yet.",
                  "Overview"
                )
              }
            >
              <CopyIcon data-icon="inline-start" className="size-4" />
              Copy
            </Button>
          </div>
        </div>
        {showContentGap ? (
          <div className="max-w-3xl rounded-lg border border-[var(--divider)] bg-[var(--surface-subtle)] p-4 text-sm leading-6 text-muted-foreground">
            <div className="flex flex-wrap items-center gap-2">
              <div className="font-medium text-foreground">
                {isUpcoming ? workStatus.title : "No meeting intelligence has been generated yet."}
              </div>
              <Badge
                variant="outline"
                className={`rounded-md ${readinessBadgeClass(readiness.status)}`}
              >
                {workStatus.title}
              </Badge>
            </div>
            <p className="mt-1">
              {isUpcoming
                ? workStatus.description
                : "Attach a recording, import a Google Meet artifact, or process an existing transcript to generate summary, decisions, tasks, and quotes."}
            </p>
            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {readiness.checks.slice(0, 6).map((check) => (
                <div
                  key={check.key}
                  className="flex items-center gap-2 rounded-md border border-[var(--divider)] bg-[var(--surface)] px-3 py-2 text-xs text-foreground"
                >
                  <span className={`size-2 rounded-full ${checkDotClass(check.state)}`} />
                  <span className="min-w-0 truncate">{check.label}</span>
                  <span className="ml-auto text-[11px] text-muted-foreground">
                    {check.state}
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {workStatus.primaryAction === "process" ? (
                <Button
                  size="sm"
                  disabled={!canProcess}
                  title={
                    canProcess
                      ? "Queue processing for this meeting"
                      : "No recording, transcript, or importable Google Meet artifact is attached yet"
                  }
                  onClick={onProcessMeeting}
                >
                  <PlayCircleIcon data-icon="inline-start" className="size-4" />
                  Process now
                </Button>
              ) : null}
              {workStatus.primaryAction === "sync_artifacts" ? (
                <Button size="sm" onClick={onSyncMeetArtifacts}>
                  <RadioTowerIcon data-icon="inline-start" className="size-4" />
                  Sync Meet artifacts
                </Button>
              ) : null}
              {workStatus.primaryAction === "upload" ? (
                <Button size="sm" onClick={onOpenUpload}>
                  <UploadIcon data-icon="inline-start" className="size-4" />
                  Upload recording
                </Button>
              ) : null}
              {workStatus.primaryAction !== "upload" ? (
                <Button size="sm" variant="outline" onClick={onOpenUpload}>
                  <UploadIcon data-icon="inline-start" className="size-4" />
                  Upload recording
                </Button>
              ) : null}
              <Button size="sm" variant="outline" onClick={onFindDriveRecordings}>
                <FileAudioIcon data-icon="inline-start" className="size-4" />
                Find Drive recordings
              </Button>
              {workStatus.primaryAction !== "sync_artifacts" ? (
                <Button size="sm" variant="ghost" onClick={onSyncMeetArtifacts}>
                  <RadioTowerIcon data-icon="inline-start" className="size-4" />
                  Sync Meet artifacts
                </Button>
              ) : null}
            </div>
          </div>
        ) : (
          <p className="max-w-3xl text-sm leading-7 text-foreground/80">
            {meeting.summary?.overview ??
              "Summary will appear after intelligence runs."}
          </p>
        )}
      </section>

      <section className="mt-8 max-w-3xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{dictionary.decisions}</h2>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-muted-foreground"
            onClick={() =>
              onCopyText(
                (meeting.summary?.decisions ?? []).join("\n"),
                "Decisions"
              )
            }
          >
            <CopyIcon data-icon="inline-start" className="size-4" />
            Copy
          </Button>
        </div>
        <div className="grid gap-2">
          {(meeting.summary?.decisions.length
            ? meeting.summary.decisions
            : ["No decisions extracted yet."]).map((decision) => (
            <div key={decision} className="flex items-start gap-3 text-sm text-foreground">
              <CheckCircle2Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-emerald-500" />
              <span className="leading-6">{decision}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-8 max-w-5xl">
        <h2 className="mb-3 text-lg font-semibold">{dictionary.actionItems}</h2>
        <div className="grid gap-3">
          {actionItems.length ? actionItems.map((item, index) => (
            <div
              key={item.id}
              className="grid min-h-9 grid-cols-[auto_minmax(0,1fr)] items-start gap-3 rounded-lg border border-transparent px-1 py-1 text-sm hover:border-[var(--divider)] hover:bg-[var(--surface-subtle)] md:grid-cols-[auto_minmax(0,1fr)_150px_90px_92px]"
            >
              <Checkbox
                checked={item.status === "done"}
                onCheckedChange={() => onToggleActionItem(item)}
                className="mt-1"
              />
              <div className="min-w-0 leading-6 text-foreground">{item.title}</div>
              <div className="hidden items-center gap-2 text-muted-foreground md:flex">
                <span className="grid size-6 place-items-center rounded-full bg-rose-200 text-xs font-semibold text-rose-800">
                  {(item.owner ?? "T").slice(0, 1)}
                </span>
                <span className="truncate">{item.owner ?? dictionary.unassigned}</span>
              </div>
              <div className="hidden text-muted-foreground md:block">
                {item.dueDate ?? `May ${index + 1}`}
              </div>
              <div
                className={`hidden h-7 w-fit items-center rounded-full border px-3 text-xs font-medium md:flex ${priorityClass(item.priority)}`}
              >
                {item.priority ?? (index % 2 ? "Medium" : "High")}
              </div>
            </div>
          )) : (
            <div className="rounded-lg border border-dashed border-[var(--divider)] bg-[var(--surface-subtle)] p-4 text-sm text-muted-foreground">
              No action items extracted yet.
            </div>
          )}
        </div>
      </section>

      <section className="mt-8 grid gap-4 lg:grid-cols-2">
        <div>
          <h2 className="mb-3 text-lg font-semibold">Risks & Blockers</h2>
          <div className="grid gap-2">
            {(meeting.intelligence?.risks.length
              ? meeting.intelligence.risks
              : ["No risks identified yet."]).map((risk) => (
              <div key={risk} className="rounded-lg border border-[var(--divider)] bg-[var(--surface-subtle)] px-3 py-2 text-sm leading-6 text-foreground/80">
                {risk}
              </div>
            ))}
          </div>
        </div>
        <div>
          <h2 className="mb-3 text-lg font-semibold">Open Questions</h2>
          <div className="grid gap-2">
            {(meeting.intelligence?.openQuestions.length
              ? meeting.intelligence.openQuestions
              : ["No open questions extracted yet."]).map((question) => (
              <div key={question} className="rounded-lg border border-[var(--divider)] bg-[var(--surface-subtle)] px-3 py-2 text-sm leading-6 text-foreground/80">
                {question}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mt-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Key Quotes</h2>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-muted-foreground"
            onClick={() =>
              onCopyText(
                quotes
                  .map(
                    (segment) =>
                      `${quoteTime(segment.startMs)} ${segment.speaker}: ${segment.text}`
                  )
                  .join("\n"),
                "Key quotes"
              )
            }
          >
            <CopyIcon data-icon="inline-start" className="size-4" />
            Copy
          </Button>
        </div>
        <div className="grid gap-2">
          {quotes.length ? (
            quotes.map((segment) => (
              <div
                key={segment.id}
                className="grid gap-2 rounded-md border border-[var(--divider)] bg-[var(--surface)] px-3 py-2 text-sm md:grid-cols-[72px_minmax(0,1fr)]"
              >
                <span className="font-mono text-xs text-muted-foreground">
                  {quoteTime(segment.startMs)}
                </span>
                <span className="text-muted-foreground">
                  {segment.speaker}: “{segment.text}”
                </span>
              </div>
            ))
          ) : (
            <div className="rounded-md border border-dashed border-[var(--divider)] p-3 text-sm text-muted-foreground">
              Quotes will appear after transcription.
            </div>
          )}
        </div>
      </section>

      <AudioPlaybackBar meeting={meeting} />
      </div>
    </div>
  )
}
