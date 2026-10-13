import { CheckCircle2Icon, CircleIcon } from "lucide-react"

import { useI18n } from "@/components/i18n-provider"
import type { JobRecord, JobStatus, MeetingRecord } from "@/lib/meetings/repository"
import { MEETING_STATUS_FLOW } from "@/lib/meetings/state"
import {
  getMeetingWorkStatus,
  isBackgroundIndexJob,
  type MeetingWorkStatus,
} from "@/lib/meetings/work-status"

/** Pipeline stages and their message keys (labels come from the dictionary). */
const pipeline = [
  ["artifact.import", "opsStageArtifactImport"],
  ["drive.import", "opsStageDriveImport"],
  ["audio.extract", "opsStageAudioExtract"],
  ["transcribing", "opsStageTranscribing"],
  ["transcript.clean", "opsStageTranscriptClean"],
  ["summarizing", "opsStageSummarizing"],
  ["tasks.extract", "opsStageTasksExtract"],
  ["indexing", "opsStageIndexing"],
  ["quality.review", "opsStageQualityReview"],
  ["completed", "opsStageCompleted"],
] as const

const STAGE_KEYS: Record<string, string> = Object.fromEntries(pipeline)

/** Message key for a job status (shared by the ops job surfaces). */
export const JOB_STATUS_KEYS: Record<JobStatus, string> = {
  queued: "opsJobStatusQueued",
  active: "opsJobStatusActive",
  completed: "opsJobStatusCompleted",
  failed: "opsJobStatusFailed",
}

const legacyStatusByStage: Record<string, MeetingRecord["status"][]> = {
  "artifact.import": ["transcribing", "summarizing", "indexing", "completed"],
  "drive.import": ["media_uploaded", "transcribing", "summarizing", "indexing", "completed"],
  "audio.extract": ["media_uploaded", "transcribing", "summarizing", "indexing", "completed"],
  transcribing: ["transcribing", "summarizing", "indexing", "completed"],
  "transcript.clean": ["summarizing", "indexing", "completed"],
  summarizing: ["summarizing", "indexing", "completed"],
  "tasks.extract": ["indexing", "completed"],
  indexing: ["indexing", "completed"],
  "quality.review": ["completed"],
  completed: ["completed"],
}

const stageAliases: Record<string, string> = {
  "audio.transcribe": "transcribing",
  "summary.generate": "summarizing",
  // M6: the summarize path's persist step (was the inline "meeting.index").
  "summary.persist": "summarizing",
  "meeting.index": "indexing",
}

/** Localized label of a job stage id; unknown stages render as their raw id. */
export function stageLabel(stage: string, t: (key: string) => string): string {
  const key = STAGE_KEYS[stageAliases[stage] ?? stage]

  return key ? t(key) : stage
}

function workStatusTitle(
  workStatus: MeetingWorkStatus,
  t: (key: string) => string
): string {
  switch (workStatus.kind) {
    case "processing": {
      const stage = workStatus.stage ? (stageAliases[workStatus.stage] ?? workStatus.stage) : undefined
      const key = stage ? STAGE_KEYS[stage] : undefined

      return t(key ?? "opsWorkProcessing")
    }
    case "completed":
      return t("opsWorkProcessed")
    case "failed":
      return t("opsWorkFailed")
    case "ready":
      return t("opsWorkReady")
    case "upcoming":
      return t("opsWorkCaptureArmed")
    default:
      return t(workStatus.primaryAction === "sync_artifacts" ? "opsWorkSyncArtifacts" : "opsWorkManualCapture")
  }
}

export function PipelineTimeline({
  meeting,
  jobs,
}: {
  meeting: MeetingRecord | null
  jobs: JobRecord[]
}) {
  const { t, fmt } = useI18n()
  const workStatus = meeting ? getMeetingWorkStatus(meeting, jobs) : undefined
  const currentIndex = meeting
    ? Math.max(0, MEETING_STATUS_FLOW.indexOf(meeting.status))
    : 0
  const latestJob = jobs.find(
    (job) => job.meetingId === meeting?.id && !isBackgroundIndexJob(job)
  )
  const activeStage =
    typeof latestJob?.payload.stage === "string"
      ? latestJob.payload.stage
      : typeof latestJob?.result.stage === "string"
        ? latestJob.result.stage
        : undefined
  const normalizedActiveStage = activeStage
    ? (stageAliases[activeStage] ?? activeStage)
    : undefined
  const latestJobLabel = latestJob?.updatedAt
    ? fmt.date(latestJob.updatedAt, "dateTime")
    : t("opsPipelineWaiting")

  return (
    <section className="ms-card p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{t("pipeline")}</h3>
          {workStatus ? (
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {workStatusTitle(workStatus, t)}
            </p>
          ) : null}
        </div>
        {workStatus?.kind === "failed" ? (
          <span className="rounded-md bg-warn-soft px-2 py-1 text-2xs font-medium text-warn-text">
            {t("opsJobStatusFailed")}
          </span>
        ) : null}
      </div>
      {workStatus?.kind === "processing" && typeof workStatus.progress === "number" ? (
        <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-surface-2">
          <div
            className="h-full rounded-full bg-brand"
            style={{ width: `${Math.round(workStatus.progress * 100)}%` }}
          />
        </div>
      ) : null}
      <div className="grid gap-0">
        {pipeline.map(([status, labelKey], index) => {
          const flowIndex = MEETING_STATUS_FLOW.indexOf(status as MeetingRecord["status"])
          const done =
            meeting?.status === "completed" ||
            legacyStatusByStage[status]?.includes(meeting?.status ?? "created") ||
            (flowIndex >= 0 && flowIndex <= currentIndex)
          const active = normalizedActiveStage === status

          return (
            <div key={status} className="grid grid-cols-[18px_minmax(0,1fr)] gap-3">
              <div className="flex flex-col items-center">
                {done ? (
                  <CheckCircle2Icon aria-hidden="true" className="size-4 text-ok" />
                ) : (
                  <CircleIcon aria-hidden="true" className={active ? "size-4 text-warn" : "size-4 text-fg-3"} />
                )}
                {index < pipeline.length - 1 && (
                  <span className="h-6 w-px bg-line" />
                )}
              </div>
              <div className="pb-2">
                <div className="text-sm font-medium text-foreground">{t(labelKey)}</div>
                <div className="text-xs text-muted-foreground">
                  {latestJob?.status === "failed" && active
                    ? (latestJob.error ?? t("opsJobStatusFailed"))
                    : active
                      ? t(JOB_STATUS_KEYS[latestJob?.status ?? "active"])
                      : latestJobLabel}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
