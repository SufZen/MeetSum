import { execFile as nodeExecFile } from "node:child_process"
import path from "node:path"

import { downloadMeetingObjectToFile } from "@/lib/storage/object-storage"

import { envNumber, envText, type AsrEnv } from "./config"
import { AsrError, type AsrMedia } from "./types"

/**
 * ffmpeg/ffprobe helpers for ASR. Every binary call goes through an
 * injectable `execFile` so tests never need the binaries; parsing and chunk
 * planning are pure.
 */

export type ExecFileResult = { stdout: string; stderr: string }
export type ExecFileFn = (
  file: string,
  args: string[],
  options?: { timeout?: number; maxBuffer?: number }
) => Promise<ExecFileResult>

export const defaultExecFile: ExecFileFn = (file, args, options = {}) =>
  new Promise((resolve, reject) => {
    nodeExecFile(
      file,
      args,
      { maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024, timeout: options.timeout, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }))
          return
        }

        resolve({ stdout: String(stdout), stderr: String(stderr) })
      }
    )
  })

export type AudioDeps = { execFile?: ExecFileFn; env?: AsrEnv }

export type Silence = { startMs: number; endMs: number }
export type Chunk = { startMs: number; endMs: number }

function ffmpegTimeout(env: AsrEnv) {
  return envNumber(env, "MEETSUM_FFMPEG_TIMEOUT_MS", 900_000)
}

function wrapFfmpegError(error: unknown, provider: string, step: string): AsrError {
  const stderr = (error as { stderr?: string })?.stderr ?? ""
  const message = `${step} failed: ${error instanceof Error ? error.message : String(error)}`
  const lower = `${message}\n${stderr}`.toLowerCase()

  if (lower.includes("enoent")) {
    return new AsrError(`${step} failed: ffmpeg/ffprobe is not installed`, "config", provider, false)
  }
  if (
    lower.includes("invalid data found") ||
    lower.includes("does not contain any stream") ||
    lower.includes("output file #0 does not contain") ||
    lower.includes("could not find codec") ||
    lower.includes("moov atom not found")
  ) {
    return new AsrError(`${message} (media could not be decoded)`, "bad_input", provider, false)
  }

  return new AsrError(message, "unknown", provider, true)
}

/** Media duration in ms via ffprobe. */
export async function probeDurationMs(
  file: string,
  deps: AudioDeps & { provider?: string } = {}
): Promise<number> {
  const env = deps.env ?? process.env
  const run = deps.execFile ?? defaultExecFile

  try {
    const { stdout } = await run(
      "ffprobe",
      ["-v", "error", ...FFMPEG_INPUT_PROTOCOLS, "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file],
      { timeout: ffmpegTimeout(env) }
    )
    const seconds = Number.parseFloat(stdout.trim().split(/\s+/)[0] ?? "")

    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new AsrError("ffprobe returned no duration (media could not be decoded)", "bad_input", deps.provider ?? "asr", false)
    }

    return Math.round(seconds * 1000)
  } catch (error) {
    if (error instanceof AsrError) throw error
    throw wrapFfmpegError(error, deps.provider ?? "asr", "ffprobe")
  }
}

/**
 * Input option for every ffmpeg/ffprobe call: only local files and pipes,
 * so crafted media (HLS playlists, concat lists) cannot make ffmpeg fetch
 * URLs or read other protocols.
 */
export const FFMPEG_INPUT_PROTOCOLS: readonly string[] = ["-protocol_whitelist", "file,pipe"]

/** Arguments that encode 16 kHz mono Opus/OGG at the ASR bitrate. */
function opusArgs(env: AsrEnv) {
  return [
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "libopus",
    "-b:a",
    envText(env, "MEETSUM_ASR_AUDIO_BITRATE") ?? "24k",
    "-application",
    "voip",
    "-f",
    "ogg",
  ]
}

/** Transcodes any media to 16 kHz mono Opus/OGG (`MEETSUM_ASR_AUDIO_BITRATE`). */
export async function transcodeForAsr(
  input: string,
  output: string,
  deps: AudioDeps & { provider?: string } = {}
): Promise<string> {
  const env = deps.env ?? process.env
  const run = deps.execFile ?? defaultExecFile

  try {
    await run("ffmpeg", ["-hide_banner", "-nostats", "-y", ...FFMPEG_INPUT_PROTOCOLS, "-i", input, ...opusArgs(env), output], {
      timeout: ffmpegTimeout(env),
    })
    return output
  } catch (error) {
    throw wrapFfmpegError(error, deps.provider ?? "asr", "ffmpeg transcode")
  }
}

