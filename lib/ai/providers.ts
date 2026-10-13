import { type GoogleGenAI, Type } from "@google/genai"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import { FFMPEG_INPUT_PROTOCOLS } from "@/lib/ai/asr/audio"
import { DEFAULT_ASR_GLOSSARY } from "@/lib/ai/asr/default-glossary"
import { TranscriptionUnavailableError } from "@/lib/ai/asr/errors"
import { transcribeWithRouter, type AsrRouterOptions } from "@/lib/ai/asr/router"
import type { AsrGlossary, AsrResult } from "@/lib/ai/asr/types"
import { getGeminiModels } from "@/lib/ai/llm/config"
import {
  createGeminiClient,
  getGeminiHttpOptions,
  getGeminiProviderMode,
  isGeminiConfigured,
} from "@/lib/ai/llm/gemini-client"
import { cleanupTranscriptSegments, type MeetingIntelligence } from "@/lib/intelligence"
import {
  buildHeuristicIntelligence,
  runIntelligencePipeline,
  type IntelligencePipelineOptions,
  type IntelligenceRunMetadata,
} from "@/lib/intelligence/pipeline"
import { getLogger } from "@/lib/log"

const log = getLogger({ component: "ai.providers" })

export { TranscriptionUnavailableError }

import type {
  MeetingRecord,
  TranscriptSegment,
} from "@/lib/meetings/repository"
import {
  downloadMeetingObjectToFile,
  getMeetingObjectBytes,
} from "@/lib/storage/object-storage"

const execFileAsync = promisify(execFile)

/** `gemini-3.5-flash` is deprecated (auto-routed to 3.6, retiring 2026-11-19). */
const DEFAULT_GEMINI_AUDIO_MODEL = "gemini-3.8-flash"

export type TranscriptionProvider = {
  id: string
  model: string
  transcribe: (meeting: MeetingRecord) => Promise<TranscriptSegment[]>
  getLastRun?: () => TranscriptionRunMetadata
}

export type SummaryRunMetadata = {
  provider: string
  model: string
  fallbackUsed?: boolean
  fallbackReason?: string
  /** M5 pipeline details (tokens, cost, template, language check, title). */
  pipeline?: IntelligenceRunMetadata
}

/** Per-run options passed through from the job payload (M5). */
export type SummarizeOptions = Pick<
  IntelligencePipelineOptions,
  "templateKey" | "language" | "jobId" | "members" | "provider"
>

export type SummaryProvider = {
  id: string
  model: string
  summarize: (meeting: MeetingRecord, options?: SummarizeOptions) => Promise<MeetingIntelligence>
  getLastRun?: () => SummaryRunMetadata
}

export type TranscriptionProviderMode = "gemini" | "local-whisper" | "auto"

export type TranscriptionRunMetadata = {
  provider: string
  model: string
  fallbackUsed?: boolean
  attemptedProvider?: string
  fallbackReason?: string
  fallbackCategory?: WhisperErrorCategory
  fallbackElapsedMs?: number
}

export type WhisperErrorCategory =
  | "timeout"
  | "connection"
  | "cuda_oom"
  | "model_load"
  | "server_error"
  | "client_error"
  | "config"
  | "no_media"
  | "unknown"

export type WhisperDiagnostic = {
  success: boolean
  error?: string
  errorCategory?: WhisperErrorCategory
  httpStatus?: number
  elapsedMs: number
  segmentCount?: number
  fileSizeBytes?: number
}

export function classifyWhisperError(error: unknown): WhisperErrorCategory {
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()

  if (error instanceof Error && error.name === "AbortError") return "timeout"
  if (lower.includes("etimedout") || lower.includes("timeout")) return "timeout"
  if (lower.includes("econnrefused") || lower.includes("enotfound") || lower.includes("fetch failed"))
    return "connection"
  if (lower.includes("cuda") && lower.includes("memory")) return "cuda_oom"
  if (lower.includes("out of memory") || lower.includes("oom")) return "cuda_oom"
  if (lower.includes("model") && (lower.includes("load") || lower.includes("not found")))
    return "model_load"
  if (lower.includes("500") || lower.includes("502") || lower.includes("503"))
    return "server_error"
  if (lower.includes("400") || lower.includes("422"))
    return "client_error"

  return "unknown"
}

