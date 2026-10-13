/**
 * Work status of a meeting as codes only (M9: components translate `kind`,
 * `stage` and `primaryAction`; see `workStatusText` in
 * components/meeting-summary-view.tsx and `workStatusTitle` in
 * components/pipeline-timeline.tsx). Client-safe: no dictionary import.
 */
import {
  getMeetingCaptureReadiness,
  type CaptureReadinessAction,
  type CaptureReadinessCheck,
  type CaptureReadinessStatus,
} from "@/lib/meetings/capture-readiness"
import type { JobRecord, JobStatus, MeetingRecord } from "@/lib/meetings/repository"

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
  primaryAction: MeetingWorkStatusAction
  checks: CaptureReadinessCheck[]
  /** Capture readiness code behind completed/ready/upcoming/blocked. */
  readiness?: CaptureReadinessStatus
  jobId?: string
  jobStatus?: JobStatus
  stage?: string
  progress?: number
  retryable?: boolean
}

/** Dictionary key of each pipeline stage (lib/i18n/m9/content-meeting.ts). */
export const MEETING_STAGE_MESSAGE_KEYS: Record<string, string> = {
  "artifact.import": "mtgStageArtifactImport",
  "drive.import": "mtgStageDriveImport",
  "audio.extract": "mtgStageAudioExtract",
  "audio.transcribe": "mtgStageTranscribe",
  transcribing: "mtgStageTranscribe",
  "transcript.clean": "mtgStageTranscriptClean",
  "summary.generate": "mtgStageSummary",
  summarizing: "mtgStageSummary",
  "summary.persist": "mtgStageSummaryPersist",
  "tasks.extract": "mtgStageTasks",
  "meeting.index": "mtgStageIndex",
  indexing: "mtgStageIndex",
  "quality.review": "mtgStageQuality",
  completed: "mtgStageCompleted",
}

const STAGE_PROGRESS: Record<string, number> = {
  "artifact.import": 0.2,
  "drive.import": 0.2,
  "audio.extract": 0.3,
  "audio.transcribe": 0.35,
  transcribing: 0.35,
  "transcript.clean": 0.5,
  "summary.generate": 0.65,
  summarizing: 0.65,
  "summary.persist": 0.7,
  "tasks.extract": 0.75,
  "meeting.index": 0.85,
  indexing: 0.85,
  "quality.review": 0.92,
  completed: 1,
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

/** Dictionary key of a pipeline stage, or undefined for unknown stages. */
export function meetingStageMessageKey(stage: string): string | undefined {
  return MEETING_STAGE_MESSAGE_KEYS[stage]
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

export function getMeetingWorkStatus(
  meeting: MeetingRecord,
  jobs: JobRecord[] = []
): MeetingWorkStatus {
  const readiness = getMeetingCaptureReadiness(meeting)
  const latestJob = latestMeetingJob(meeting, jobs)

  if (latestJob?.status === "queued" || latestJob?.status === "active") {
    const stage = jobStage(latestJob)

    return {
      kind: "processing",
      primaryAction: "none",
      checks: readiness.checks,
      jobId: latestJob.id,
      jobStatus: latestJob.status,
      stage,
      progress: STAGE_PROGRESS[stage] ?? 0.15,
      retryable: false,
    }
  }

  if (readiness.status === "processed") {
    return {
      kind: "completed",
      readiness: readiness.status,
      primaryAction: readiness.primaryAction,
      checks: readiness.checks,
      progress: 1,
    }
  }

  if (latestJob?.status === "failed" || meeting.status === "failed") {
    const stage = latestJob ? jobStage(latestJob) : undefined

    return {
      kind: "failed",
      primaryAction: latestJob?.retryable === false ? "none" : "retry",
      checks: readiness.checks,
      jobId: latestJob?.id,
      jobStatus: latestJob?.status,
      stage,
      progress: 0,
      retryable: latestJob?.retryable !== false,
    }
  }

  if (readiness.status === "ready_to_process") {
    return {
      kind: "ready",
      readiness: readiness.status,
      primaryAction: readiness.primaryAction,
      checks: readiness.checks,
      progress: 0,
    }
  }

  if (readiness.status === "capture_armed") {
    return {
      kind: "upcoming",
      readiness: readiness.status,
      primaryAction: readiness.primaryAction,
      checks: readiness.checks,
      progress: 0,
    }
  }

  return {
    kind: "blocked",
    readiness: readiness.status,
    primaryAction: readiness.primaryAction,
    checks: readiness.checks,
    progress: 0,
  }
}
