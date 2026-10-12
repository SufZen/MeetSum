import { UnrecoverableError, Worker, type Job } from "bullmq"

import {
  createSummaryProvider,
  createTranscriptionProvider,
  getGeminiProviderMode,
  getSummaryRunMetadata,
  getTranscriptionRunMetadata,
  TranscriptionUnavailableError,
} from "@/lib/ai/providers"
import { importPlatformRecording } from "@/lib/capture/recording-import"
import { renewTeamsSubscriptions } from "@/lib/capture/teams-subscriptions"
import type { CaptureEvent } from "@/lib/capture/types"
import { getDatabasePool } from "@/lib/db/client"
import {
  importMeetRecordingArtifactsForMeeting,
  importMeetTranscriptArtifactsForMeeting,
  syncMeetArtifacts,
} from "@/lib/google/meet-artifacts"
import { pollCalendar, pollDrive, pollGmail } from "@/lib/google/services"
import { resolveWorkspaceSubject } from "@/lib/google/workspace-subject"
import { cleanupTranscriptSegments, type MeetingIntelligence } from "@/lib/intelligence"
import { exportMeetingToRealizeOS } from "@/lib/integrations/realizeos"
import type { MediaAsset, MeetingRecord } from "@/lib/meetings/repository"
import { meetingRepository } from "@/lib/meetings/store"
import {
  deliverWebhookEvent,
  processWebhookDeliveryJob,
} from "@/lib/webhooks/delivery"
import type { MeetSumJobName, MeetSumJobPayload } from "@/lib/jobs/queue"

export type MeetSumJob = Job<MeetSumJobPayload, unknown, MeetSumJobName>

const NO_RECORDING_MESSAGE =
  "This meeting has no recording attached yet. Import a Drive recording, sync Meet artifacts, or upload audio before processing."

function errorMessage(error: unknown, fallback = "Unknown job failure") {
  return error instanceof Error ? error.message : fallback
}

/**
 * Marks an error as permanent so BullMQ does not retry it: retrying a job
 * whose meeting/recording does not exist (or that has no ASR provider) can
 * never succeed and only delays the failure the user sees.
 */
export function toPermanentError(error: unknown): UnrecoverableError {
  if (error instanceof UnrecoverableError) return error

  const permanent = new UnrecoverableError(errorMessage(error))

  if (error instanceof Error && error.stack) permanent.stack = error.stack
  return permanent
}

function requireMeetingId(payload: MeetSumJobPayload): string {
  if (!payload.meetingId) {
    throw toPermanentError(new Error("meetingId is required"))
  }

  return payload.meetingId
}

async function loadMeeting(meetingId: string): Promise<MeetingRecord> {
  const meeting = await meetingRepository.getMeeting(meetingId)

  if (!meeting) {
    throw toPermanentError(new Error(`Meeting not found: ${meetingId}`))
  }

  return meeting
}