export async function whisperHealthCheck(
  config = getLocalWhisperProviderConfig()
): Promise<WhisperDiagnostic> {
  if (!config.baseUrl) {
    return { success: false, error: "LOCAL_TRANSCRIPTION_URL not configured", errorCategory: "config", elapsedMs: 0 }
  }

  const startTime = Date.now()
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)

    try {
      const response = await fetch(`${config.baseUrl}/v1/models`, {
        signal: controller.signal,
        ...(config.apiKey ? { headers: { Authorization: `Bearer ${config.apiKey}` } } : {}),
      })
      const elapsedMs = Date.now() - startTime

      if (!response.ok) {
        return {
          success: false,
          error: `Health check returned ${response.status}`,
          errorCategory: response.status >= 500 ? "server_error" : "client_error",
          httpStatus: response.status,
          elapsedMs,
        }
      }

      return { success: true, elapsedMs }
    } finally {
      clearTimeout(timeout)
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      errorCategory: classifyWhisperError(error),
      elapsedMs: Date.now() - startTime,
    }
  }
}

export type LocalWhisperProviderConfig = {
  baseUrl: string
  model: string
  language: string
  timeoutMs: number
  /** Bearer token for hosted OpenAI-compatible Whisper (LOCAL_TRANSCRIPTION_API_KEY). */
  apiKey?: string
}

const DEFAULT_LOCAL_WHISPER_MODEL = "ivrit-ai/whisper-large-v3-turbo-ct2"
const DEFAULT_LOCAL_WHISPER_LANGUAGE = "he"
const DEFAULT_LOCAL_WHISPER_TIMEOUT_MS = 900_000

function positiveNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value)

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function getTranscriptionProviderMode(
  env: Record<string, string | undefined> = process.env
): TranscriptionProviderMode {
  const requested = env.MEETSUM_TRANSCRIPTION_PROVIDER?.trim().toLowerCase()

  if (
    requested === "local-whisper" ||
    requested === "auto" ||
    requested === "gemini"
  ) {
    return requested
  }

  return "auto"
}

export function isLocalWhisperConfigured(
  env: Record<string, string | undefined> = process.env
) {
  return Boolean(env.LOCAL_TRANSCRIPTION_URL?.trim())
}

export function getLocalWhisperProviderConfig(
  env: Record<string, string | undefined> = process.env
): LocalWhisperProviderConfig {
  return {
    baseUrl: (env.LOCAL_TRANSCRIPTION_URL ?? "").replace(/\/+$/, ""),
    model: env.LOCAL_TRANSCRIPTION_MODEL ?? DEFAULT_LOCAL_WHISPER_MODEL,
    ...(env.LOCAL_TRANSCRIPTION_API_KEY?.trim() ? { apiKey: env.LOCAL_TRANSCRIPTION_API_KEY.trim() } : {}),
    language: env.LOCAL_TRANSCRIPTION_LANGUAGE ?? DEFAULT_LOCAL_WHISPER_LANGUAGE,
    timeoutMs: positiveNumber(
      env.LOCAL_TRANSCRIPTION_TIMEOUT_MS,
      DEFAULT_LOCAL_WHISPER_TIMEOUT_MS
    ),
  }
}

export function getTranscriptionRunMetadata(
  provider: TranscriptionProvider
): TranscriptionRunMetadata {
  return provider.getLastRun?.() ?? {
    provider: provider.id,
    model: provider.model,
  }
}

export function getSummaryRunMetadata(provider: SummaryProvider): SummaryRunMetadata {
  return provider.getLastRun?.() ?? {
    provider: provider.id,
    model: provider.model,
  }
}

export {
  createGeminiClient,
  getGeminiProviderMode,
  isGeminiConfigured,
  type GeminiProviderMode,
} from "@/lib/ai/llm/gemini-client"

type GeminiTranscriptSegment = {
  speaker?: string
  startMs?: number
  endMs?: number
  text?: string
  language?: string
  confidence?: number
  uncertainty?: boolean
}