/** Re-encodes `[startMs, endMs)` of an ASR file into its own OGG chunk. */
export async function cutAudioChunk(
  input: string,
  output: string,
  chunk: Chunk,
  deps: AudioDeps & { provider?: string } = {}
): Promise<string> {
  const env = deps.env ?? process.env
  const run = deps.execFile ?? defaultExecFile
  const seconds = (ms: number) => (ms / 1000).toFixed(3)

  try {
    await run(
      "ffmpeg",
      [
        "-hide_banner",
        "-nostats",
        "-y",
        "-ss",
        seconds(chunk.startMs),
        "-t",
        seconds(chunk.endMs - chunk.startMs),
        ...FFMPEG_INPUT_PROTOCOLS,
        "-i",
        input,
        ...opusArgs(env),
        output,
      ],
      { timeout: ffmpegTimeout(env) }
    )
    return output
  } catch (error) {
    throw wrapFfmpegError(error, deps.provider ?? "asr", "ffmpeg chunk")
  }
}

/** Parses ffmpeg `silencedetect` stderr into silence ranges (ms). */
export function parseSilenceDetect(stderr: string): Silence[] {
  const silences: Silence[] = []
  let start: number | undefined

  for (const line of stderr.split(/\r?\n/)) {
    const startMatch = /silence_start:\s*(-?[\d.]+)/.exec(line)

    if (startMatch) {
      start = Math.max(0, Math.round(Number.parseFloat(startMatch[1]) * 1000))
      continue
    }

    const endMatch = /silence_end:\s*([\d.]+)/.exec(line)

    if (endMatch) {
      const endMs = Math.round(Number.parseFloat(endMatch[1]) * 1000)
      const durationMatch = /silence_duration:\s*([\d.]+)/.exec(line)
      const startMs =
        start ?? (durationMatch ? Math.max(0, endMs - Math.round(Number.parseFloat(durationMatch[1]) * 1000)) : undefined)

      if (startMs !== undefined && endMs > startMs) silences.push({ startMs, endMs })
      start = undefined
    }
  }

  return silences
}

/** Runs `silencedetect=noise=-35dB:d=0.4` over a file. */
export async function detectSilences(
  file: string,
  deps: AudioDeps & { provider?: string } = {}
): Promise<Silence[]> {
  const env = deps.env ?? process.env
  const run = deps.execFile ?? defaultExecFile

  try {
    const { stderr } = await run(
      "ffmpeg",
      ["-hide_banner", "-nostats", ...FFMPEG_INPUT_PROTOCOLS, "-i", file, "-af", "silencedetect=noise=-35dB:d=0.4", "-f", "null", "-"],
      { timeout: ffmpegTimeout(env) }
    )
    return parseSilenceDetect(stderr)
  } catch (error) {
    throw wrapFfmpegError(error, deps.provider ?? "asr", "ffmpeg silencedetect")
  }
}

/**
 * Plans chunks of at most `maxMs`. Each cut lands in the middle of the
 * longest silence inside the last `searchMs` before the cap; without a
 * silence there it is a hard cut at the cap.
 */
export function planChunks(
  durationMs: number,
  silences: Silence[],
  options: { maxMs?: number; searchMs?: number } = {}
): Chunk[] {
  const maxMs = Math.max(1000, options.maxMs ?? 600_000)
  const searchMs = Math.min(maxMs - 1, Math.max(0, options.searchMs ?? 60_000))
  const total = Math.max(0, Math.round(durationMs))
  const chunks: Chunk[] = []
  let cursor = 0

  while (total - cursor > maxMs) {
    const cap = cursor + maxMs
    const windowStart = cap - searchMs
    let best: { length: number; cut: number } | undefined

    for (const silence of silences) {
      const start = Math.max(silence.startMs, windowStart)
      const end = Math.min(silence.endMs, cap)

      if (end <= start) continue

      const length = end - start

      if (!best || length > best.length) best = { length, cut: Math.round((start + end) / 2) }
    }

    const cut = best && best.cut > cursor ? best.cut : cap

    chunks.push({ startMs: cursor, endMs: cut })
    cursor = cut
  }

  if (total > cursor || !chunks.length) chunks.push({ startMs: cursor, endMs: total })
  return chunks
}

/** Lower-case extension of an uploaded filename when it is a plain one, else "". */
function safeExtension(name: string | undefined): string {
  const ext = path.extname(name ?? "").toLowerCase()

  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : ""
}

/**
 * Local path for request media: file media as-is, object media downloaded
 * into `dir` as `input-<uuid><ext>`. The user's filename is ignored (only a
 * plain extension is kept) so it can never collide with an output file or
 * escape `dir`.
 */
export async function materializeMedia(
  media: AsrMedia,
  dir: string,
  deps: { download?: (key: string, destination: string) => Promise<void>; provider?: string } = {}
): Promise<string> {
  if (media.kind === "file") return media.path

  const destination = path.join(dir, `input-${crypto.randomUUID()}${safeExtension(media.filename)}`)

  try {
    await (deps.download ?? downloadMeetingObjectToFile)(media.storageKey, destination)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    if (/nosuchkey|not found|404/i.test(message)) {
      throw new AsrError(`Meeting media is missing: ${message}`, "bad_input", deps.provider ?? "asr", false)
    }
    throw new AsrError(`Could not download meeting media: ${message}`, "unknown", deps.provider ?? "asr", true)
  }

  return destination
}
