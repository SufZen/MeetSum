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
import { getCaptureWorkspaceId } from "@/lib/capture/workspace"
import { getDatabasePool } from "@/lib/db/client"
import {
  importMeetRecordingArtifactsForMeeting,
  importMeetTranscriptArtifactsForMeeting,
  syncMeetArtifacts,
} from "@/lib/google/meet-artifacts"
import { pollCalendar, pollDrive, pollGmail } from "@/lib/google/services"
import {
  GoogleNotConfiguredError,
  loadWorkspaceGoogleSubject,
} from "@/lib/google/workspace-subject"
import { cleanupTranscriptSegments, type MeetingIntelligence } from "@/lib/intelligence"
import { exportMeetingToRealizeOS } from "@/lib/integrations/realizeos"
import type {
  MediaAsset,
  MeetingRecord,
  MeetingRepository,
} from "@/lib/meetings/repository"
import {
  getSystemMeetingRepository,
  resolveMeetingWorkspaceId,
} from "@/lib/meetings/store"
import { applyMediaRetention } from "@/lib/storage/retention"
import {
  deliverWebhookEvent,
  processWebhookDeliveryJob,
} from "@/lib/webhooks/delivery"
import type { MeetSumJobName, MeetSumJobPayload } from "@/lib/jobs/queue"

export type MeetSumJob = Job<MeetSumJobPayload, unknown, MeetSumJobName>

/**
 * Everything a job touches is scoped to one workspace: its jobs row, its
 * meeting (through the workspace's system repository), its webhooks and its
 * Google identity.
 */
type JobScope = {
  workspaceId: string
  repo: MeetingRepository
}

function readJobWorkspaceId(payload: MeetSumJobPayload) {
  return typeof payload.workspaceId === "string" && payload.workspaceId.trim()
    ? payload.workspaceId.trim()
    : undefined
}

async function workspaceOfJobRow(jobRecordId: unknown): Promise<string | undefined> {
  if (process.env.MEETSUM_STORAGE !== "postgres") return undefined
  if (typeof jobRecordId !== "string" || !jobRecordId) return undefined

  const result = await getDatabasePool().query(
    `select workspace_id from jobs where id = $1 limit 1`,
    [jobRecordId]
  )

  return (result.rows[0] as { workspace_id?: string | null } | undefined)
    ?.workspace_id ?? undefined
}

/**
 * Workspace a job runs in: payload.workspaceId → the meeting's workspace →
 * (Teams renewal) the capture workspace → the persisted jobs row (jobs
 * enqueued before M2) → otherwise a permanent failure. Never a default.
 */
export async function resolveJobWorkspaceId(job: MeetSumJob): Promise<string> {
  const fromPayload = readJobWorkspaceId(job.data)

  if (fromPayload) return fromPayload

  if (job.data.meetingId) {
    const fromMeeting = await resolveMeetingWorkspaceId(job.data.meetingId)

    if (fromMeeting) return fromMeeting
  }

  if (job.name === "teams.subscription.renew") return getCaptureWorkspaceId()

  const fromRow = await workspaceOfJobRow(job.data.jobRecordId).catch(() => undefined)

  if (fromRow) return fromRow

  throw new UnrecoverableError(
    `Cannot resolve the workspace of ${job.name} job ${String(job.id)}`
  )
}

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

async function loadMeeting(scope: JobScope, meetingId: string): Promise<MeetingRecord> {
  const meeting = await scope.repo.getMeeting(meetingId)

  if (!meeting) {
    throw toPermanentError(new Error(`Meeting not found: ${meetingId}`))
  }

  return meeting
}

async function markActive(scope: JobScope, job: MeetSumJob) {
  const jobRecordId = String(job.data.jobRecordId ?? job.id)

  await scope.repo.updateJob(jobRecordId, {
    status: "active",
    attempts: job.attemptsMade + 1,
  })

  return jobRecordId
}

async function completeJob(
  scope: JobScope,
  jobRecordId: string,
  result: Record<string, unknown> = {}
) {
  await scope.repo.updateJob(jobRecordId, {
    status: "completed",
    result,
  })
}

async function failJob(
  scope: JobScope,
  jobRecordId: string,
  error: unknown,
  attempts: number
) {
  await scope.repo.updateJob(jobRecordId, {
    status: "failed",
    error: errorMessage(error),
    attempts,
  })
}

async function setStage(
  scope: JobScope,
  jobRecordId: string | undefined,
  result: Record<string, unknown>
) {
  if (!jobRecordId) return

  await scope.repo.updateJob(jobRecordId, { result })
}

