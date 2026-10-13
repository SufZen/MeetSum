/**
 * Playback asset selection (M4, client-safe: type-only imports).
 *
 * Step 0 stubs pick the newest `original` asset; Package A implements the
 * normative rules (playback rendition first, browser-playable audio, then
 * video; `video` only for retained mp4/webm video).
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

function newestOriginal(assets: readonly MediaAsset[]): MediaAsset | undefined {
  let newest: MediaAsset | undefined

  for (const asset of assets) {
    if ((asset.kind ?? "original") !== "original") continue
    if (!newest || asset.createdAt > newest.createdAt) newest = asset
  }

  return newest
}

function summarize(asset: MediaAsset): PlaybackAssetSummary {
  return {
    assetId: asset.id,
    contentType: asset.contentType,
    sizeBytes: asset.sizeBytes,
    kind: asset.kind ?? "original",
    ...(asset.durationMs !== undefined ? { durationMs: asset.durationMs } : {}),
  }
}

/** Step 0 stub: newest original asset for either variant. */
export function selectPlaybackAsset(
  assets: readonly MediaAsset[],
  variant: PlaybackVariant = "audio"
): MediaAsset | undefined {
  void variant

  return newestOriginal(assets)
}

/** Step 0 stub: describes the newest original as the audio source. */
export function describeMeetingMedia(assets: readonly MediaAsset[]): MeetingMediaSummary {
  const audio = newestOriginal(assets)

  if (!audio) return { available: false, peaks: false }

  return {
    available: true,
    audio: summarize(audio),
    peaks: Boolean(audio.peaksStorageKey),
    ...(audio.durationMs !== undefined ? { durationMs: audio.durationMs } : {}),
  }
}
