import { Worker, type Job } from "bullmq"

import {
  createSummaryProvider,
  createTranscriptionProvider,
} from "@/lib/ai/providers"
import { pollCalendar, pollDrive, pollGmail } from "@/lib/google/services"
import { meetingRepository } from "@/lib/meetings/store"
import type { MeetSumJobName, MeetSumJobPayload } from "@/lib/jobs/queue"

async function markActive(job: Job<MeetSumJobPayload, unknown, MeetSumJobName>) {
  const jobRecordId = String(job.data.jobRecordId ?? job.id)

  await meetingRepository.updateJob(jobRecordId, {
    status: "active",
    attempts: job.attemptsMade + 1,
  })

  return jobRecordId
}

async function completeJob(
  jobRecordId: string,
  result: Record<string, unknown> = {}
) {
  await meetingRepository.updateJob(jobRecordId, {
    status: "completed",
    result,
  })
}

async function failJob(jobRecordId: string, error: unknown) {
  await meetingRepository.updateJob(jobRecordId, {
    status: "failed",
    error: error instanceof Error ? error.message : "Unknown job failure",
  })
}

async function processMediaJob(payload: MeetSumJobPayload) {
  if (!payload.meetingId) {
    throw new Error("meetingId is required")
  }

  await meetingRepository.updateMeetingStatus(payload.meetingId, "transcribing")
  const meeting = await meetingRepository.getMeeting(payload.meetingId)

  if (!meeting) {
    throw new Error(`Meeting not found: ${payload.meetingId}`)
  }

  const transcript = await createTranscriptionProvider().transcribe(meeting)
  await meetingRepository.replaceTranscriptSegments(meeting.id, transcript)
  await meetingRepository.updateMeetingStatus(meeting.id, "summarizing")

  const refreshed = await meetingRepository.getMeeting(meeting.id)
  const intelligence = await createSummaryProvider().summarize(
    refreshed ?? { ...meeting, transcript }
  )

  await meetingRepository.updateMeetingStatus(meeting.id, "indexing")
  await meetingRepository.upsertMeetingIntelligence(
    meeting.id,
    intelligence,
    process.env.GOOGLE_GEMINI_API_KEY ? "gemini" : "local",
    process.env.GOOGLE_GEMINI_SUMMARY_MODEL ?? "heuristic-v1"
  )

  return {
    meetingId: meeting.id,
    transcriptSegments: transcript.length,
    tags: intelligence.tags,
  }
}

async function processGoogleJob(
  name: MeetSumJobName,
  payload: MeetSumJobPayload
) {
  const subject =
    typeof payload.subject === "string"
      ? payload.subject
      : process.env.GOOGLE_WORKSPACE_SUBJECT ??
        process.env.GOOGLE_WORKSPACE_ADMIN_EMAIL ??
        "info@realization.co.il"

  if (name === "google.calendar.poll") {
    return pollCalendar(subject)
  }

  if (name === "google.drive.poll") {
    return pollDrive(subject)
  }

  if (name === "google.gmail.poll") {
    return pollGmail(subject)
  }

  return { source: name, status: "ignored" }
}

async function processJob(job: Job<MeetSumJobPayload, unknown, MeetSumJobName>) {
  const jobRecordId = await markActive(job)

  try {
    let result: Record<string, unknown> = {}

    if (
      job.name === "media.ingest" ||
      job.name === "meeting.transcribe" ||
      job.name === "meeting.summarize" ||
      job.name === "meeting.index"
    ) {
      result = await processMediaJob(job.data)
    } else if (job.name.startsWith("google.")) {
      result = await processGoogleJob(job.name, job.data)
    } else if (job.name === "realizeos.export") {
      result = { status: "export-ready", meetingId: job.data.meetingId }
    } else if (job.name === "webhook.deliver") {
      result = { status: "delivery-ready" }
    }

    await completeJob(jobRecordId, result)
    return result
  } catch (error) {
    await failJob(jobRecordId, error)
    if (job.data.meetingId) {
      await meetingRepository.updateMeetingStatus(job.data.meetingId, "failed")
    }
    throw error
  }
}

export function createMeetSumWorker() {
  return new Worker<MeetSumJobPayload, unknown, MeetSumJobName>(
    "meetsum",
    processJob,
    {
      connection: {
        url: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
      },
      concurrency: Number(process.env.MEETSUM_WORKER_CONCURRENCY ?? 2),
    }
  )
}
