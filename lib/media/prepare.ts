import { createReadStream } from "node:fs"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import type { MediaAsset, MeetingRepository } from "@/lib/meetings/repository"
import {
  extractPeaksPcm,
  probeMediaDurationMs,
  transcodePlaybackAudio,
  type ExecFileFn,
  type MediaEnv,
} from "@/lib/media/ffmpeg"
import {
  buildPeaksFile,
  computeSamplesPerPeak,
  DEFAULT_PEAKS_MAX_POINTS,
  DEFAULT_PEAKS_SAMPLE_RATE,
  PeaksAccumulator,
} from "@/lib/media/peaks-accumulator"
import { baseContentType } from "@/lib/media/playback-select"
import type {
  DeleteMeetingObjectsResult,
  StoredObject,
} from "@/lib/storage/object-storage"

/**
 * `media.prepare` (M4 Package A): for one original asset, probe its
 * duration, compute waveform peaks and (per policy) a browser-friendly
 * AAC-LC mono playback rendition. Never touches the meeting status; the
 * temp dir is always removed.
 */

export type PrepareRepository = Pick<
  MeetingRepository,
  "getMeeting" | "createMediaAsset" | "updateMediaAssetPreparation" | "setMeetingDurationMs"
>

export type PrepareStorage = {
  download: (key: string, destination: string) => Promise<void>
  putJson: (key: string, value: unknown) => Promise<unknown>
  storeFile: (options: {
    keyPrefix: string
    filename: string
    path: string
    contentType: string
  }) => Promise<StoredObject & { checksumSha256?: string }>
  deleteObjects: (keys: readonly string[]) => Promise<DeleteMeetingObjectsResult>
  /** Removes superseded playback rows (objects are deleted separately). */
  deleteAssetRows?: (workspaceId: string | undefined, assetIds: string[]) => Promise<void>
}

export type PlaybackOutcome = "transcoded" | "passthrough" | "none"

export type PrepareMediaResult = {
  status: "prepared" | "skipped"
  assetId: string
  durationMs?: number
  peaksStorageKey?: string
  playback: PlaybackOutcome
  playbackAssetId?: string
}

/** The meeting or asset cannot be prepared and never will be (no retry). */
export class MediaPreparePermanentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MediaPreparePermanentError"
  }
}

export const DEFAULT_PLAYBACK_PASSTHROUGH_MAX_BYTES = 100 * 1024 * 1024

/** Originals the browser plays well enough to skip a rendition (auto). */
const PASSTHROUGH_TYPES = new Set(["audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/aac"])

