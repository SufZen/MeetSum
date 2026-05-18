import { Worker, type Job } from "bullmq"

import {
  createSummaryProvider,
  createTranscriptionProvider,
  getGeminiProviderMode,
  getTranscriptionRunMetadata,
} from "@/lib/ai/providers"
import { getDatabasePool } from "@/lib/db/client"
import {
  importMeetRecordingArtifactsForMeeting,
  importMeetTranscriptArtifactsForMeeting,
  syncMeetArtifacts,
} from "@/lib/google/meet-artifacts"
import { pollCalendar, pollDrive, pollGmail } from "@/lib/google/services"
import { cleanupTranscriptSegments } from "@/lib/intelligence"
import { exportMeetingToRealizeOS } from "@/lib/integrations/realizeos"
import { meetingRepository } from "@/lib/meetings/store"
import { deliverWebhookEvent } from "@/lib/webhooks/delivery"
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

async function deliverPlatformEvent(
  eventName: Parameters<typeof deliverWebhookEvent>[0]["eventName"],
  data: Record<string, unknown>
) {
  try {
    await deliverWebhookEvent({ eventName, data })
  } catch {
    // Webhook delivery must never hide the primary processing result.
  }
}

async function recordAiRun(options: {
  meetingId: string
  task: string
  status: "completed" | "failed"
  startedAt: number
  provider?: string
  model?: string
  metadata?: Record<string, unknown>
  error?: string
}) {
  if (process.env.MEETSUM_STORAGE !== "postgres") return

  await getDatabasePool().query(
    `
      insert into ai_runs (
        id, meeting_id, provider, task, status, metadata, model,
        latency_ms, confidence, started_at, completed_at, error
      )
      values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, now(), $11)
    `,
    [
      `airun_${crypto.randomUUID()}`,
      options.meetingId,
      options.provider ?? getGeminiProviderMode(),
      options.task,
      options.status,
      JSON.stringify(options.metadata ?? {}),
      options.model ?? null,
      Date.now() - options.startedAt,
      typeof options.metadata?.confidence === "number"
        ? options.metadata.confidence
        : null,
      new Date(options.startedAt).toISOString(),
      options.error ?? null,
    ]
  )
}

async function processMediaJob(
  payload: MeetSumJobPayload,
  jobRecordId?: string
) {
  if (!payload.meetingId) {
    throw new Error("meetingId is required")
  }

  await meetingRepository.updateMeetingStatus(payload.meetingId, "transcribing")
  if (jobRecordId) {
    await meetingRepository.updateJob(jobRecordId, {
      result: { stage: "audio.transcribe" },
    })
  }
  const meeting = await meetingRepository.getMeeting(payload.meetingId)

  if (!meeting) {
    throw new Error(`Meeting not found: ${payload.meetingId}`)
  }

  const mediaAsset = meeting.mediaAssets?.find((asset) => asset.storageKey)

  if (!mediaAsset) {
    throw new Error(
      "This meeting has no recording attached yet. Import a Drive recording, sync Meet artifacts, or upload audio before processing."
    )
  }

  const transcriptionStartedAt = Date.now()
  const transcriptionProvider = createTranscriptionProvider()
  const transcript = await transcriptionProvider.transcribe(meeting)
  const transcriptionRun = getTranscriptionRunMetadata(transcriptionProvider)
  await recordAiRun({
    meetingId: meeting.id,
    task: "audio.transcribe",
    status: "completed",
    startedAt: transcriptionStartedAt,
    model: transcriptionRun.model,
    provider: transcriptionRun.provider,
    metadata: {
      segments: transcript.length,
      providerMode: transcriptionRun.provider,
      fallbackUsed: transcriptionRun.fallbackUsed ?? false,
      attemptedProvider: transcriptionRun.attemptedProvider,
      fallbackReason: transcriptionRun.fallbackReason,
      inputAsset: payload.assetId ?? payload.storageKey,
      confidence:
        transcript.length > 0
          ? transcript.reduce((sum, segment) => sum + (segment.confidence ?? 0), 0) /
            transcript.length
          : 0,
    },
  })
  await meetingRepository.replaceTranscriptSegments(meeting.id, transcript)
  await meetingRepository.updateMeetingStatus(meeting.id, "summarizing")
  if (jobRecordId) {
    await meetingRepository.updateJob(jobRecordId, {
      result: { stage: "summary.generate", transcriptSegments: transcript.length },
    })
  }

  const refreshed = await meetingRepository.getMeeting(meeting.id)
  const summaryStartedAt = Date.now()
  const intelligence = await createSummaryProvider().summarize(
    refreshed ?? { ...meeting, transcript }
  )
  await recordAiRun({
    meetingId: meeting.id,
    task: "summary.generate",
    status: "completed",
    startedAt: summaryStartedAt,
    model: process.env.GOOGLE_GEMINI_SUMMARY_MODEL ?? "heuristic-v1",
    metadata: {
      providerMode: getGeminiProviderMode(),
      tags: intelligence.tags,
      confidence: intelligence.languageMetadata.confidence,
    },
  })

  await meetingRepository.updateMeetingStatus(meeting.id, "indexing")
  if (jobRecordId) {
    await meetingRepository.updateJob(jobRecordId, {
      result: { stage: "meeting.index", transcriptSegments: transcript.length },
    })
  }
  await meetingRepository.upsertMeetingIntelligence(
    meeting.id,
    intelligence,
    getGeminiProviderMode(),
    process.env.GOOGLE_GEMINI_SUMMARY_MODEL ?? "heuristic-v1"
  )
  await deliverPlatformEvent("summary.created", {
    meetingId: meeting.id,
    title: meeting.title,
    tags: intelligence.tags,
  })
  for (const item of intelligence.actionItems) {
    await deliverPlatformEvent("action_item.created", {
      meetingId: meeting.id,
      actionItemId: item.id,
      title: item.title,
      owner: item.owner,
      priority: item.priority,
    })
  }
  await deliverPlatformEvent("meeting.completed", {
    meetingId: meeting.id,
    title: meeting.title,
  })

  return {
    meetingId: meeting.id,
    transcriptSegments: transcript.length,
    tags: intelligence.tags,
  }
}

