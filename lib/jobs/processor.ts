import { UnrecoverableError, Worker, type Job } from "bullmq"

import {
  AsrChainError,
  AsrError,
  transcribeWithRouter,
  type AsrAttempt,
  type AsrRouterResult,
} from "@/lib/ai/asr"
import {
  createSummaryProvider,
  getGeminiProviderMode,
  getSummaryRunMetadata,
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
  loadMeetTimelineForMeeting,
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
  MeetingVisibility,
  TranscriptSegment,
} from "@/lib/meetings/repository"
import { summarizeSpeakerStats } from "@/lib/meetings/speakers/stats"
import { refreshSpeakerSuggestions } from "@/lib/meetings/speakers/suggest"
import type { TranscriptWord } from "@/lib/meetings/transcript-words"
import { redactAsrErrorMessage } from "@/lib/ai/asr/errors"
import { getAsrGlossary } from "@/lib/settings/asr-glossary"
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

/**
 * Event fields that never reveal meeting content, kept for private meetings.
 * Everything else (title, tags, action item text/owner, error text) is
 * dropped: an admin registering a webhook must not read private meetings.
 */
const PRIVATE_EVENT_FIELDS = new Set([
  "meetingId",
  "actionItemId",
  "jobId",
  "jobName",
  "attempts",
  "permanent",
  "mode",
])

/**
 * Webhook payload for a meeting event: full data for workspace/link
 * meetings, a minimal `{ meetingId, workspace_id, visibility: "private", ... }`
 * payload for private ones (or when visibility cannot be determined).
 */
export function platformEventData(
  workspaceId: string,
  data: Record<string, unknown>,
  visibility: MeetingVisibility | undefined
): Record<string, unknown> {
  if (visibility === "workspace" || visibility === "link") return data

  return {
    ...Object.fromEntries(
      Object.entries(data).filter(([key]) => PRIVATE_EVENT_FIELDS.has(key))
    ),
    workspace_id: workspaceId,
    visibility: "private",
  }
}

async function meetingVisibility(
  scope: JobScope,
  meetingId: unknown
): Promise<MeetingVisibility | undefined> {
  if (typeof meetingId !== "string" || !meetingId) return undefined

  try {
    const meeting = await scope.repo.getMeeting(meetingId)

    return meeting ? (meeting.visibility ?? "workspace") : undefined
  } catch {
    return undefined
  }
}

async function deliverPlatformEvent(
  scope: JobScope,
  eventName: Parameters<typeof deliverWebhookEvent>[0]["eventName"],
  data: Record<string, unknown>
) {
  try {
    // Re-read the meeting so a visibility change made during processing is
    // honoured; an unknown visibility fails closed (minimal payload).
    const visibility = await meetingVisibility(scope, data.meetingId)

    await deliverWebhookEvent({
      eventName,
      data: platformEventData(scope.workspaceId, data, visibility),
      workspaceId: scope.workspaceId,
    })
  } catch {
    // Webhook delivery must never hide the primary processing result.
  }
}