async function deliverPlatformEvent(
  scope: JobScope,
  eventName: Parameters<typeof deliverWebhookEvent>[0]["eventName"],
  data: Record<string, unknown>
) {
  try {
    await deliverWebhookEvent({ eventName, data, workspaceId: scope.workspaceId })
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
  scope: JobScope,
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

  await setStage(scope, jobRecordId, {
    stage: "recording.download",
    platform: platformImport.platform,
  })

  const imported = await importPlatformRecording({
    meetingId: meeting.id,
    workspaceId: scope.workspaceId,
    platform: platformImport.platform,
    captureEvent: platformImport.captureEvent,
  })
  const refreshed = await loadMeeting(scope, meeting.id)
  const asset = selectMediaAsset(refreshed, { assetId: imported.assetId })

  if (!asset) throw new UnrecoverableError(NO_RECORDING_MESSAGE)

  return { meeting: refreshed, asset }
}

async function summarizeAndPersist(scope: JobScope, options: {
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

  await scope.repo.updateMeetingStatus(meeting.id, "indexing")
  await setStage(scope, jobRecordId, { stage: "meeting.index", ...options.stageResult })

  const persisted = await scope.repo.upsertMeetingIntelligence(
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
  scope: JobScope,
  payload: MeetSumJobPayload,
  jobRecordId?: string
) {
  const meetingId = requireMeetingId(payload)
  const { meeting, asset } = await resolveRecording(
    scope,
    await loadMeeting(scope, meetingId),
    payload,
    jobRecordId
  )

  await scope.repo.updateMeetingStatus(meeting.id, "transcribing")
  await setStage(scope, jobRecordId, { stage: "audio.transcribe", assetId: asset.id })

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
  await scope.repo.replaceTranscriptSegments(meeting.id, transcript)
  await scope.repo.updateMeetingStatus(meeting.id, "summarizing")
  await setStage(scope, jobRecordId, {
    stage: "summary.generate",
    transcriptSegments: transcript.length,
  })

  const refreshed = await scope.repo.getMeeting(meeting.id)
  const { intelligence, newActionItems } = await summarizeAndPersist(scope, {
    meeting,
    summaryInput: refreshed ?? { ...meeting, transcript },
    task: "summary.generate",
    jobRecordId,
    stageResult: { transcriptSegments: transcript.length },
  })

  await deliverPlatformEvent(scope, "summary.created", {
    meetingId: meeting.id,
    title: meeting.title,
    tags: intelligence.tags,
  })
  for (const item of newActionItems) {
    await deliverPlatformEvent(scope, "action_item.created", {
      meetingId: meeting.id,
      actionItemId: item.id,
      title: item.title,
      owner: item.owner,
      priority: item.priority,
    })
  }
  await deliverPlatformEvent(scope, "meeting.completed", {
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
  scope: JobScope,
  payload: MeetSumJobPayload,
  jobRecordId?: string
) {
  const meeting = await loadMeeting(scope, requireMeetingId(payload))

  await scope.repo.updateMeetingStatus(meeting.id, "summarizing")
  await setStage(scope, jobRecordId, { stage: "summary.generate", mode: payload.mode })

  const cleanedTranscript = cleanupTranscriptSegments(meeting.transcript ?? [])
  if (cleanedTranscript.length) {
    await scope.repo.replaceTranscriptSegments(meeting.id, cleanedTranscript)
  }

  const refreshed = await scope.repo.getMeeting(meeting.id)
  const { intelligence, newActionItems } = await summarizeAndPersist(scope, {
    meeting,
    summaryInput: refreshed ?? { ...meeting, transcript: cleanedTranscript },
    task: String(payload.mode ?? "summary.generate"),
    jobRecordId,
    stageResult: { mode: payload.mode },
    metadata: { mode: payload.mode },
  })

  await deliverPlatformEvent(scope, "summary.created", {
    meetingId: meeting.id,
    title: meeting.title,
    mode: payload.mode,
    tags: intelligence.tags,
  })
  for (const item of newActionItems) {
    await deliverPlatformEvent(scope, "action_item.created", {
      meetingId: meeting.id,
      actionItemId: item.id,
      title: item.title,
      owner: item.owner,
      priority: item.priority,
    })
  }
  await deliverPlatformEvent(scope, "meeting.completed", {
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
  scope: JobScope,
  payload: MeetSumJobPayload,
  jobRecordId?: string
) {
  const meeting = await loadMeeting(scope, requireMeetingId(payload))

  await setStage(scope, jobRecordId, { stage: "meeting.index" })

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
  scope: JobScope,
  payload: MeetSumJobPayload,
  jobRecordId?: string
) {
  const { id: meetingId } = await loadMeeting(scope, requireMeetingId(payload))

  await scope.repo.updateMeetingStatus(meetingId, "transcribing")
  await setStage(scope, jobRecordId, { stage: "artifact.import" })

  const artifactIds = Array.isArray(payload.artifactIds)
    ? payload.artifactIds.filter(
        (artifactId): artifactId is string => typeof artifactId === "string"
      )
    : undefined
  const subject = await resolveJobGoogleSubject(scope, payload)
  let imported: Awaited<ReturnType<typeof importMeetTranscriptArtifactsForMeeting>>

  try {
    imported = await importMeetTranscriptArtifactsForMeeting({
      meetingId,
      workspaceId: scope.workspaceId,
      subject,
      artifactIds,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    let recordingImport: Awaited<ReturnType<typeof importMeetRecordingArtifactsForMeeting>>

    try {
      recordingImport = await importMeetRecordingArtifactsForMeeting({
        meetingId,
        workspaceId: scope.workspaceId,
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

    await setStage(scope, jobRecordId, {
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

  await scope.repo.replaceTranscriptSegments(
    meetingId,
    imported.transcriptSegments
  )
  await setStage(scope, jobRecordId, {
    stage: "summary.generate",
    importedEntries: imported.importedEntries,
    importedSmartNotes: imported.importedSmartNotes,
    artifactIds: imported.artifactIds,
  })

  return processIntelligenceOnlyJob(
    scope,
    { ...payload, mode: "summary", source: "meet-artifact" },
    jobRecordId
  )
}

/**
 * Google identity of a job: the subject the enqueuing (server-side) code put
 * in the payload — routes only ever pass the workspace subject or the user's
 * own mailbox — else the workspace's `google_subject`. No env fallback for
 * other workspaces; nothing configured is a permanent failure.
 */
async function resolveJobGoogleSubject(
  scope: JobScope,
  payload: MeetSumJobPayload
): Promise<string> {
  const explicit =
    typeof payload.subject === "string" ? payload.subject.trim().toLowerCase() : ""

  if (explicit) return explicit

  const subject = await loadWorkspaceGoogleSubject(scope.workspaceId)

  if (!subject) {
    throw toPermanentError(new GoogleNotConfiguredError(scope.workspaceId))
  }

  return subject
}

async function processGoogleJob(
  scope: JobScope,
  name: MeetSumJobName,
  payload: MeetSumJobPayload
) {
  const target = {
    subject: await resolveJobGoogleSubject(scope, payload),
    workspaceId: scope.workspaceId,
  }

  if (name === "google.calendar.poll") {
    return pollCalendar(target)
  }

  if (name === "google.drive.poll") {
    return pollDrive(target)
  }

  if (name === "google.gmail.poll") {
    return pollGmail(target)
  }

  if (name === "google.meet.poll") {
    return syncMeetArtifacts({
      ...target,
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
    // Legacy payloads without a workspace are dropped by the fan-out.
    workspaceId: readJobWorkspaceId(job.data),
  })
}

async function dispatchJob(
  scope: JobScope,
  job: MeetSumJob,
  jobRecordId: string
): Promise<Record<string, unknown>> {
  if (job.name === "media.ingest" || job.name === "meeting.transcribe") {
    return processMediaJob(scope, job.data, jobRecordId)
  }
  if (job.name === "meeting.index") {
    return processIndexJob(scope, job.data, jobRecordId)
  }
  if (job.name === "artifact.import") {
    return processArtifactImportJob(scope, job.data, jobRecordId)
  }
  if (job.name === "meeting.summarize") {
    return job.data.mode === "full"
      ? processMediaJob(scope, job.data, jobRecordId)
      : processIntelligenceOnlyJob(scope, job.data, jobRecordId)
  }
  if (job.name.startsWith("google.")) {
    return processGoogleJob(scope, job.name, job.data)
  }
  if (job.name === "realizeos.export") {
    return exportMeetingToRealizeOS({
      meetingId: job.data.meetingId,
      workspaceId: scope.workspaceId,
      suggestionId:
        typeof job.data.suggestionId === "string" ? job.data.suggestionId : undefined,
      contextId:
        typeof job.data.contextId === "string" ? job.data.contextId : undefined,
    })
  }
  if (job.name === "teams.subscription.renew") {
    return renewTeamsSubscriptions()
  }
  if (job.name === "media.retention") {
    return applyMediaRetention({ workspaceId: scope.workspaceId, execute: true })
  }

  return {}
}

export async function processJob(job: MeetSumJob) {
  if (job.name === "webhook.deliver") {
    return processWebhookJob(job)
  }

  const workspaceId = await resolveJobWorkspaceId(job)
  const scope: JobScope = {
    workspaceId,
    repo: getSystemMeetingRepository(workspaceId),
  }
  const jobRecordId = await markActive(scope, job)

  try {
    const result = await dispatchJob(scope, job, jobRecordId)

    await completeJob(scope, jobRecordId, result)
    return result
  } catch (error) {
    const attempts = job.attemptsMade + 1
    const maxAttempts = job.opts?.attempts ?? 1
    const permanent = error instanceof UnrecoverableError
    const isFinal = permanent || attempts >= maxAttempts
    const message = errorMessage(error)

    if (!isFinal) {
      // BullMQ will retry: keep the meeting's state and stay quiet.
      await scope.repo
        .updateJob(jobRecordId, { status: "queued", error: message, attempts })
        .catch(() => {})
      throw error
    }

    await failJob(scope, jobRecordId, error, attempts).catch(() => {})
    // Only processing jobs own the meeting's status. A failed export or
    // index run must not flip an already processed meeting to "failed".
    if (job.data.meetingId && MEETING_PROCESSING_JOBS.has(job.name)) {
      await scope.repo
        .updateMeetingStatus(job.data.meetingId, "failed")
        .catch(() => {})
      await deliverPlatformEvent(scope, "meeting.process_failed", {
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

const MEETING_PROCESSING_JOBS: ReadonlySet<MeetSumJobName> = new Set([
  "media.ingest",
  "artifact.import",
  "meeting.transcribe",
  "meeting.summarize",
])

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