function normalizeGeminiSegments(
  segments: GeminiTranscriptSegment[],
  meeting: MeetingRecord
): TranscriptSegment[] {
  const normalized = segments
    .filter((segment) => segment.text?.trim())
    .map((segment, index) => ({
      id: `seg_${crypto.randomUUID()}`,
      // No index-based guessing: a segment without a speaker stays unattributed.
      speaker: segment.speaker?.trim() ?? "",
      startMs: Math.max(0, Number(segment.startMs ?? index * 5000)),
      endMs: Math.max(
        Number(segment.startMs ?? index * 5000) + 1000,
        Number(segment.endMs ?? (index + 1) * 5000)
      ),
      text: segment.uncertainty
        ? `[uncertain] ${segment.text?.trim()}`
        : segment.text?.trim() ?? "",
      confidence: Math.min(1, Math.max(0, Number(segment.confidence ?? 0.7))),
      language: segment.language ?? meeting.language,
    }))

  return cleanupTranscriptSegments(normalized)
}

function getAudioPrompt(meeting: MeetingRecord, compactTimeline = false) {
  return [
    compactTimeline
      ? "Create compact timestamped transcript notes for this long meeting audio/video as structured JSON."
      : "Transcribe this meeting audio/video as structured JSON.",
    "Return ONLY JSON with a top-level `segments` array.",
    "Each segment must include: speaker, startMs, endMs, text, language, confidence, uncertainty.",
    compactTimeline
      ? "For long recordings, do not create a verbatim transcript. Return 30-80 concise timeline segments that preserve decisions, tasks, blockers, names, numbers, and important quotes."
      : "Prefer faithful transcript text, split into timestamped speaker turns.",
    "Use speaker labels like Speaker 1, Speaker 2 when names are not clear.",
    "Support Hebrew, English, Portuguese, Spanish, Italian, and mixed-language meetings.",
    "For Hebrew, preserve names, numbers, dates, currencies, percentages, and mixed English technical terms such as VSCode, Supabase, MCP, RealizeOS, Gemini, Gemma.",
    "Do not invent inaudible details. Mark uncertainty=true when unclear.",
    `Meeting title: ${meeting.title}`,
    `Known participants: ${meeting.participants.join(", ") || "unknown"}`,
  ].join("\n")
}

function stripJsonFence(value: string) {
  return value
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim()
}

function parseGeminiTranscriptSegments(raw: string): GeminiTranscriptSegment[] {
  const text = stripJsonFence(raw)

  try {
    const parsed = JSON.parse(text) as { segments?: GeminiTranscriptSegment[] }
    return parsed.segments ?? []
  } catch {
    const segments: GeminiTranscriptSegment[] = []
    const objectPattern =
      /\{[^{}]*"text"\s*:\s*"(?:(?:\\.)|[^"\\])*"[^{}]*\}/g

    for (const match of text.matchAll(objectPattern)) {
      try {
        const parsed = JSON.parse(match[0]) as GeminiTranscriptSegment
        if (parsed.text?.trim()) segments.push(parsed)
      } catch {
        // Keep scanning; Gemini can truncate the tail of an otherwise useful JSON payload.
      }
    }

    if (segments.length) return segments

    const textPattern = /"text"\s*:\s*"((?:(?:\\.)|[^"\\])*)"/g

    for (const match of text.matchAll(textPattern)) {
      try {
        const parsedText = JSON.parse(`"${match[1]}"`) as string
        if (parsedText.trim()) segments.push({ text: parsedText })
      } catch {
        // Ignore a malformed fragment and keep any other recoverable segments.
      }
    }

    return segments
  }
}

function safeTempFilename(filename: string | undefined, fallback: string) {
  return (filename ?? fallback).replace(/[^\w. -]+/g, "_")
}

async function extractAudioForGemini(inputPath: string, outputPath: string) {
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      ...FFMPEG_INPUT_PROTOCOLS,
      "-i",
      inputPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-b:a",
      "64k",
      outputPath,
    ],
    {
      maxBuffer: 1024 * 1024 * 8,
      timeout: Number(process.env.MEETSUM_FFMPEG_TIMEOUT_MS ?? 900_000),
    }
  )
}