function envInt(env: MediaEnv, name: string, fallback: number) {
  const parsed = Number(env[name])

  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

/**
 * Playback policy (`MEETSUM_PLAYBACK_TRANSCODE=auto|always|never`): `auto`
 * passes small mp3/m4a/aac originals through and transcodes the rest.
 */
export function playbackDecision(
  asset: Pick<MediaAsset, "contentType" | "sizeBytes">,
  env: MediaEnv = process.env
): PlaybackOutcome {
  const mode = (env.MEETSUM_PLAYBACK_TRANSCODE ?? "auto").trim().toLowerCase()

  if (mode === "never") return "none"
  if (mode === "always") return "transcoded"

  const maxBytes = envInt(
    env,
    "MEETSUM_PLAYBACK_PASSTHROUGH_MAX_BYTES",
    DEFAULT_PLAYBACK_PASSTHROUGH_MAX_BYTES
  )

  return PASSTHROUGH_TYPES.has(baseContentType(asset.contentType)) && asset.sizeBytes <= maxBytes
    ? "passthrough"
    : "transcoded"
}

/** `<original-key-dir>/derived` (keys without a dir use `derived`). */
export function derivedKeyPrefix(storageKey: string): string {
  const slash = storageKey.lastIndexOf("/")

  return slash > 0 ? `${storageKey.slice(0, slash)}/derived` : "derived"
}

export function peaksStorageKeyFor(asset: Pick<MediaAsset, "id" | "storageKey">): string {
  return `${derivedKeyPrefix(asset.storageKey)}/${asset.id}.peaks.v1.json`
}

/** Plain lower-case extension of the uploaded name, else "" (never a path). */
function safeExtension(filename: string | undefined): string {
  const ext = path.extname(filename ?? "").toLowerCase()

  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : ""
}

async function defaultStorage(): Promise<PrepareStorage> {
  const storage = await import("@/lib/storage/object-storage")
  const { deletePlaybackAssetRows } = await import("@/lib/storage/media-assets")

  return {
    download: storage.downloadMeetingObjectToFile,
    putJson: storage.putMeetingObjectJson,
    storeFile: storage.storeMeetingObjectFile,
    deleteObjects: (keys) => storage.deleteMeetingObjects(keys),
    deleteAssetRows: deletePlaybackAssetRows,
  }
}

async function computePeaks(
  pcmPath: string,
  env: MediaEnv
): Promise<{ peaks: number[]; totalSamples: number; samplesPerPeak: number; sampleRate: number }> {
  const sampleRate = envInt(env, "MEETSUM_PEAKS_SAMPLE_RATE", DEFAULT_PEAKS_SAMPLE_RATE)
  const maxPoints = envInt(env, "MEETSUM_PEAKS_MAX_POINTS", DEFAULT_PEAKS_MAX_POINTS)
  const { size } = await stat(pcmPath)
  const samplesPerPeak = computeSamplesPerPeak(Math.floor(size / 2), maxPoints)
  const accumulator = new PeaksAccumulator({ samplesPerPeak })

  for await (const chunk of createReadStream(pcmPath)) {
    accumulator.push(chunk as Buffer)
  }

  const { peaks, totalSamples } = accumulator.finish()

  return { peaks, totalSamples, samplesPerPeak, sampleRate }
}

export async function prepareMediaAsset(options: {
  meetingId: string
  assetId: string
  repo: PrepareRepository
  env?: MediaEnv
  exec?: ExecFileFn
  storage?: PrepareStorage
  /** Re-run even when the asset is already prepared. */
  force?: boolean
  /** Parent of the per-run temp dir (default: OS temp). */
  tmpRoot?: string
  now?: () => Date
}): Promise<PrepareMediaResult> {
  const env = options.env ?? process.env
  const meeting = await options.repo.getMeeting(options.meetingId, { includeTranscript: false })

  if (!meeting) {
    throw new MediaPreparePermanentError(`Meeting not found: ${options.meetingId}`)
  }

  const assets = meeting.mediaAssets ?? []
  const asset = assets.find((candidate) => candidate.id === options.assetId)

  if (!asset?.storageKey || (asset.kind ?? "original") !== "original") {
    throw new MediaPreparePermanentError(
      `Original media asset ${options.assetId} not found for meeting ${meeting.id}`
    )
  }

  const decision = playbackDecision(asset, env)
  const previousPlayback = assets.filter(
    (candidate) => candidate.kind === "playback" && candidate.derivedFromAssetId === asset.id
  )

  if (
    !options.force &&
    asset.preparedAt &&
    asset.peaksStorageKey &&
    (decision !== "transcoded" || previousPlayback.length > 0)
  ) {
    return {
      status: "skipped",
      assetId: asset.id,
      durationMs: asset.durationMs,
      peaksStorageKey: asset.peaksStorageKey,
      playback: decision,
      playbackAssetId: previousPlayback[0]?.id,
    }
  }

  const storage = options.storage ?? (await defaultStorage())
  const dir = await mkdtemp(path.join(options.tmpRoot ?? tmpdir(), "meetsum-prepare-"))

  try {
    const input = path.join(dir, `source${safeExtension(asset.filename)}`)
    const pcm = path.join(dir, "peaks.pcm")

    await storage.download(asset.storageKey, input)

    const probedMs = await probeMediaDurationMs(input, { exec: options.exec, env })
    const sampleRate = envInt(env, "MEETSUM_PEAKS_SAMPLE_RATE", DEFAULT_PEAKS_SAMPLE_RATE)

    await extractPeaksPcm(input, pcm, sampleRate, { exec: options.exec, env })

    const peaks = await computePeaks(pcm, env)
    const durationMs =
      probedMs ??
      (peaks.totalSamples > 0
        ? Math.round((peaks.totalSamples / peaks.sampleRate) * 1000)
        : undefined)
    const peaksStorageKey = peaksStorageKeyFor(asset)

    await storage.putJson(
      peaksStorageKey,
      buildPeaksFile({
        peaks: peaks.peaks,
        sampleRate: peaks.sampleRate,
        samplesPerPeak: peaks.samplesPerPeak,
        durationMs: durationMs ?? 0,
      })
    )

    let playbackAssetId: string | undefined

    if (decision === "transcoded") {
      const output = path.join(dir, "playback.m4a")

      await transcodePlaybackAudio(input, output, { exec: options.exec, env })

      const stored = await storage.storeFile({
        keyPrefix: derivedKeyPrefix(asset.storageKey),
        filename: `${asset.id}.playback.m4a`,
        path: output,
        contentType: "audio/mp4",
      })
      const playback = await options.repo.createMediaAsset({
        meetingId: meeting.id,
        storageKey: stored.key,
        filename: `${asset.id}.playback.m4a`,
        contentType: "audio/mp4",
        sizeBytes: stored.sizeBytes,
        retention: "audio",
        source: "media.prepare",
        checksumSha256: stored.checksumSha256,
        kind: "playback",
        derivedFromAssetId: asset.id,
        durationMs,
      })

      playbackAssetId = playback.id
    }

    // Older renditions of this original are superseded (or, with
    // passthrough/never, no longer wanted).
    const superseded = previousPlayback.filter((candidate) => candidate.id !== playbackAssetId)

    if (superseded.length) {
      await storage.deleteAssetRows?.(
        meeting.workspaceId,
        superseded.map((candidate) => candidate.id)
      )
      const deleted = await storage.deleteObjects(superseded.map((candidate) => candidate.storageKey))

      if (deleted.failed.length) {
        console.warn(`media.prepare: ${deleted.failed.length} superseded object(s) not deleted`)
      }
    }

    await options.repo.updateMediaAssetPreparation(asset.id, {
      durationMs: durationMs ?? null,
      peaksStorageKey,
      preparedAt: (options.now?.() ?? new Date()).toISOString(),
      prepareError: null,
    })

    if (durationMs !== undefined) {
      await options.repo.setMeetingDurationMs(meeting.id, durationMs, "media")
    }

    return {
      status: "prepared",
      assetId: asset.id,
      durationMs,
      peaksStorageKey,
      playback: decision,
      playbackAssetId,
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
