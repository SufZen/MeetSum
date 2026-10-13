/**
 * Playback asset selection (M4, client-safe: type-only imports). Pure; no
 * storage keys or URLs leave this module in summaries.
 */
import type { MediaAsset } from "@/lib/meetings/repository"

export type PlaybackVariant = "audio" | "video"

export const PLAYBACK_VARIANTS: readonly PlaybackVariant[] = ["audio", "video"]

export type PlaybackAssetSummary = {
  assetId: string
  contentType: string
  sizeBytes: number
  kind: MediaAsset["kind"]
  durationMs?: number
}

/** What the player can load for a meeting (no storage keys, no URLs). */
export type MeetingMediaSummary = {
  available: boolean
  audio?: PlaybackAssetSummary
  video?: PlaybackAssetSummary
  /** Waveform peaks exist for the playable original. */
  peaks: boolean
  durationMs?: number
}

/** Browser-playable audio containers/codecs for an original. */
export const BROWSER_AUDIO_TYPES: readonly string[] = [
  "audio/mpeg",
  "audio/mp4",
  "audio/x-m4a",
  "audio/aac",
  "audio/webm",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
  "audio/flac",
]

/** Browser-playable video containers. */
export const BROWSER_VIDEO_TYPES: readonly string[] = ["video/mp4", "video/webm"]

/** `audio/mp4; codecs=...` → `audio/mp4`. */
export function baseContentType(contentType: string | undefined): string {
  return (contentType ?? "").split(";")[0].trim().toLowerCase()
}

function kindOf(asset: MediaAsset) {
  return asset.kind ?? "original"
}

function newest(
  assets: readonly MediaAsset[],
  predicate: (asset: MediaAsset) => boolean
): MediaAsset | undefined {
  let found: MediaAsset | undefined

  for (const asset of assets) {
    if (!asset.storageKey || !predicate(asset)) continue
    if (!found || asset.createdAt > found.createdAt) found = asset
  }

  return found
}

function summarize(asset: MediaAsset): PlaybackAssetSummary {
  return {
    assetId: asset.id,
    contentType: asset.contentType,
    sizeBytes: asset.sizeBytes,
    kind: kindOf(asset),
    ...(asset.durationMs !== undefined ? { durationMs: asset.durationMs } : {}),
  }
}

/**
 * The asset the player loads:
 * - `audio`: newest `playback` rendition, else newest browser-playable
 *   original audio, else original mp4/webm video, else none;
 * - `video`: newest original with `retention='video'` and mp4/webm.
 */
export function selectPlaybackAsset(
  assets: readonly MediaAsset[],
  variant: PlaybackVariant = "audio"
): MediaAsset | undefined {
  const isOriginal = (asset: MediaAsset) => kindOf(asset) === "original"
  const isVideo = (asset: MediaAsset) =>
    BROWSER_VIDEO_TYPES.includes(baseContentType(asset.contentType))

  if (variant === "video") {
    return newest(assets, (asset) => isOriginal(asset) && asset.retention === "video" && isVideo(asset))
  }

  return (
    newest(assets, (asset) => kindOf(asset) === "playback") ??
    newest(
      assets,
      (asset) => isOriginal(asset) && BROWSER_AUDIO_TYPES.includes(baseContentType(asset.contentType))
    ) ??
    newest(assets, (asset) => isOriginal(asset) && isVideo(asset))
  )
}

/**
 * Original holding the waveform peaks for the audio the player loads: the
 * original a playback rendition derives from, else the selected original,
 * else the newest original with peaks.
 */
export function selectPeaksSource(assets: readonly MediaAsset[]): MediaAsset | undefined {
  const audio = selectPlaybackAsset(assets, "audio")
  const origin =
    audio && kindOf(audio) === "playback"
      ? assets.find((asset) => asset.id === audio.derivedFromAssetId)
      : audio

  if (origin?.peaksStorageKey) return origin

  return newest(assets, (asset) => kindOf(asset) === "original" && Boolean(asset.peaksStorageKey))
}

/** What the player can load for a meeting (client-safe summary). */
export function describeMeetingMedia(assets: readonly MediaAsset[]): MeetingMediaSummary {
  const audio = selectPlaybackAsset(assets, "audio")
  const video = selectPlaybackAsset(assets, "video")

  if (!audio && !video) return { available: false, peaks: false }

  const peaksSource = selectPeaksSource(assets)
  const origin =
    audio && kindOf(audio) === "playback"
      ? assets.find((asset) => asset.id === audio.derivedFromAssetId)
      : audio
  const durationMs = audio?.durationMs ?? origin?.durationMs ?? video?.durationMs

  return {
    available: true,
    ...(audio ? { audio: summarize(audio) } : {}),
    ...(video ? { video: summarize(video) } : {}),
    peaks: Boolean(peaksSource?.peaksStorageKey),
    ...(durationMs !== undefined ? { durationMs } : {}),
  }
}