async function compressMediaForInlineGemini(inputPath: string, outputPath: string) {
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      ...FFMPEG_INPUT_PROTOCOLS,
      "-i",
      inputPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-b:a",
      process.env.MEETSUM_GEMINI_COMPRESSED_AUDIO_BITRATE ?? "32k",
      outputPath,
    ],
    {
      maxBuffer: 1024 * 1024 * 8,
      timeout: Number(process.env.MEETSUM_FFMPEG_TIMEOUT_MS ?? 900_000),
    }
  )
}

function shouldFallbackToCompressedInline(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)

  return (
    message.includes('"code":404') ||
    message.includes("fetchUploadUrl") ||
    message.toLowerCase().includes("file upload")
  )
}

async function waitForGeminiFile(
  ai: GoogleGenAI,
  name: string | undefined
) {
  if (!name) return

  const deadline = Date.now() + Number(process.env.GOOGLE_GEMINI_FILE_WAIT_MS ?? 300_000)

  while (Date.now() < deadline) {
    const file = await ai.files.get({
      name,
      config: { httpOptions: getGeminiHttpOptions() },
    })

    if (file.state === "ACTIVE") return
    if (file.state === "FAILED") {
      throw new Error(`Gemini file processing failed for ${name}`)
    }

    await new Promise((resolve) => setTimeout(resolve, 3000))
  }

  throw new Error(`Timed out waiting for Gemini file processing: ${name}`)
}

export class HeuristicFallbackProvider
  implements TranscriptionProvider, SummaryProvider
{
  readonly id = "heuristic"
  readonly model = "heuristic-v1"

  async transcribe(meeting: MeetingRecord): Promise<TranscriptSegment[]> {
    // Legitimate passthrough: a transcript already imported from another
    // source (e.g. Google Meet smart notes / Docs) just needs cleanup.
    if (meeting.transcript?.length) {
      return cleanupTranscriptSegments(meeting.transcript)
    }

    // No real transcript and no configured ASR provider produced one. Fail
    // loudly rather than fabricating a placeholder that would be persisted and
    // surfaced (in exports, shares, RealizeOS) as if it were a real transcript.
    throw new TranscriptionUnavailableError(
      `No transcription provider is available for "${meeting.title}". ` +
        "Configure GOOGLE_GEMINI_API_KEY (or Vertex AI), set LOCAL_TRANSCRIPTION_URL, " +
        "or import a transcript source before processing."
    )
  }

  /** Heuristic V2 (no chapters), `generation.provider = "heuristic"`. */
  async summarize(meeting: MeetingRecord, options: SummarizeOptions = {}) {
    return buildHeuristicIntelligence(meeting, { language: options.language })
  }
}

/**
 * Summary adapter over the M5 intelligence pipeline (Gemini default, Claude
 * optional, heuristic fallback). Kept for callers of the pre-M5
 * `SummaryProvider` contract.
 */
export class PipelineSummaryProvider implements SummaryProvider {
  readonly id = "pipeline"
  readonly model = getGeminiModels().summary
  private lastRun: SummaryRunMetadata = { provider: "gemini", model: this.model }

  getLastRun(): SummaryRunMetadata {
    return this.lastRun
  }

  async summarize(meeting: MeetingRecord, options: SummarizeOptions = {}) {
    const { intelligence, run } = await runIntelligencePipeline(meeting, options)

    this.lastRun = {
      provider: run.provider,
      model: run.model,
      fallbackUsed: run.fallbackUsed,
      ...(run.fallbackReason ? { fallbackReason: run.fallbackReason } : {}),
      pipeline: run,
    }
    return intelligence
  }
}

/** @deprecated Alias of `PipelineSummaryProvider` (Gemini is the default route). */
export const GeminiSummaryProvider = PipelineSummaryProvider

export type GeminiUsageMetadata = {
  promptTokenCount?: number
  candidatesTokenCount?: number
  totalTokenCount?: number
}

