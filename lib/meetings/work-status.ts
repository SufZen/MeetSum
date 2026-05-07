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

const stageDetails: Record<string, { title: string; progress: number }> = {
  "artifact.import": { title: "Importing Meet artifact", progress: 0.2 },
  "drive.import": { title: "Importing Drive recording", progress: 0.2 },
  "audio.extract": { title: "Extracting audio", progress: 0.3 },
  "audio.transcribe": { title: "Transcribing audio", progress: 0.35 },
  transcribing: { title: "Transcribing audio", progress: 0.35 },
  "transcript.clean": { title: "Cleaning transcript", progress: 0.5 },
  "summary.generate": { title: "Generating summary", progress: 0.65 },
  summarizing: { title: "Generating summary", progress: 0.65 },
  "tasks.extract": { title: "Extracting tasks", progress: 0.75 },
  "meeting.index": { title: "Indexing meeting memory", progress: 0.85 },
  indexing: { title: "Indexing meeting memory", progress: 0.85 },
  "quality.review": { title: "Reviewing quality", progress: 0.92 },
  completed: { title: "Completed", progress: 1 },
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
    .filter((job) => job.meetingId === meeting.id)
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
