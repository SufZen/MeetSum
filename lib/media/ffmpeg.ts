import {
  defaultExecFile,
  FFMPEG_INPUT_PROTOCOLS,
  type ExecFileFn,
} from "@/lib/ai/asr/audio"

/**
 * ffmpeg/ffprobe invocations for media preparation (M4 Package A). Every
 * call goes through an injectable `execFile` (M3 convention), restricts
 * input protocols to `file,pipe` before `-i`, and only ever receives paths
 * the caller generated inside its temp dir (never user filenames).
 */

export type { ExecFileFn }
export { defaultExecFile }

export type MediaEnv = Record<string, string | undefined>

export type MediaExecDeps = {
  exec?: ExecFileFn
  env?: MediaEnv
}

export const DEFAULT_MEDIA_PREPARE_TIMEOUT_MS = 900_000
export const DEFAULT_PLAYBACK_AUDIO_BITRATE = "64k"

export function mediaBinaries(env: MediaEnv = process.env) {
  return {
    ffmpeg: env.FFMPEG_PATH?.trim() || "ffmpeg",
    ffprobe: env.FFPROBE_PATH?.trim() || "ffprobe",
  }
}

export function mediaPrepareTimeoutMs(env: MediaEnv = process.env): number {
  const parsed = Number(env.MEETSUM_MEDIA_PREPARE_TIMEOUT_MS)

  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MEDIA_PREPARE_TIMEOUT_MS
}

export function playbackAudioBitrate(env: MediaEnv = process.env): string {
  const value = env.MEETSUM_PLAYBACK_AUDIO_BITRATE?.trim()

  return value && /^\d+(?:\.\d+)?[kKmM]?$/.test(value) ? value : DEFAULT_PLAYBACK_AUDIO_BITRATE
}

/** ffprobe `format=duration` stdout (seconds) → ms, or undefined. */
export function parseFfprobeDuration(stdout: string): number | undefined {
  const seconds = Number.parseFloat(stdout.trim().split(/\s+/)[0] ?? "")

  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined
}

/** Probed duration in ms; undefined when ffprobe fails or reports none. */
export async function probeMediaDurationMs(
  file: string,
  deps: MediaExecDeps = {}
): Promise<number | undefined> {
  const env = deps.env ?? process.env
  const run = deps.exec ?? defaultExecFile

  try {
    const { stdout } = await run(
      mediaBinaries(env).ffprobe,
      [
        "-v",
        "error",
        ...FFMPEG_INPUT_PROTOCOLS,
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        file,
      ],
      { timeout: mediaPrepareTimeoutMs(env) }
    )

    return parseFfprobeDuration(stdout)
  } catch {
    return undefined
  }
}

/** Decodes any media to raw s16le mono PCM at `sampleRate` (peaks input). */
export async function extractPeaksPcm(
  input: string,
  output: string,
  sampleRate: number,
  deps: MediaExecDeps = {}
): Promise<void> {
  const env = deps.env ?? process.env

  await (deps.exec ?? defaultExecFile)(
    mediaBinaries(env).ffmpeg,
    [
      "-hide_banner",
      "-nostats",
      "-y",
      ...FFMPEG_INPUT_PROTOCOLS,
      "-i",
      input,
      "-vn",
      "-ac",
      "1",
      "-ar",
      String(sampleRate),
      "-f",
      "s16le",
      output,
    ],
    { timeout: mediaPrepareTimeoutMs(env) }
  )
}

/** AAC-LC mono `.m4a` with faststart (`MEETSUM_PLAYBACK_AUDIO_BITRATE`). */
export async function transcodePlaybackAudio(
  input: string,
  output: string,
  deps: MediaExecDeps = {}
): Promise<void> {
  const env = deps.env ?? process.env

  await (deps.exec ?? defaultExecFile)(
    mediaBinaries(env).ffmpeg,
    [
      "-hide_banner",
      "-nostats",
      "-y",
      ...FFMPEG_INPUT_PROTOCOLS,
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
      playbackAudioBitrate(env),
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      output,
    ],
    { timeout: mediaPrepareTimeoutMs(env) }
  )
}