export class GeminiAudioTranscriptionProvider implements TranscriptionProvider {
  readonly id = "gemini"
  readonly model = process.env.GOOGLE_GEMINI_AUDIO_MODEL ?? DEFAULT_GEMINI_AUDIO_MODEL
  private readonly fallback = new HeuristicFallbackProvider()
  private lastUsage: GeminiUsageMetadata | undefined

  /** Token usage of the last successful Gemini call (for cost estimates). */
  getLastUsage(): GeminiUsageMetadata | undefined {
    return this.lastUsage
  }

  async transcribe(meeting: MeetingRecord): Promise<TranscriptSegment[]> {
    const asset = meeting.mediaAssets?.find((item) => item.storageKey)

    if (!isGeminiConfigured() || !asset?.storageKey) {
      return this.fallback.transcribe(meeting)
    }

    let tempDir: string | undefined

    try {
      const ai = createGeminiClient()
      const sizeBytes = Number(asset.sizeBytes ?? 0)
      const inlineLimit = Number(
        process.env.GOOGLE_GEMINI_INLINE_AUDIO_LIMIT_BYTES ?? 18_000_000
      )
      const useInline =
        sizeBytes > 0 ? sizeBytes <= inlineLimit : true
      const prompt = getAudioPrompt(meeting, !useInline)

      if (!useInline && getGeminiProviderMode() === "vertex-ai") {
        throw new Error(
          "Large media on Vertex AI requires a GCS-backed media handoff"
        )
      }

      let mediaPart:
        | { inlineData: { mimeType: string; data: string } }
        | { fileData: { mimeType: string; fileUri: string } }

      if (useInline) {
        const bytes = await getMeetingObjectBytes(asset.storageKey)
        mediaPart = {
          inlineData: {
            mimeType: asset.contentType,
            data: bytes.toString("base64"),
          },
        }
      } else {
        tempDir = await mkdtemp(path.join(tmpdir(), "meetsum-gemini-"))
        const inputPath = path.join(
          tempDir,
          safeTempFilename(asset.filename, `${meeting.id}.media`)
        )
        await downloadMeetingObjectToFile(asset.storageKey, inputPath)

        let uploadPath = inputPath
        let uploadMimeType = asset.contentType

        if (asset.contentType.startsWith("video/")) {
          const audioPath = path.join(tempDir, `${meeting.id}.m4a`)
          await extractAudioForGemini(inputPath, audioPath)
          uploadPath = audioPath
          uploadMimeType = "audio/mp4"
        }

        const compressedInlinePath = path.join(tempDir, `${meeting.id}.inline.m4a`)

        try {
          const uploaded = await ai.files.upload({
            file: uploadPath,
            config: {
              mimeType: uploadMimeType,
              displayName: asset.filename ?? `${meeting.id}-media`,
              httpOptions: getGeminiHttpOptions(),
            },
          })
          await waitForGeminiFile(ai, uploaded.name)
          if (!uploaded.uri) {
            throw new Error("Gemini file upload did not return a file URI")
          }
          mediaPart = {
            fileData: {
              mimeType: uploadMimeType,
              fileUri: uploaded.uri,
            },
          }
        } catch (error) {
          if (!shouldFallbackToCompressedInline(error)) {
            throw error
          }

          await compressMediaForInlineGemini(uploadPath, compressedInlinePath)
          const compressedSize = (await stat(compressedInlinePath)).size

          if (compressedSize > inlineLimit) {
            throw error
          }

          const bytes = await readFile(compressedInlinePath)

          mediaPart = {
            inlineData: {
              mimeType: "audio/mp4",
              data: bytes.toString("base64"),
            },
          }
        }
      }

      const response = await ai.models.generateContent({
        model: process.env.GOOGLE_GEMINI_AUDIO_MODEL ?? DEFAULT_GEMINI_AUDIO_MODEL,
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }, mediaPart],
          },
        ],
        config: {
          httpOptions: getGeminiHttpOptions(),
          maxOutputTokens: Number(
            process.env.GOOGLE_GEMINI_TRANSCRIPT_MAX_OUTPUT_TOKENS ?? 65_536
          ),
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              segments: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    speaker: { type: Type.STRING },
                    startMs: { type: Type.NUMBER },
                    endMs: { type: Type.NUMBER },
                    text: { type: Type.STRING },
                    language: { type: Type.STRING },
                    confidence: { type: Type.NUMBER },
                    uncertainty: { type: Type.BOOLEAN },
                  },
                  required: ["text"],
                },
              },
            },
            required: ["segments"],
          },
        },
      })

      this.lastUsage = response.usageMetadata
        ? {
            promptTokenCount: response.usageMetadata.promptTokenCount,
            candidatesTokenCount: response.usageMetadata.candidatesTokenCount,
            totalTokenCount: response.usageMetadata.totalTokenCount,
          }
        : undefined

      const segments = normalizeGeminiSegments(
        parseGeminiTranscriptSegments(response.text ?? "{}"),
        meeting
      )

      return segments.length ? segments : this.fallback.transcribe(meeting)
    } catch (error) {
      log.error({ err: error }, "Gemini audio transcription failed")
      throw error
    } finally {
      if (typeof tempDir === "string") {
        await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }
}