async function processIntelligenceOnlyJob(
  payload: MeetSumJobPayload,
  jobRecordId?: string
) {
  if (!payload.meetingId) {
    throw new Error("meetingId is required")
  }

  const meeting = await meetingRepository.getMeeting(payload.meetingId)

  if (!meeting) {
    throw new Error(`Meeting not found: ${payload.meetingId}`)
  }

  await meetingRepository.updateMeetingStatus(meeting.id, "summarizing")
  if (jobRecordId) {
    await meetingRepository.updateJob(jobRecordId, {
      result: { stage: "summary.generate", mode: payload.mode },
    })
  }

  const cleanedTranscript = cleanupTranscriptSegments(meeting.transcript ?? [])
  if (cleanedTranscript.length) {
    await meetingRepository.replaceTranscriptSegments(meeting.id, cleanedTranscript)
  }

  const refreshed = await meetingRepository.getMeeting(meeting.id)
  const summaryStartedAt = Date.now()
  const intelligence = await createSummaryProvider().summarize(
    refreshed ?? { ...meeting, transcript: cleanedTranscript }
  )

  await recordAiRun({
    meetingId: meeting.id,
    task: String(payload.mode ?? "summary.generate"),
    status: "completed",
    startedAt: summaryStartedAt,
    model: process.env.GOOGLE_GEMINI_SUMMARY_MODEL ?? "heuristic-v1",
    metadata: {
      providerMode: getGeminiProviderMode(),
      tags: intelligence.tags,
      confidence: intelligence.languageMetadata.confidence,
      mode: payload.mode,
    },
  })

  await meetingRepository.updateMeetingStatus(meeting.id, "indexing")
  if (jobRecordId) {
    await meetingRepository.updateJob(jobRecordId, {
      result: { stage: "meeting.index", mode: payload.mode },
    })
  }
  await meetingRepository.upsertMeetingIntelligence(
    meeting.id,
    intelligence,
    getGeminiProviderMode(),
    process.env.GOOGLE_GEMINI_SUMMARY_MODEL ?? "heuristic-v1"
  )
  await deliverPlatformEvent("summary.created", {
    meetingId: meeting.id,
    title: meeting.title,
    mode: payload.mode,
    tags: intelligence.tags,
  })
  for (const item of intelligence.actionItems) {
    await deliverPlatformEvent("action_item.created", {
      meetingId: meeting.id,
      actionItemId: item.id,
      title: item.title,
      owner: item.owner,
      priority: item.priority,
    })
  }
  await deliverPlatformEvent("meeting.completed", {
    meetingId: meeting.id,
    title: meeting.title,
    mode: payload.mode,
  })

  return {
    meetingId: meeting.id,
    transcriptSegments: cleanedTranscript.length,
    tags: intelligence.tags,
    mode: payload.mode,
  }
}