async function recordAiRun(options: {
  id?: string
  meetingId: string
  workspaceId?: string
  task: string
  status: "completed" | "failed"
  startedAt: number
  /** Defaults to now − startedAt. */
  latencyMs?: number
  jobId?: string
  provider?: string
  model?: string
  confidence?: number
  costEstimate?: number
  audioDurationMs?: number
  metadata?: Record<string, unknown>
  error?: string
}) {
  if (process.env.MEETSUM_STORAGE !== "postgres") return

  const confidence =
    options.confidence ??
    (typeof options.metadata?.confidence === "number" ? options.metadata.confidence : undefined)

  try {
    await getDatabasePool().query(
      `
        insert into ai_runs (
          id, meeting_id, provider, task, status, metadata, model,
          latency_ms, confidence, started_at, completed_at, error, job_id,
          cost_estimate, audio_duration_ms, workspace_id
        )
        values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, now(), $11, $12, $13, $14, $15)
      `,
      [
        options.id ?? `airun_${crypto.randomUUID()}`,
        options.meetingId,
        options.provider ?? getGeminiProviderMode(),
        options.task,
        options.status,
        JSON.stringify(options.metadata ?? {}),
        options.model ?? null,
        Math.round(options.latencyMs ?? Date.now() - options.startedAt),
        confidence ?? null,
        new Date(options.startedAt).toISOString(),
        options.error ?? null,
        options.jobId ?? null,
        options.costEstimate ?? null,
        options.audioDurationMs === undefined ? null : Math.round(options.audioDurationMs),
        options.workspaceId ?? null,
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
      workspaceId: scope.workspaceId,
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
    workspaceId: scope.workspaceId,
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

/** Permanent ASR failures: retrying the same media can never succeed. */
function isPermanentAsrError(error: unknown): boolean {
  return (
    error instanceof TranscriptionUnavailableError ||
    (error instanceof AsrError && error.kind === "bad_input") ||
    (error instanceof AsrChainError && !error.retryable)
  )
}

/** One failed `audio.transcribe` ai_run per failed provider attempt. */
async function recordFailedAsrAttempts(
  scope: JobScope,
  options: {
    meetingId: string
    jobRecordId?: string
    attempts: AsrAttempt[]
    startedAt: number
    inputAsset: Record<string, unknown>
  }
) {
  for (const attempt of options.attempts) {
    if (attempt.ok) continue

    await recordAiRun({
      meetingId: options.meetingId,
      workspaceId: scope.workspaceId,
      task: "audio.transcribe",
      status: "failed",
      startedAt: options.startedAt,
      latencyMs: attempt.elapsedMs,
      jobId: options.jobRecordId,
      provider: attempt.provider,
      costEstimate: attempt.cost?.usd ?? undefined,
      metadata: {
        providerMode: attempt.provider,
        errorKind: attempt.kind,
        ...options.inputAsset,
      },
      error: attempt.error ?? "ASR attempt failed",
    })
  }
}

function toTranscriptSegments(result: AsrRouterResult): TranscriptSegment[] {
  return result.segments.map((segment) => {
    const converted: TranscriptSegment = {
      id: `seg_${crypto.randomUUID()}`,
      speaker: segment.speaker,
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
      turnIndex: segment.turnIndex,
      source: "asr",
      words: segment.words.map((word) => {
        const converted: TranscriptWord = {
          startMs: word.startMs,
          endMs: word.endMs,
          text: word.text,
        }

        if (word.confidence !== undefined) converted.confidence = word.confidence
        if (word.language) converted.language = word.language
        return converted
      }),
    }

    if (segment.confidence !== undefined) converted.confidence = segment.confidence
    if (segment.language) converted.language = segment.language
    return converted
  })
}

/** Segment confidence weighted by word count (segments without one skipped). */
export function wordWeightedConfidence(segments: readonly TranscriptSegment[]) {
  let total = 0
  let weight = 0

  for (const segment of segments) {
    if (typeof segment.confidence !== "number") continue

    const words = Math.max(1, segment.words?.length ?? 0)

    total += segment.confidence * words
    weight += words
  }

  return weight ? Number((total / weight).toFixed(4)) : undefined
}

/**
 * Best-effort Meet transcript timeline for speaker suggestions on meetings
 * with a Meet transcript artifact (Postgres + Google subject required).
 */
function meetTimelineLoader(
  scope: JobScope,
  meeting: MeetingRecord,
  payload: MeetSumJobPayload
) {
  const hasMeetTranscript = (meeting.meetConferenceRecords ?? []).some((record) =>
    record.artifacts.some((artifact) => artifact.artifactType === "transcript")
  )

  if (!hasMeetTranscript || process.env.MEETSUM_STORAGE !== "postgres") return undefined

  return async () => {
    const explicit =
      typeof payload.subject === "string" ? payload.subject.trim().toLowerCase() : ""
    const subject = explicit || (await loadWorkspaceGoogleSubject(scope.workspaceId))

    if (!subject) return undefined

    return loadMeetTimelineForMeeting({
      meetingId: meeting.id,
      workspaceId: scope.workspaceId,
      subject,
    })
  }
}

/** Suggestion refresh must never fail the pipeline. */
async function refreshSuggestionsSafely(
  scope: JobScope,
  meetingId: string,
  options: Parameters<typeof refreshSpeakerSuggestions>[2] = {}
) {
  try {
    return await refreshSpeakerSuggestions(scope.repo, meetingId, options)
  } catch (error) {
    console.warn("Speaker suggestion refresh failed", error)
    return 0
  }
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
  const glossary = await getAsrGlossary(scope.workspaceId)
  const transcriptionStartedAt = Date.now()
  let result: AsrRouterResult

  try {
    result = await transcribeWithRouter({
      meetingId: meeting.id,
      workspaceId: scope.workspaceId,
      language: meeting.language,
      media: {
        kind: "object",
        storageKey: asset.storageKey,
        contentType: asset.contentType,
        filename: asset.filename,
        sizeBytes: asset.sizeBytes,
      },
      glossary,
      diarize: true,
    })
  } catch (error) {
    const attempts = error instanceof AsrChainError ? error.attempts : []

    await recordFailedAsrAttempts(scope, {
      meetingId: meeting.id,
      jobRecordId,
      attempts,
      startedAt: transcriptionStartedAt,
      inputAsset,
    })
    if (!attempts.some((attempt) => !attempt.ok)) {
      await recordAiRun({
        meetingId: meeting.id,
        workspaceId: scope.workspaceId,
        task: "audio.transcribe",
        status: "failed",
        startedAt: transcriptionStartedAt,
        jobId: jobRecordId,
        provider: error instanceof AsrError ? error.provider : "asr-router",
        metadata: { providerMode: "asr-router", ...inputAsset },
        // Attempt errors are already redacted by the router; anything else
        // (bare provider errors) is redacted here before it is stored.
        error: redactAsrErrorMessage(errorMessage(error)),
      })
    }
    if (isPermanentAsrError(error)) throw toPermanentError(error)
    throw error
  }

  const elapsedMs = Date.now() - transcriptionStartedAt
  const failedAttempts = result.attempts.filter((attempt) => !attempt.ok)

  await recordFailedAsrAttempts(scope, {
    meetingId: meeting.id,
    jobRecordId,
    attempts: failedAttempts,
    startedAt: transcriptionStartedAt,
    inputAsset,
  })

  const transcript = cleanupTranscriptSegments(toTranscriptSegments(result), {
    rewriteTerms: false,
  })
  const wordCount = transcript.reduce(
    (sum, segment) => sum + (segment.words?.length ?? 0),
    0
  )
  const asrRunId = `airun_${crypto.randomUUID()}`
  const confidence = wordWeightedConfidence(transcript)
  const metadata = {
    providerMode: result.provider,
    attempts: result.attempts,
    fallbackUsed: result.fallbackUsed,
    attemptedProvider: failedAttempts[0]?.provider,
    fallbackReason: failedAttempts[0]?.error,
    language: result.language,
    diarization: result.diarization,
    speakerCount: new Set(transcript.map((segment) => segment.speaker)).size,
    wordCount,
    segmentCount: transcript.length,
    glossaryTerms: glossary.terms.length,
    glossaryReplacements: result.glossaryReplacements,
    timings: result.timings,
    rtf: result.durationMs > 0 ? Number((elapsedMs / result.durationMs).toFixed(4)) : null,
    billedSeconds: result.cost.billedSeconds,
    costBasis: result.cost.basis,
    warnings: result.warnings,
    ...inputAsset,
    confidence,
  }

  if (!transcript.length) {
    const noSpeech = new Error("No speech detected in the recording.")

    await recordAiRun({
      id: asrRunId,
      meetingId: meeting.id,
      workspaceId: scope.workspaceId,
      task: "audio.transcribe",
      status: "failed",
      startedAt: transcriptionStartedAt,
      jobId: jobRecordId,
      provider: result.provider,
      model: result.model,
      costEstimate: result.cost.usd ?? undefined,
      audioDurationMs: result.durationMs,
      metadata,
      error: noSpeech.message,
    })
    throw toPermanentError(noSpeech)
  }

  await recordAiRun({
    id: asrRunId,
    meetingId: meeting.id,
    workspaceId: scope.workspaceId,
    task: "audio.transcribe",
    status: "completed",
    startedAt: transcriptionStartedAt,
    jobId: jobRecordId,
    provider: result.provider,
    model: result.model,
    costEstimate: result.cost.usd ?? undefined,
    audioDurationMs: result.durationMs,
    confidence,
    metadata,
  })
  await scope.repo.replaceTranscript(meeting.id, {
    segments: transcript,
    speakers: result.speakers.map((speaker) => ({
      label: speaker.label,
      source: "asr",
      talkTimeMs: speaker.talkTimeMs,
      wordCount: speaker.wordCount,
      segmentCount: speaker.segmentCount,
      firstStartMs: speaker.firstStartMs,
      embedding: speaker.embedding,
      embeddingModel: speaker.embeddingModel,
    })),
    asrRunId,
  })

  const suggestedSpeakers = await refreshSuggestionsSafely(scope, meeting.id, {
    loadMeetTimeline: meetTimelineLoader(scope, meeting, payload),
  })

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
    asrProvider: result.provider,
    fallbackUsed: result.fallbackUsed,
    speakers: metadata.speakerCount,
    suggestedSpeakers,
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

  const transcript = meeting.transcript ?? []
  // Segments with word timings keep their text (the ASR glossary already
  // handled terms); only fillers/echoes are dropped.
  const cleanedTranscript = cleanupTranscriptSegments(transcript, {
    rewriteTerms: !transcript.some((segment) => segment.words?.length),
  })
  const changed =
    cleanedTranscript.length !== transcript.length ||
    cleanedTranscript.some((segment, index) => segment.text !== transcript[index]?.text)

  if (cleanedTranscript.length && changed) {
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

  // Meet transcripts name their speakers: segments/speakers are `meet`
  // sourced, so a re-import keeps confirmed mappings.
  const meetSegments = imported.transcriptSegments.map((segment) => ({
    ...segment,
    source: segment.source ?? "meet",
  }))

  await scope.repo.replaceTranscript(meetingId, {
    segments: meetSegments,
    speakers: summarizeSpeakerStats(meetSegments, "meet"),
  })
  await refreshSuggestionsSafely(scope, meetingId, { meetTimeline: imported.meetTimeline })
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

  const workspaceId = readJobWorkspaceId(job.data)

  // Legacy payloads without a workspace are dropped (fail closed).
  if (!workspaceId) {
    console.warn("[webhooks] webhook.deliver job without a workspace dropped")
    return { queued: 0, delivered: 0, failed: 0, skipped: true }
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
    workspaceId,
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