/** Router result → transcript segments (words, turn index, source `asr`). */
export function asrResultToTranscriptSegments(result: AsrResult): TranscriptSegment[] {
  return result.segments.map((segment) => ({
    id: `seg_${crypto.randomUUID()}`,
    speaker: segment.speaker,
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: segment.text,
    confidence: segment.confidence,
    language: segment.language ?? result.language,
    turnIndex: segment.turnIndex,
    source: "asr",
    words: segment.words.map((word) => ({
      startMs: word.startMs,
      endMs: word.endMs,
      text: word.text,
      ...(word.confidence !== undefined ? { confidence: word.confidence } : {}),
      ...(word.language && word.language !== segment.language ? { language: word.language } : {}),
    })),
  }))
}

/**
 * @deprecated Adapter exposing the M3 ASR router through the legacy
 * TranscriptionProvider interface. New code calls `transcribeWithRouter`
 * (lib/ai/asr) directly and persists words/speakers.
 */
export class AsrRouterTranscriptionProvider implements TranscriptionProvider {
  readonly id = "asr-router"
  readonly model = "asr-router"
  private lastRun: TranscriptionRunMetadata = { provider: "asr-router", model: "asr-router" }
  private readonly fallback = new HeuristicFallbackProvider()

  constructor(private readonly options: AsrRouterOptions & { glossary?: AsrGlossary } = {}) {}

  getLastRun() {
    return this.lastRun
  }

  async transcribe(meeting: MeetingRecord): Promise<TranscriptSegment[]> {
    const asset = meeting.mediaAssets?.find((item) => item.storageKey)

    if (!asset?.storageKey) return this.fallback.transcribe(meeting)

    const result = await transcribeWithRouter(
      {
        meetingId: meeting.id,
        workspaceId: meeting.workspaceId,
        language: meeting.language,
        media: {
          kind: "object",
          storageKey: asset.storageKey,
          contentType: asset.contentType,
          filename: asset.filename,
          sizeBytes: asset.sizeBytes,
        },
        glossary: this.options.glossary ?? DEFAULT_ASR_GLOSSARY,
        diarize: true,
      },
      this.options
    )
    const failed = result.attempts.find((attempt) => !attempt.ok)

    this.lastRun = {
      provider: result.provider,
      model: result.model,
      ...(result.fallbackUsed
        ? {
            fallbackUsed: true,
            attemptedProvider: failed?.provider,
            fallbackReason: failed?.error,
            fallbackElapsedMs: failed?.elapsedMs,
          }
        : {}),
    }

    return asrResultToTranscriptSegments(result)
  }
}

/**
 * @deprecated Use `transcribeWithRouter` from lib/ai/asr. Kept as a thin
 * adapter over the ASR router for callers not yet migrated.
 */
export function createTranscriptionProvider(): TranscriptionProvider {
  return new AsrRouterTranscriptionProvider()
}

/**
 * Summary provider: always the M5 pipeline adapter. The pipeline itself
 * routes (Gemini default, Claude when configured) and falls back to the
 * heuristic V2 summary when no provider is configured or all fail.
 */
export function createSummaryProvider(): SummaryProvider {
  return new PipelineSummaryProvider()
}
