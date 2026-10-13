import { UnrecoverableError } from "bullmq"

import { getBotConfig } from "@/lib/bot/config"
import { redactBotError } from "@/lib/bot/redact"
import { alignBotSpeakerTimeline } from "@/lib/bot/speaker-timeline"
import { getBotSessionStore, type BotSessionStore } from "@/lib/bot/store"
import type { BotSessionRecord } from "@/lib/bot/types"
import { getBotProvider } from "@/lib/bot/vexa/client"
import {
  VexaError,
  type BotProvider,
  type VexaMeeting,
  type VexaRecording,
  type VexaRecordingMedia,
} from "@/lib/bot/vexa/types"
import { classifyRecordingImportError } from "@/lib/capture/recording-import"
import {
  MEDIA_SIGNATURE_BYTES,
  UploadError,
  UploadTooLargeError,
  assertSupportedMedia,
  getUploadLimits,
} from "@/lib/capture/media-validation"
import { enqueueMeetSumJob } from "@/lib/jobs/queue"
import type { MediaAsset, MeetingRepository } from "@/lib/meetings/repository"
import { getSystemMeetingRepository } from "@/lib/meetings/store"
import { deleteMeetingObject, storeMeetingObjectStream } from "@/lib/storage/object-storage"

/**
 * Idempotent recording import after a bot session completes (M7 B4).
 *
 * The Vexa audio is streamed (never buffered whole) into OUR object storage
 * under a size cap with a SHA-256 checksum, recorded as an `original`
 * `meeting_bot` media asset, the meeting moves to `media_found`, and exactly
 * one `media.ingest` is enqueued with the workspace so the M3 ASR router
 * produces the final Hebrew transcript. Concurrent runs (duplicate webhooks,
 * reconcile) are serialized by a row-locked claim and a row-locked
 * check-and-set around the enqueue.
 */

export type BotFinalizeStorage = {
  storeStream(options: {
    keyPrefix: string
    filename: string
    contentType: string
    body: ReadableStream<Uint8Array>
    maxBytes: number
  }): Promise<{ key: string; sizeBytes: number; checksumSha256: string }>
  deleteObject(key: string): Promise<void>
}

export type FinalizeBotSessionInput = {
  sessionId: string
  workspaceId: string
  provider?: BotProvider
  /** Injected object storage for tests (defaults to lib/storage). */
  storage?: BotFinalizeStorage
  /** True on the last BullMQ attempt (missing recording -> `no_recording`). */
  finalAttempt?: boolean
  store?: BotSessionStore
  /** System meeting repository of the session's workspace (tests inject). */
  meetings?: MeetingRepository
  enqueueIngest?: typeof enqueueMeetSumJob
  maxBytes?: number
  now?: () => Date
}

export type FinalizeBotSessionResult =
  | { status: "imported"; assetId: string; ingestJobId: string }
  | { status: "skipped"; reason: "already_imported" | "meeting_deleted" }
  | { status: "missing" }

/** No recording yet: retry later (BullMQ backoff). */
export class BotRecordingPendingError extends Error {
  constructor() {
    super("bot recording not available yet")
    this.name = "BotRecordingPendingError"
  }
}

/** Another finalize run holds the import claim: retry later. */
export class BotFinalizeBusyError extends Error {
  constructor() {
    super("bot finalize already in progress")
    this.name = "BotFinalizeBusyError"
  }
}

/** An `importing` claim older than this is considered abandoned. */
const STALE_CLAIM_MS = 35 * 60_000

const EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "video/webm": "webm",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "video/mp4": "mp4",
  "audio/aac": "aac",
  "audio/flac": "flac",
}

function extensionFor(contentType: string): string {
  return EXTENSIONS[contentType.split(";")[0].trim().toLowerCase()] ?? "bin"
}

const defaultStorage: BotFinalizeStorage = {
  storeStream: (options) => storeMeetingObjectStream(options),
  deleteObject: (key) => deleteMeetingObject(key),
}

function isAudio(media: VexaRecordingMedia): boolean {
  const type = (media.type ?? "").toLowerCase()
  const contentType = (media.contentType ?? "").toLowerCase()

  return type === "audio" || contentType.startsWith("audio/")
}

type LocatedRecording = {
  recordingId: string
  mediaId: string
  contentType?: string
  durationMs?: number
  startedAt?: string
}

/** The audio recording of a Vexa meeting: `recordings[]`, else the master. */
export async function locateBotRecording(
  provider: BotProvider,
  meeting: VexaMeeting
): Promise<LocatedRecording | undefined> {
  const recordings: VexaRecording[] = meeting.recordings ?? []

  for (const recording of recordings) {
    const media = recording.media.find(isAudio) ?? recording.media[0]

    if (media) {
      return {
        recordingId: recording.id,
        mediaId: media.id,
        contentType: media.contentType,
        durationMs:
          media.durationSeconds !== undefined ? Math.round(media.durationSeconds * 1000) : undefined,
        startedAt: recording.startedAt,
      }
    }
  }

  const recording = recordings[0]

  if (!recording) return undefined

  const master = await provider.getRecordingMaster(recording.id, "audio")

  return master.mediaId
    ? { recordingId: recording.id, mediaId: master.mediaId, startedAt: recording.startedAt }
    : undefined
}