async function markActive(job: MeetSumJob) {
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

async function failJob(jobRecordId: string, error: unknown, attempts: number) {
  await meetingRepository.updateJob(jobRecordId, {
    status: "failed",
    error: errorMessage(error),
    attempts,
  })
}

async function setStage(
  jobRecordId: string | undefined,
  result: Record<string, unknown>
) {
  if (!jobRecordId) return

  await meetingRepository.updateJob(jobRecordId, { result })
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
  jobId?: string
  provider?: string
  model?: string
  metadata?: Record<string, unknown>
  error?: string
}) {
  if (process.env.MEETSUM_STORAGE !== "postgres") return

  try {
    await getDatabasePool().query(
      `
        insert into ai_runs (
          id, meeting_id, provider, task, status, metadata, model,
          latency_ms, confidence, started_at, completed_at, error, job_id
        )
        values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, now(), $11, $12)
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
        options.jobId ?? null,
      ]
    )
  } catch (error) {
    // ai_runs is observability; losing a row must not fail the pipeline.
    console.warn("Failed to record ai_run", error)
  }
}

function newestAssetWithStorage(assets: MediaAsset[]) {
  return assets
    .filter((asset) => asset.storageKey)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
}

/**
 * Picks the recording a job should process: the explicit `assetId` (unknown
 * → permanent failure), then a matching `storageKey`, then the newest asset.
 */
export function selectMediaAsset(
  meeting: MeetingRecord,
  payload: MeetSumJobPayload
): MediaAsset | undefined {
  const assets = meeting.mediaAssets ?? []

  if (typeof payload.assetId === "string" && payload.assetId) {
    const asset = assets.find((candidate) => candidate.id === payload.assetId)

    if (!asset?.storageKey) {
      throw new UnrecoverableError(
        `Media asset ${payload.assetId} not found for meeting ${meeting.id}`
      )
    }

    return asset
  }

  if (typeof payload.storageKey === "string" && payload.storageKey) {
    const asset = assets.find(
      (candidate) => candidate.storageKey === payload.storageKey
    )

    if (asset) return asset
  }

  return newestAssetWithStorage(assets)
}

function withSelectedAsset(meeting: MeetingRecord, asset: MediaAsset): MeetingRecord {
  return {
    ...meeting,
    mediaAssets: [
      asset,
      ...(meeting.mediaAssets ?? []).filter((candidate) => candidate.id !== asset.id),
    ],
  }
}

function platformImportRequest(
  payload: MeetSumJobPayload
): { platform: "zoom" | "teams"; captureEvent: CaptureEvent } | undefined {
  const platform = payload.platform

  if (
    (platform === "zoom" || platform === "teams") &&
    payload.captureEvent &&
    typeof payload.captureEvent === "object"
  ) {
    return { platform, captureEvent: payload.captureEvent as CaptureEvent }
  }

  return undefined
}

async function resolveRecording(
  meeting: MeetingRecord,
  payload: MeetSumJobPayload,
  jobRecordId?: string
): Promise<{ meeting: MeetingRecord; asset: MediaAsset }> {
  const selected = selectMediaAsset(meeting, payload)

  if (selected) return { meeting, asset: selected }

  const platformImport = platformImportRequest(payload)

  if (!platformImport) {
    throw new UnrecoverableError(NO_RECORDING_MESSAGE)
  }

  await setStage(jobRecordId, {
    stage: "recording.download",
    platform: platformImport.platform,
  })

  const imported = await importPlatformRecording({
    meetingId: meeting.id,
    platform: platformImport.platform,
    captureEvent: platformImport.captureEvent,
  })
  const refreshed = await loadMeeting(meeting.id)
  const asset = selectMediaAsset(refreshed, { assetId: imported.assetId })

  if (!asset) throw new UnrecoverableError(NO_RECORDING_MESSAGE)

  return { meeting: refreshed, asset }
}

async function summarizeAndPersist(options: {
  meeting: MeetingRecord
  summaryInput: MeetingRecord
  task: string
  jobRecordId?: string
  stageResult: Record<string, unknown>
  metadata?: Record<string, unknown>
}) {
  const { meeting, jobRecordId } = options
  const previousActionItemIds = new Set(
    (meeting.summary?.actionItems ?? []).map((item) => item.id)
  )
  const summaryStartedAt = Date.now()
  const summaryProvider = createSummaryProvider()
  let intelligence: MeetingIntelligence

  try {
    intelligence = await summaryProvider.summarize(options.summaryInput)
  } catch (error) {
    const run = getSummaryRunMetadata(summaryProvider)

    await recordAiRun({
      meetingId: meeting.id,
      task: options.task,
      status: "failed",
      startedAt: summaryStartedAt,
      jobId: jobRecordId,
      provider: run.provider,
      model: run.model,
      metadata: { providerMode: getGeminiProviderMode(), ...options.metadata },
      error: errorMessage(error),
    })
    throw error
  }

  const summaryRun = getSummaryRunMetadata(summaryProvider)

  await recordAiRun({
    meetingId: meeting.id,
    task: options.task,
    status: "completed",
    startedAt: summaryStartedAt,
    jobId: jobRecordId,
    provider: summaryRun.provider,
    model: summaryRun.model,
    metadata: {
      providerMode: getGeminiProviderMode(),
      fallbackUsed: summaryRun.fallbackUsed ?? false,
      fallbackReason: summaryRun.fallbackReason,
      tags: intelligence.tags,
      confidence: intelligence.languageMetadata.confidence,
      ...options.metadata,
    },
  })

  await meetingRepository.updateMeetingStatus(meeting.id, "indexing")
  await setStage(jobRecordId, { stage: "meeting.index", ...options.stageResult })

  const persisted = await meetingRepository.upsertMeetingIntelligence(
    meeting.id,
    intelligence,
    summaryRun.provider,
    summaryRun.model
  )
  const newActionItems = (persisted ?? intelligence).actionItems.filter(
    (item) => !previousActionItemIds.has(item.id)
  )

  return { intelligence, newActionItems }
}

async function processMediaJob(
  payload: MeetSumJobPayload,
  jobRecordId?: string
) {
  const meetingId = requireMeetingId(payload)
  const { meeting, asset } = await resolveRecording(
    await loadMeeting(meetingId),
    payload,
    jobRecordId
  )

  await meetingRepository.updateMeetingStatus(meeting.id, "transcribing")
  await setStage(jobRecordId, { stage: "audio.transcribe", assetId: asset.id })

  const inputAsset = { inputAsset: asset.id, inputStorageKey: asset.storageKey }
  const transcriptionStartedAt = Date.now()
  const transcriptionProvider = createTranscriptionProvider()
  let transcript: Awaited<ReturnType<typeof transcriptionProvider.transcribe>>

  try {
    transcript = await transcriptionProvider.transcribe(
      withSelectedAsset(meeting, asset)
    )
  } catch (error) {
    const run = getTranscriptionRunMetadata(transcriptionProvider)

    await recordAiRun({
      meetingId: meeting.id,
      task: "audio.transcribe",
      status: "failed",
      startedAt: transcriptionStartedAt,
      jobId: jobRecordId,
      provider: run.provider,
      model: run.model,
      metadata: { providerMode: run.provider, ...inputAsset },
      error: errorMessage(error),
    })
    if (error instanceof TranscriptionUnavailableError) {
      throw toPermanentError(error)
    }
    throw error
  }

  const transcriptionRun = getTranscriptionRunMetadata(transcriptionProvider)
  await recordAiRun({
    meetingId: meeting.id,
    task: "audio.transcribe",
    status: "completed",
    startedAt: transcriptionStartedAt,
    jobId: jobRecordId,
    model: transcriptionRun.model,
    provider: transcriptionRun.provider,
    metadata: {
      segments: transcript.length,
      providerMode: transcriptionRun.provider,
      fallbackUsed: transcriptionRun.fallbackUsed ?? false,
      attemptedProvider: transcriptionRun.attemptedProvider,
      fallbackReason: transcriptionRun.fallbackReason,
      ...inputAsset,
      confidence:
        transcript.length > 0
          ? transcript.reduce((sum, segment) => sum + (segment.confidence ?? 0), 0) /
            transcript.length
          : 0,
    },
  })
  await meetingRepository.replaceTranscriptSegments(meeting.id, transcript)
  await meetingRepository.updateMeetingStatus(meeting.id, "summarizing")
  await setStage(jobRecordId, {
    stage: "summary.generate",
    transcriptSegments: transcript.length,
  })

  const refreshed = await meetingRepository.getMeeting(meeting.id)
  const { intelligence, newActionItems } = await summarizeAndPersist({
    meeting,
    summaryInput: refreshed ?? { ...meeting, transcript },
    task: "summary.generate",
    jobRecordId,
    stageResult: { transcriptSegments: transcript.length },
  })

  await deliverPlatformEvent("summary.created", {
    meetingId: meeting.id,
    title: meeting.title,
    tags: intelligence.tags,
  })
  for (const item of newActionItems) {
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
    assetId: asset.id,
    transcriptSegments: transcript.length,
    tags: intelligence.tags,
  }
}

async function processIntelligenceOnlyJob(
  payload: MeetSumJobPayload,
  jobRecordId?: string
) {
  const meeting = await loadMeeting(requireMeetingId(payload))

  await meetingRepository.updateMeetingStatus(meeting.id, "summarizing")
  await setStage(jobRecordId, { stage: "summary.generate", mode: payload.mode })

  const cleanedTranscript = cleanupTranscriptSegments(meeting.transcript ?? [])
  if (cleanedTranscript.length) {
    await meetingRepository.replaceTranscriptSegments(meeting.id, cleanedTranscript)
  }

  const refreshed = await meetingRepository.getMeeting(meeting.id)
  const { intelligence, newActionItems } = await summarizeAndPersist({
    meeting,
    summaryInput: refreshed ?? { ...meeting, transcript: cleanedTranscript },
    task: String(payload.mode ?? "summary.generate"),
    jobRecordId,
    stageResult: { mode: payload.mode },
    metadata: { mode: payload.mode },
  })

  await deliverPlatformEvent("summary.created", {
    meetingId: meeting.id,
    title: meeting.title,
    mode: payload.mode,
    tags: intelligence.tags,
  })
  for (const item of newActionItems) {
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

/**
 * Search indexing is not implemented yet (M6). The job validates that there
 * is something to index and reports honestly instead of re-transcribing.
 */
async function processIndexJob(
  payload: MeetSumJobPayload,
  jobRecordId?: string
) {
  const meeting = await loadMeeting(requireMeetingId(payload))

  await setStage(jobRecordId, { stage: "meeting.index" })

  if (!meeting.transcript?.length) {
    throw new UnrecoverableError(
      `Meeting ${meeting.id} has no transcript to index yet.`
    )
  }

  return {
    meetingId: meeting.id,
    indexed: false,
    reason: "search indexing ships in M6",
  }
}

async function processArtifactImportJob(
  payload: MeetSumJobPayload,
  jobRecordId?: string
) {
  const { id: meetingId } = await loadMeeting(requireMeetingId(payload))

  await meetingRepository.updateMeetingStatus(meetingId, "transcribing")
  await setStage(jobRecordId, { stage: "artifact.import" })

  const artifactIds = Array.isArray(payload.artifactIds)
    ? payload.artifactIds.filter(
        (artifactId): artifactId is string => typeof artifactId === "string"
      )
    : undefined
  const subject = typeof payload.subject === "string" ? payload.subject : undefined
  let imported: Awaited<ReturnType<typeof importMeetTranscriptArtifactsForMeeting>>

  try {
    imported = await importMeetTranscriptArtifactsForMeeting({
      meetingId,
      subject,
      artifactIds,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    let recordingImport: Awaited<ReturnType<typeof importMeetRecordingArtifactsForMeeting>>

    try {
      recordingImport = await importMeetRecordingArtifactsForMeeting({
        meetingId,
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

    await setStage(jobRecordId, {
      stage: "drive.import",
      artifactIds: recordingImport.artifactIds,
      importedFiles: recordingImport.importedFiles,
      skippedFiles: recordingImport.skippedFiles,
      errors: recordingImport.errors,
    })

    return {
      meetingId,
      mode: "meet-recording-artifact",
      importedFiles: recordingImport.importedFiles,
      skippedFiles: recordingImport.skippedFiles,
      jobs: recordingImport.jobs,
      errors: recordingImport.errors,
    }
  }

  await meetingRepository.replaceTranscriptSegments(
    meetingId,
    imported.transcriptSegments
  )
  await setStage(jobRecordId, {
    stage: "summary.generate",
    importedEntries: imported.importedEntries,
    importedSmartNotes: imported.importedSmartNotes,
    artifactIds: imported.artifactIds,
  })

  return processIntelligenceOnlyJob(
    { ...payload, mode: "summary", source: "meet-artifact" },
    jobRecordId
  )
}

async function processGoogleJob(
  name: MeetSumJobName,
  payload: MeetSumJobPayload
) {
  const subject = resolveWorkspaceSubject({
    explicit: typeof payload.subject === "string" ? payload.subject : undefined,
  })

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

/**
 * webhook.deliver jobs carry their own state in webhook_deliveries, so they
 * bypass the jobs-table bookkeeping entirely.
 */
async function processWebhookJob(job: MeetSumJob) {
  if (typeof job.data.deliveryId === "string" && job.data.deliveryId) {
    return processWebhookDeliveryJob({
      deliveryId: job.data.deliveryId,
      attempt: job.attemptsMade + 1,
      maxAttempts: job.opts?.attempts ?? 1,
    })
  }

  return deliverWebhookEvent({
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

async function dispatchJob(
  job: MeetSumJob,
  jobRecordId: string
): Promise<Record<string, unknown>> {
  if (job.name === "media.ingest" || job.name === "meeting.transcribe") {
    return processMediaJob(job.data, jobRecordId)
  }
  if (job.name === "meeting.index") {
    return processIndexJob(job.data, jobRecordId)
  }
  if (job.name === "artifact.import") {
    return processArtifactImportJob(job.data, jobRecordId)
  }
  if (job.name === "meeting.summarize") {
    return job.data.mode === "full"
      ? processMediaJob(job.data, jobRecordId)
      : processIntelligenceOnlyJob(job.data, jobRecordId)
  }
  if (job.name.startsWith("google.")) {
    return processGoogleJob(job.name, job.data)
  }
  if (job.name === "realizeos.export") {
    return exportMeetingToRealizeOS({
      meetingId: job.data.meetingId,
      suggestionId:
        typeof job.data.suggestionId === "string" ? job.data.suggestionId : undefined,
      contextId:
        typeof job.data.contextId === "string" ? job.data.contextId : undefined,
    })
  }
  if (job.name === "teams.subscription.renew") {
    return renewTeamsSubscriptions()
  }

  return {}
}

export async function processJob(job: MeetSumJob) {
  if (job.name === "webhook.deliver") {
    return processWebhookJob(job)
  }

  const jobRecordId = await markActive(job)

  try {
    const result = await dispatchJob(job, jobRecordId)

    await completeJob(jobRecordId, result)
    return result
  } catch (error) {
    const attempts = job.attemptsMade + 1
    const maxAttempts = job.opts?.attempts ?? 1
    const permanent = error instanceof UnrecoverableError
    const isFinal = permanent || attempts >= maxAttempts
    const message = errorMessage(error)

    if (!isFinal) {
      // BullMQ will retry: keep the meeting's state and stay quiet.
      await meetingRepository
        .updateJob(jobRecordId, { status: "queued", error: message, attempts })
        .catch(() => {})
      throw error
    }

    await failJob(jobRecordId, error, attempts).catch(() => {})
    if (job.data.meetingId) {
      await meetingRepository
        .updateMeetingStatus(job.data.meetingId, "failed")
        .catch(() => {})
      await deliverPlatformEvent("meeting.process_failed", {
        meetingId: job.data.meetingId,
        jobId: jobRecordId,
        jobName: job.name,
        error: message,
        attempts,
        permanent,
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
