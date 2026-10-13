/**
 * `clip.render` job (M5 C1): cuts `[startMs, endMs)` from the meeting's
 * playback/original asset into a mono AAC 64k `.m4a` stored at
 * `clips/<workspaceId>/<clipId>.m4a` — never the source recording's key.
 *
 * ffmpeg goes through the injectable `execFile` (M3/M4 convention), with
 * `-protocol_whitelist file,pipe` before `-i` and only paths generated
 * inside a fresh temp dir (never user filenames). The temp dir is always
 * removed. A bad range is permanent (UnrecoverableError, no retry).
 */
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { UnrecoverableError } from "bullmq"

import type { CollabBackend } from "@/lib/clips/db"
import { getClipForRender, setClipRenderResult } from "@/lib/clips/store"
import type { MeetingClip } from "@/lib/clips/types"
import {
  defaultExecFile,
  FFMPEG_INPUT_PROTOCOLS,
  type ExecFileFn,
} from "@/lib/ai/asr/audio"
import { mediaBinaries, mediaPrepareTimeoutMs, type MediaEnv } from "@/lib/media/ffmpeg"
import { selectPlaybackAsset } from "@/lib/media/playback-select"
import type { MediaAsset, MeetingRecord } from "@/lib/meetings/repository"

export type RenderClipJobInput = {
  workspaceId: string
  clipId: string
  meetingId?: unknown
}

export const CLIP_AUDIO_BITRATE = "64k"
export const CLIP_CONTENT_TYPE = "audio/mp4"

/** Object key of a rendered clip; never the source recording's key. */
export function clipStorageKey(workspaceId: string, clipId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(workspaceId) || !/^[A-Za-z0-9_-]+$/.test(clipId)) {
    throw new Error("Invalid clip storage key component")
  }

  return `clips/${workspaceId}/${clipId}.m4a`
}

export type ClipRenderStorage = {
  download: (key: string, destination: string) => Promise<void>
  putFile: (options: { key: string; path: string; contentType: string }) => Promise<unknown>
}

export type RenderClipDeps = {
  exec?: ExecFileFn
  env?: MediaEnv
  storage?: ClipRenderStorage
  backend?: CollabBackend
  loadMeeting?: (workspaceId: string, meetingId: string) => Promise<MeetingRecord | undefined>
  tmpRoot?: string
}

/** Seconds with millisecond precision for ffmpeg time options. */
export function ffmpegSeconds(ms: number): string {
  return (Math.max(0, Math.round(ms)) / 1000).toFixed(3)
}

/** ffmpeg argv for one clip (exported for tests). */
export function clipFfmpegArgs(input: string, output: string, clip: Pick<MeetingClip, "startMs" | "endMs">) {
  return [
    "-hide_banner",
    "-nostats",
    "-y",
    ...FFMPEG_INPUT_PROTOCOLS,
    "-ss",
    ffmpegSeconds(clip.startMs),
    "-to",
    ffmpegSeconds(clip.endMs),
    "-i",
    input,
    "-vn",
    "-ac",
    "1",
    "-c:a",
    "aac",
    "-profile:a",
    "aac_low",
    "-b:a",
    CLIP_AUDIO_BITRATE,
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    output,
  ]
}

/** The asset clips are cut from: the playback rendition, else an original. */
export function clipSourceAsset(assets: readonly MediaAsset[]): MediaAsset | undefined {
  return (
    selectPlaybackAsset(assets, "audio") ??
    selectPlaybackAsset(assets, "video") ??
    assets.find((asset) => asset.storageKey && (asset.kind ?? "original") === "original")
  )
}

/** Plain lower-case extension of the stored name, else "" (never a path). */
function safeExtension(filename: string | undefined): string {
  const ext = path.extname(filename ?? "").toLowerCase()

  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : ""
}

async function defaultStorage(): Promise<ClipRenderStorage> {
  const storage = await import("@/lib/storage/object-storage")

  return {
    download: storage.downloadMeetingObjectToFile,
    putFile: storage.putMeetingObjectFile,
  }
}

async function defaultLoadMeeting(workspaceId: string, meetingId: string) {
  const { getSystemMeetingRepository } = await import("@/lib/meetings/store")

  return getSystemMeetingRepository(workspaceId).getMeeting(meetingId, {
    includeTranscript: false,
  })
}

/** Short failure reason stored on the clip (no paths or stderr). */
function renderFailure(error: unknown): string {
  if (error instanceof UnrecoverableError) return error.message.slice(0, 200)

  const name = (error as { name?: string })?.name

  return name && name !== "Error" ? `render failed (${name})` : "render failed"
}

export async function renderClipJob(
  input: RenderClipJobInput,
  deps: RenderClipDeps = {}
): Promise<Record<string, unknown>> {
  const { workspaceId, clipId } = input
  const clip = await getClipForRender(workspaceId, clipId, deps.backend)

  // Deleted (or never existed) since enqueue: nothing to do.
  if (!clip) return { clipId, skipped: true, reason: "clip not found" }

  const env = deps.env ?? process.env

  try {
    const meeting = await (deps.loadMeeting ?? defaultLoadMeeting)(workspaceId, clip.meetingId)

    if (!meeting) throw new UnrecoverableError("meeting not found")

    const asset = clipSourceAsset(meeting.mediaAssets ?? [])

    if (!asset) throw new UnrecoverableError("no recording to cut the clip from")
    if (clip.endMs <= clip.startMs || clip.startMs < 0) {
      throw new UnrecoverableError("invalid clip range")
    }

    const durationMs = asset.durationMs ?? meeting.durationMs

    if (durationMs !== undefined && durationMs > 0 && clip.startMs >= durationMs) {
      throw new UnrecoverableError("clip range is outside the recording")
    }

    const storage = deps.storage ?? (await defaultStorage())
    const dir = await mkdtemp(path.join(deps.tmpRoot ?? tmpdir(), "meetsum-clip-"))

    try {
      const source = path.join(dir, `source${safeExtension(asset.filename)}`)
      const output = path.join(dir, "clip.m4a")

      await storage.download(asset.storageKey, source)
      await (deps.exec ?? defaultExecFile)(
        mediaBinaries(env).ffmpeg,
        clipFfmpegArgs(source, output, clip),
        { timeout: mediaPrepareTimeoutMs(env) }
      )

      const { size } = await stat(output)

      if (size <= 0) throw new UnrecoverableError("ffmpeg produced an empty clip")

      const key = clipStorageKey(workspaceId, clipId)

      if (key === asset.storageKey) throw new UnrecoverableError("clip key collides with source")

      await storage.putFile({ key, path: output, contentType: CLIP_CONTENT_TYPE })
      await setClipRenderResult(workspaceId, clipId, { status: "ready", storageKey: key }, deps.backend)

      return { clipId, status: "ready", sizeBytes: size }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  } catch (error) {
    // Permanent failures are recorded now; transient ones only after BullMQ
    // gives up would be ideal, but the clip must not look "pending" forever.
    await setClipRenderResult(
      workspaceId,
      clipId,
      { status: "failed", error: renderFailure(error) },
      deps.backend
    ).catch(() => undefined)
    throw error
  }
}