/** Reads the first `bytes` without consuming them from the returned stream. */
export async function peekStream(
  body: ReadableStream<Uint8Array>,
  bytes = MEDIA_SIGNATURE_BYTES
): Promise<{ head: Uint8Array; body: ReadableStream<Uint8Array> }> {
  const reader = body.getReader()
  const buffered: Uint8Array[] = []
  let length = 0
  let done = false

  while (length < bytes) {
    const chunk = await reader.read()

    if (chunk.done) {
      done = true
      break
    }

    buffered.push(chunk.value)
    length += chunk.value.byteLength
  }

  const head = new Uint8Array(Buffer.concat(buffered.map((chunk) => Buffer.from(chunk))).subarray(0, bytes))
  let index = 0

  return {
    head,
    body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (index < buffered.length) {
          controller.enqueue(buffered[index])
          index += 1
          return
        }
        if (done) {
          controller.close()
          return
        }

        const chunk = await reader.read()

        if (chunk.done) controller.close()
        else controller.enqueue(chunk.value)
      },
      cancel(reason) {
        return reader.cancel(reason)
      },
    }),
  }
}

/** BullMQ classification: permanent failures never retry. */
export function classifyFinalizeError(error: unknown): Error {
  if (error instanceof BotRecordingPendingError || error instanceof BotFinalizeBusyError) {
    return error
  }
  if (error instanceof VexaError) {
    return error.retryable ? error : new UnrecoverableError(redactBotError(error))
  }
  if (error instanceof UploadError && !(error instanceof UploadTooLargeError)) {
    return new UnrecoverableError(error.message)
  }

  return classifyRecordingImportError(error)
}

export async function finalizeBotSession(
  input: FinalizeBotSessionInput
): Promise<FinalizeBotSessionResult> {
  const store = input.store ?? getBotSessionStore()
  const scope = { workspaceId: input.workspaceId }
  const now = input.now ?? (() => new Date())
  const session = await store.get(input.sessionId, scope)

  if (!session) throw new UnrecoverableError("bot session not found")
  if (session.recordingStatus === "imported" && session.ingestJobId) {
    return { status: "skipped", reason: "already_imported" }
  }

  const meetings = input.meetings ?? getSystemMeetingRepository(input.workspaceId)
  const meeting = session.meetingId
    ? await meetings.getMeeting(session.meetingId, { includeTranscript: false })
    : undefined

  if (!session.meetingId || !meeting) {
    await store.update(
      session.id,
      { recordingStatus: "missing", statusReason: "meeting_deleted" },
      scope
    )
    return { status: "skipped", reason: "meeting_deleted" }
  }

  const claim = await store.withTransaction(async (tx) => {
    const locked = await store.getForUpdate(session.id, tx, scope)

    if (!locked) return "gone" as const
    if (locked.recordingStatus === "imported" && locked.ingestJobId) return "done" as const
    if (
      locked.recordingStatus === "importing" &&
      now().getTime() - Date.parse(locked.updatedAt) < STALE_CLAIM_MS
    ) {
      return "busy" as const
    }

    await store.update(session.id, { recordingStatus: "importing" }, { ...scope, tx })
    return "claimed" as const
  })

  if (claim === "gone") throw new UnrecoverableError("bot session not found")
  if (claim === "done") return { status: "skipped", reason: "already_imported" }
  if (claim === "busy") throw new BotFinalizeBusyError()

  try {
    return await importAndEnqueue({ ...input, store, meetings, now }, session)
  } catch (error) {
    const classified = classifyFinalizeError(error)
    const permanent = classified instanceof UnrecoverableError

    await store
      .update(
        session.id,
        error instanceof BotRecordingPendingError
          ? { recordingStatus: "pending" }
          : {
              recordingStatus: permanent || input.finalAttempt ? "failed" : "pending",
              error: redactBotError(error),
            },
        scope
      )
      .catch(() => undefined)

    throw classified
  }
}