async function processArtifactImportJob(
  payload: MeetSumJobPayload,
  jobRecordId?: string
) {
  if (!payload.meetingId) {
    throw new Error("meetingId is required")
  }

  await meetingRepository.updateMeetingStatus(payload.meetingId, "transcribing")
  if (jobRecordId) {
    await meetingRepository.updateJob(jobRecordId, {
      result: { stage: "artifact.import" },
    })
  }

  const artifactIds = Array.isArray(payload.artifactIds)
    ? payload.artifactIds.filter(
        (artifactId): artifactId is string => typeof artifactId === "string"
      )
    : undefined
  const subject = typeof payload.subject === "string" ? payload.subject : undefined
  let imported: Awaited<ReturnType<typeof importMeetTranscriptArtifactsForMeeting>>

  try {
    imported = await importMeetTranscriptArtifactsForMeeting({
      meetingId: payload.meetingId,
      subject,
      artifactIds,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    let recordingImport: Awaited<ReturnType<typeof importMeetRecordingArtifactsForMeeting>>

    try {
      recordingImport = await importMeetRecordingArtifactsForMeeting({
        meetingId: payload.meetingId,
        subject,
        artifactIds,
      })
    } catch (recordingError) {
      const recordingMessage =
        recordingError instanceof Error ? recordingError.message : String(recordingError)

      throw new Error(
        `${message} Recording fallback also failed: ${recordingMessage}`
      )
    }

    if (jobRecordId) {
      await meetingRepository.updateJob(jobRecordId, {
        result: {
          stage: "drive.import",
          artifactIds: recordingImport.artifactIds,
          importedFiles: recordingImport.importedFiles,
          skippedFiles: recordingImport.skippedFiles,
          errors: recordingImport.errors,
        },
      })
    }

    return {
      meetingId: payload.meetingId,
      mode: "meet-recording-artifact",
      importedFiles: recordingImport.importedFiles,
      skippedFiles: recordingImport.skippedFiles,
      jobs: recordingImport.jobs,
      errors: recordingImport.errors,
    }
  }

  await meetingRepository.replaceTranscriptSegments(
    payload.meetingId,
    imported.transcriptSegments
  )
  if (jobRecordId) {
    await meetingRepository.updateJob(jobRecordId, {
      result: {
        stage: "summary.generate",
        importedEntries: imported.importedEntries,
        importedSmartNotes: imported.importedSmartNotes,
        artifactIds: imported.artifactIds,
      },
    })
  }

  return processIntelligenceOnlyJob(
    { ...payload, mode: "summary", source: "meet-artifact" },
    jobRecordId
  )
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

  if (name === "google.meet.poll") {
    return syncMeetArtifacts({
      subject,
      limit:
        typeof payload.limit === "number"
          ? payload.limit
          : Number(process.env.MEETSUM_MEET_POLL_LIMIT ?? 10),
    })
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
      job.name === "meeting.index"
    ) {
      result = await processMediaJob(job.data, jobRecordId)
    } else if (job.name === "artifact.import") {
      result = await processArtifactImportJob(job.data, jobRecordId)
    } else if (job.name === "meeting.summarize") {
      result =
        job.data.mode === "full"
          ? await processMediaJob(job.data, jobRecordId)
          : await processIntelligenceOnlyJob(job.data, jobRecordId)
    } else if (job.name.startsWith("google.")) {
      result = await processGoogleJob(job.name, job.data)
    } else if (job.name === "realizeos.export") {
      result = await exportMeetingToRealizeOS({
        meetingId: job.data.meetingId,
        suggestionId:
          typeof job.data.suggestionId === "string"
            ? job.data.suggestionId
            : undefined,
        contextId:
          typeof job.data.contextId === "string" ? job.data.contextId : undefined,
      })
    } else if (job.name === "webhook.deliver") {
      result = await deliverWebhookEvent({
        eventName:
          typeof job.data.eventName === "string"
            ? (job.data.eventName as Parameters<typeof deliverWebhookEvent>[0]["eventName"])
            : "meeting.completed",
        data:
          job.data.data && typeof job.data.data === "object"
            ? (job.data.data as Record<string, unknown>)
            : {},
      })
    }

    await completeJob(jobRecordId, result)
    return result
  } catch (error) {
    await failJob(jobRecordId, error)
    if (job.data.meetingId) {
      await meetingRepository.updateMeetingStatus(job.data.meetingId, "failed")
      await deliverPlatformEvent("meeting.process_failed", {
        meetingId: job.data.meetingId,
        jobId: jobRecordId,
        jobName: job.name,
        error: error instanceof Error ? error.message : "Unknown job failure",
      })
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
      concurrency: Number(process.env.MEETSUM_WORKER_CONCURRENCY ?? 1),
      lockDuration: Number(process.env.MEETSUM_WORKER_LOCK_DURATION_MS ?? 1_800_000),
      stalledInterval: Number(process.env.MEETSUM_WORKER_STALLED_INTERVAL_MS ?? 60_000),
      maxStalledCount: Number(process.env.MEETSUM_WORKER_MAX_STALLED_COUNT ?? 2),
    }
  )
}
