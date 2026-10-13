import {
  getMeetingCaptureReadiness,
  type CaptureReadinessAction,
  type CaptureReadinessCheck,
} from "@/lib/meetings/capture-readiness"
import type { JobRecord, MeetingRecord } from "@/lib/meetings/repository"

export type MeetingWorkStatusKind =
  | "completed"
  | "ready"
  | "processing"
  | "failed"
  | "upcoming"
  | "blocked"

export type MeetingWorkStatusAction =
  | CaptureReadinessAction
  | "retry"
  | "find_drive"

export type MeetingWorkStatus = {
  kind: MeetingWorkStatusKind
  title: string
  description: string
  primaryAction: MeetingWorkStatusAction
  checks: CaptureReadinessCheck[]
  jobId?: string
  stage?: string
  progress?: number
  retryable?: boolean
}

const stageDetails: Record<string, { title: string; titleHe: string; progress: number }> = {
  "artifact.import": { title: "Importing Meet artifact", titleHe: "מייבא תוצר Meet", progress: 0.2 },
  "drive.import": { title: "Importing Drive recording", titleHe: "מייבא הקלטה מ-Drive", progress: 0.2 },
  "audio.extract": { title: "Extracting audio", titleHe: "מחלץ שמע", progress: 0.3 },
  "audio.transcribe": { title: "Transcribing audio", titleHe: "מתמלל שמע", progress: 0.35 },
  transcribing: { title: "Transcribing audio", titleHe: "מתמלל שמע", progress: 0.35 },
  "transcript.clean": { title: "Cleaning transcript", titleHe: "מנקה תמלול", progress: 0.5 },
  "summary.generate": { title: "Generating summary", titleHe: "מפיק סיכום", progress: 0.65 },
  summarizing: { title: "Generating summary", titleHe: "מפיק סיכום", progress: 0.65 },
  "summary.persist": { title: "Saving summary", titleHe: "שומר את הסיכום", progress: 0.7 },
  "tasks.extract": { title: "Extracting tasks", titleHe: "מחלץ משימות", progress: 0.75 },
  "meeting.index": { title: "Indexing meeting memory", titleHe: "מאנדקס את זיכרון הפגישה", progress: 0.85 },
  indexing: { title: "Indexing meeting memory", titleHe: "מאנדקס את זיכרון הפגישה", progress: 0.85 },
  "quality.review": { title: "Reviewing quality", titleHe: "בודק איכות", progress: 0.92 },
  completed: { title: "Completed", titleHe: "הושלם", progress: 1 },
}

/**
 * Background search-index jobs (M6): a debounced `meeting.index` after an
 * edit or the periodic `search.index.sweep` must never make a finished
 * meeting look like it is processing again, so they never count as the
 * meeting's latest pipeline job.
 */
const BACKGROUND_JOB_NAMES = new Set(["meeting.index", "search.index.sweep"])

export function isBackgroundIndexJob(job: Pick<JobRecord, "name">) {
  return BACKGROUND_JOB_NAMES.has(job.name)
}

/** Localized title for a pipeline stage, or undefined for unknown stages. */
export function meetingStageTitle(stage: string, locale: "he" | "en" = "en") {
  const details = stageDetails[stage]

  if (!details) return undefined

  return locale === "he" ? details.titleHe : details.title
}

function jobStage(job: JobRecord) {
  if (typeof job.result.stage === "string") return job.result.stage
  if (typeof job.payload.stage === "string") return job.payload.stage

  return job.name
}

function jobTime(job: JobRecord) {
  const value = job.updatedAt ?? job.createdAt
  const time = new Date(value).getTime()

  return Number.isNaN(time) ? 0 : time
}

function latestMeetingJob(meeting: MeetingRecord, jobs: JobRecord[]) {
  return jobs
    .filter((job) => job.meetingId === meeting.id && !isBackgroundIndexJob(job))
    .sort((a, b) => jobTime(b) - jobTime(a))[0]
}

function processingDescription(job: JobRecord, stage: string) {
  const label = stageDetails[stage]?.title ?? "Processing meeting"

  return `${label}. Job ${job.id} is ${job.status}.`
}

export function getMeetingWorkStatus(
  meeting: MeetingRecord,
  jobs: JobRecord[] = []
): MeetingWorkStatus {
  const readiness = getMeetingCaptureReadiness(meeting)
  const latestJob = latestMeetingJob(meeting, jobs)

  if (latestJob?.status === "queued" || latestJob?.status === "active") {
    const stage = jobStage(latestJob)
    const details = stageDetails[stage] ?? {
      title: "Processing meeting",
      progress: 0.15,
    }

    return {
      kind: "processing",
      title: details.title,
      description: processingDescription(latestJob, stage),
      primaryAction: "none",
      checks: readiness.checks,
      jobId: latestJob.id,
      stage,
      progress: details.progress,
      retryable: false,
    }
  }

  if (readiness.status === "processed") {
    return {
      kind: "completed",
      title: readiness.title,
      description: readiness.description,
      primaryAction: readiness.primaryAction,
      checks: readiness.checks,
      progress: 1,
    }
  }

  if (latestJob?.status === "failed" || meeting.status === "failed") {
    const stage = latestJob ? jobStage(latestJob) : undefined

    return {
      kind: "failed",
      title: "Processing failed",
      description:
        latestJob?.error ??
        "The last processing attempt failed. Review the job error and retry when ready.",
      primaryAction: latestJob?.retryable === false ? "none" : "retry",
      checks: readiness.checks,
      jobId: latestJob?.id,
      stage,
      progress: 0,
      retryable: latestJob?.retryable !== false,
    }
  }

  if (readiness.status === "ready_to_process") {
    return {
      kind: "ready",
      title: readiness.title,
      description: readiness.description,
      primaryAction: readiness.primaryAction,
      checks: readiness.checks,
      progress: 0,
    }
  }

  if (readiness.status === "capture_armed") {
    return {
      kind: "upcoming",
      title: readiness.title,
      description: readiness.description,
      primaryAction: readiness.primaryAction,
      checks: readiness.checks,
      progress: 0,
    }
  }

  return {
    kind: "blocked",
    title: readiness.title,
    description: readiness.description,
    primaryAction: readiness.primaryAction,
    checks: readiness.checks,
    progress: 0,
  }
}