async function importAndEnqueue(
  input: FinalizeBotSessionInput & {
    store: BotSessionStore
    meetings: MeetingRepository
    now: () => Date
  },
  session: BotSessionRecord
): Promise<FinalizeBotSessionResult> {
  const { store, meetings } = input
  const scope = { workspaceId: input.workspaceId }
  const meetingId = session.meetingId as string
  const provider = input.provider ?? getBotProvider()
  const vexaMeeting = session.vexaMeetingId
    ? await provider.getMeeting(session.vexaMeetingId)
    : undefined
  const located = vexaMeeting ? await locateBotRecording(provider, vexaMeeting) : undefined

  if (!located) {
    if (input.finalAttempt || !session.vexaMeetingId) {
      await store.update(
        session.id,
        { recordingStatus: "missing", statusReason: "no_recording" },
        scope
      )
      return { status: "missing" }
    }

    throw new BotRecordingPendingError()
  }

  const sourceFileId = `vexa:${located.recordingId}:${located.mediaId}`
  const asset =
    (await meetings.findMediaAssetBySourceFile?.("meeting_bot", sourceFileId, { meetingId })) ??
    (await importRecording(input, session, located, sourceFileId))

  let speakerTimeline: unknown

  if (session.transcribeEnabled && session.vexaMeetingId) {
    // Non-fatal: the timeline is only a speaker-suggestion signal.
    speakerTimeline = await provider
      .getTranscript(session.vexaMeetingId)
      .then((transcript) =>
        alignBotSpeakerTimeline(
          transcript.segments,
          {
            recordingStartedAt: located.startedAt,
            recordingDurationMs: located.durationMs ?? asset.durationMs,
            sessionStartedAt: session.joinedAt,
            sessionEndedAt: session.leftAt,
          },
          { botName: session.botName, botEmail: getBotConfig().accountEmail }
        )
      )
      .catch(() => undefined)
  }

  const enqueueIngest = input.enqueueIngest ?? enqueueMeetSumJob

  return store.withTransaction(async (tx) => {
    const locked = await store.getForUpdate(session.id, tx, scope)

    if (locked?.ingestJobId) {
      return { status: "imported" as const, assetId: asset.id, ingestJobId: locked.ingestJobId }
    }

    const job = await enqueueIngest(
      "media.ingest",
      {
        meetingId,
        workspaceId: input.workspaceId,
        assetId: asset.id,
        source: "meeting_bot",
        botSessionId: session.id,
      },
      { jobId: `media.ingest:bot:${session.id}` }
    )
    const ingestJobId = String((job as { id?: unknown } | undefined)?.id ?? `media.ingest:bot:${session.id}`)

    await store.update(
      session.id,
      {
        recordingStatus: "imported",
        ingestJobId,
        mediaAssetId: asset.id,
        recordingStorageKey: asset.storageKey,
        error: null,
        ...(speakerTimeline ? { speakerTimeline } : {}),
      },
      { ...scope, tx }
    )

    return { status: "imported" as const, assetId: asset.id, ingestJobId }
  })
}

async function importRecording(
  input: FinalizeBotSessionInput & { meetings: MeetingRepository },
  session: BotSessionRecord,
  located: LocatedRecording,
  sourceFileId: string
): Promise<MediaAsset> {
  const { meetings } = input
  const meetingId = session.meetingId as string
  const provider = input.provider ?? getBotProvider()
  const storage = input.storage ?? defaultStorage
  const maxBytes = input.maxBytes ?? getUploadLimits().maxRecordingBytes
  let storedKey: string | undefined

  try {
    const media = await provider.streamRecordingMedia(located.recordingId, located.mediaId)

    if (media.contentLength !== undefined && media.contentLength > maxBytes) {
      await media.body.cancel().catch(() => undefined)
      throw new UploadTooLargeError(maxBytes)
    }

    const peeked = await peekStream(media.body)
    let contentType: string

    try {
      contentType = assertSupportedMedia(
        media.contentType ?? located.contentType ?? "application/octet-stream",
        peeked.head
      )
    } catch (error) {
      await peeked.body.cancel().catch(() => undefined)
      throw error
    }

    const filename = `bot-${session.id}.${extensionFor(contentType)}`
    const stored = await storage.storeStream({
      keyPrefix: `meetings/${meetingId}`,
      filename,
      contentType,
      body: peeked.body,
      maxBytes,
    })

    storedKey = stored.key

    const current = await meetings.getMeeting(meetingId, { includeTranscript: false })

    if (current && (current.status === "scheduled" || current.status === "created")) {
      await meetings.updateMeetingStatus(meetingId, "media_found")
    }

    return await meetings.createMediaAsset({
      meetingId,
      storageKey: stored.key,
      filename,
      contentType,
      sizeBytes: stored.sizeBytes,
      retention: "audio",
      source: "meeting_bot",
      sourceFileId,
      checksumSha256: stored.checksumSha256,
      kind: "original",
      durationMs: located.durationMs,
      metadata: {
        vexaMeetingId: session.vexaMeetingId,
        platform: session.platform,
        botSessionId: session.id,
      },
    })
  } catch (error) {
    if (storedKey) await storage.deleteObject(storedKey).catch(() => undefined)
    throw error
  }
}
