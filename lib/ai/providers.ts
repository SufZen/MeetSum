import { GoogleGenAI, Type } from "@google/genai"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import {
  fetch as undiciFetch,
  Agent as UndiciAgent,
  FormData as UndiciFormData,
} from "undici"

import {
  buildMeetingIntelligence,
  cleanupTranscriptSegments,
  type SmartTask,
} from "@/lib/intelligence"

// Long-running local ASR can hold a connection open for many minutes while the
// model transcribes, sending zero bytes until the final JSON. Two things break
// that otherwise:
//   1. Node's built-in fetch (undici) defaults headersTimeout/bodyTimeout to
//      300s, aborting real transcriptions with a generic "fetch failed" long
//      before our own AbortController fires. We disable both here; the
//      AbortController (LOCAL_TRANSCRIPTION_TIMEOUT_MS) remains the real cap.
//   2. A silent, idle TCP connection is reset by stateful firewalls/NAT after
//      ~5 minutes (observed: ECONNRESET at ~300s). TCP keepalive probes keep
//      the socket non-idle so the connection survives a long transcription.
const longAsrDispatcher = new UndiciAgent({
  headersTimeout: 0,
  bodyTimeout: 0,
  connect: { keepAlive: true, keepAliveInitialDelay: 30_000 },
})
import type {
  MeetingRecord,
  TranscriptSegment,
} from "@/lib/meetings/repository"
import {
  downloadMeetingObjectToFile,
  getMeetingObjectBytes,
} from "@/lib/storage/object-storage"
import { getAppSettings } from "@/lib/settings/app-settings"
import { getSummaryTemplatePrompt, type SummaryTemplate } from "@/lib/ai/summary-templates"

const execFileAsync = promisify(execFile)

export type TranscriptionProvider = {
  id: string
  model: string
  transcribe: (meeting: MeetingRecord) => Promise<TranscriptSegment[]>
  getLastRun?: () => TranscriptionRunMetadata
}

export type SummaryProvider = {
  summarize: (meeting: MeetingRecord) => Promise<ReturnType<typeof buildMeetingIntelligence>>
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

function shouldPreferLocalHebrewAsr(meeting: MeetingRecord) {
  const language = meeting.language.toLowerCase()

  return language === "he" || language === "heb" || language === "iw" || language === "mixed"
}

function inferSpeaker(participant: string | undefined, index: number) {
  return participant || `Speaker ${index + 1}`
}

export type GeminiProviderMode = "gemini-developer-api" | "vertex-ai"

export function getGeminiProviderMode(): GeminiProviderMode {
  return process.env.GOOGLE_GENAI_USE_VERTEXAI === "true"
    ? "vertex-ai"
    : "gemini-developer-api"
}

export function isGeminiConfigured() {
  if (getGeminiProviderMode() === "vertex-ai") {
    return Boolean(
      process.env.GOOGLE_CLOUD_PROJECT &&
        process.env.GOOGLE_CLOUD_LOCATION &&
        process.env.GOOGLE_APPLICATION_CREDENTIALS
    )
  }

  return Boolean(process.env.GOOGLE_GEMINI_API_KEY)
}

function getGeminiHttpOptions() {
  return {
    timeout: Number(process.env.GOOGLE_GEMINI_HTTP_TIMEOUT_MS ?? 900_000),
  }
}

export function createGeminiClient() {
  if (getGeminiProviderMode() === "vertex-ai") {
    return new GoogleGenAI({
      vertexai: true,
      project: process.env.GOOGLE_CLOUD_PROJECT,
      location: process.env.GOOGLE_CLOUD_LOCATION ?? "global",
      httpOptions: getGeminiHttpOptions(),
    })
  }

  return new GoogleGenAI({
    apiKey: process.env.GOOGLE_GEMINI_API_KEY,
    httpOptions: getGeminiHttpOptions(),
  })
}

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
      speaker: segment.speaker?.trim() || inferSpeaker(meeting.participants[index], index),
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

type LocalWhisperSegment = {
  id?: number | string
  start?: number
  end?: number
  startMs?: number
  endMs?: number
  text?: string
  language?: string
  confidence?: number
  speaker?: string
}

type LocalWhisperResponse = {
  text?: string
  language?: string
  segments?: LocalWhisperSegment[]
}

function normalizeConfidence(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : fallback
}

export function normalizeLocalWhisperResponse(
  raw: string | LocalWhisperResponse,
  meeting: MeetingRecord
): TranscriptSegment[] {
  const parsed =
    typeof raw === "string"
      ? raw.trim().startsWith("{")
        ? (JSON.parse(raw) as LocalWhisperResponse)
        : ({ text: raw } satisfies LocalWhisperResponse)
      : raw
  const responseLanguage = parsed.language ?? meeting.language
  const segments = Array.isArray(parsed.segments) ? parsed.segments : []

  if (segments.length) {
    return cleanupTranscriptSegments(
      segments
        .filter((segment) => segment.text?.trim())
        .map((segment, index) => {
          const startMs =
            typeof segment.startMs === "number"
              ? segment.startMs
              : Math.round(Number(segment.start ?? index * 5) * 1000)
          const endMs =
            typeof segment.endMs === "number"
              ? segment.endMs
              : Math.round(Number(segment.end ?? index * 5 + 5) * 1000)

          return {
            id: `seg_${crypto.randomUUID()}`,
            speaker: segment.speaker?.trim() || inferSpeaker(undefined, index),
            startMs: Math.max(0, startMs),
            endMs: Math.max(startMs + 1000, endMs),
            text: segment.text?.trim() ?? "",
            confidence: normalizeConfidence(segment.confidence, 0.72),
            language: segment.language ?? responseLanguage,
          }
        })
    )
  }

  const text = parsed.text?.trim()
  if (!text) return []

  return cleanupTranscriptSegments([
    {
      id: `seg_${crypto.randomUUID()}`,
      speaker: inferSpeaker(undefined, 0),
      startMs: 0,
      endMs: 5000,
      text,
      confidence: 0.72,
      language: responseLanguage,
    },
  ])
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

/**
 * Thrown when no transcription provider can produce a real transcript, so the
 * job fails honestly instead of persisting fabricated placeholder text.
 */
export class TranscriptionUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TranscriptionUnavailableError"
  }
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

  async summarize(meeting: MeetingRecord) {
    return buildMeetingIntelligence(meeting)
  }
}

export class LocalWhisperTranscriptionProvider implements TranscriptionProvider {
  readonly id = "local-whisper"
  readonly model: string
  private readonly fallback = new HeuristicFallbackProvider()
  private lastDiagnostic: WhisperDiagnostic | undefined

  constructor(
    private readonly config = getLocalWhisperProviderConfig(),
    private readonly options: {
      fetch?: typeof fetch
      downloadMeetingObjectToFile?: typeof downloadMeetingObjectToFile
    } = {}
  ) {
    this.model = config.model
  }

  getLastDiagnostic() {
    return this.lastDiagnostic
  }

  async transcribe(meeting: MeetingRecord): Promise<TranscriptSegment[]> {
    const asset = meeting.mediaAssets?.find((item) => item.storageKey)
    const startTime = Date.now()

    if (!this.config.baseUrl) {
      this.lastDiagnostic = {
        success: false,
        error: "LOCAL_TRANSCRIPTION_URL is required for local Whisper",
        errorCategory: "config",
        elapsedMs: 0,
      }
      throw new Error("LOCAL_TRANSCRIPTION_URL is required for local Whisper")
    }

    if (!asset?.storageKey) {
      this.lastDiagnostic = {
        success: false,
        error: "No media asset found",
        errorCategory: "no_media",
        elapsedMs: 0,
      }
      return this.fallback.transcribe(meeting)
    }

    let tempDir: string | undefined

    try {
      tempDir = await mkdtemp(path.join(tmpdir(), "meetsum-whisper-"))
      const inputPath = path.join(
        tempDir,
        safeTempFilename(asset.filename, `${meeting.id}.media`)
      )
      await (this.options.downloadMeetingObjectToFile ?? downloadMeetingObjectToFile)(
        asset.storageKey,
        inputPath
      )

      const bytes = await readFile(inputPath)
      const fileSizeBytes = bytes.length
      console.log(
        `[LocalWhisper] Starting transcription for ${meeting.id}`,
        `file=${asset.filename} size=${(fileSizeBytes / 1024 / 1024).toFixed(1)}MB`,
        `model=${this.config.model} lang=${this.config.language || meeting.language}`,
        `timeout=${this.config.timeoutMs}ms`
      )

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs)

      try {
        const transcribeUrl = `${this.config.baseUrl}/v1/audio/transcriptions`
        let response: Response

        if (this.options.fetch) {
          // Test-injected fetch: use the global FormData/Blob.
          const formData = new FormData()
          formData.set(
            "file",
            new Blob([new Uint8Array(bytes)], { type: asset.contentType }),
            asset.filename
          )
          formData.set("model", this.config.model)
          formData.set("language", this.config.language || meeting.language)
          formData.set("response_format", "verbose_json")
          response = await this.options.fetch(transcribeUrl, {
            method: "POST",
            body: formData,
            signal: controller.signal,
          })
        } else {
          // Real path: build the multipart with undici's OWN FormData/File so
          // undici's fetch serializes it. A global FormData is not recognized by
          // the installed undici and serializes to an empty body (HTTP 422).
          const form = new UndiciFormData()
          form.set(
            "file",
            new Blob([new Uint8Array(bytes)], { type: asset.contentType }),
            asset.filename ?? `${meeting.id}.media`
          )
          form.set("model", this.config.model)
          form.set("language", this.config.language || meeting.language)
          form.set("response_format", "verbose_json")
          response = (await undiciFetch(transcribeUrl, {
            method: "POST",
            body: form,
            signal: controller.signal,
            dispatcher: longAsrDispatcher,
          })) as unknown as Response
        }

        const elapsedMs = Date.now() - startTime

        if (!response.ok) {
          const body = await response.text().catch(() => "")
          const error = `Local Whisper transcription failed with ${response.status}: ${body}`
          console.error(`[LocalWhisper] Failed after ${elapsedMs}ms:`, error)
          this.lastDiagnostic = {
            success: false,
            error,
            errorCategory: response.status >= 500 ? "server_error" : "client_error",
            httpStatus: response.status,
            elapsedMs,
            fileSizeBytes,
          }
          throw new Error(error)
        }

        const contentType = response.headers.get("content-type") ?? ""
        const raw = contentType.includes("application/json")
          ? ((await response.json()) as LocalWhisperResponse)
          : await response.text()
        const segments = normalizeLocalWhisperResponse(raw, meeting)

        console.log(
          `[LocalWhisper] Completed in ${elapsedMs}ms:`,
          `segments=${segments.length}`,
          `meeting=${meeting.id}`
        )

        this.lastDiagnostic = {
          success: segments.length > 0,
          elapsedMs,
          segmentCount: segments.length,
          fileSizeBytes,
        }

        return segments.length ? segments : this.fallback.transcribe(meeting)
      } finally {
        clearTimeout(timeout)
      }
    } catch (error) {
      const elapsedMs = Date.now() - startTime

      if (!this.lastDiagnostic || this.lastDiagnostic.elapsedMs === 0) {
        const message = error instanceof Error ? error.message : String(error)
        this.lastDiagnostic = {
          success: false,
          error: message,
          errorCategory: classifyWhisperError(error),
          elapsedMs,
        }
      }

      throw error
    } finally {
      if (typeof tempDir === "string") {
        await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }
}

export class AutoTranscriptionProvider implements TranscriptionProvider {
  readonly id = "auto"
  readonly model: string
  private lastRun: TranscriptionRunMetadata

  constructor(
    private readonly primary: TranscriptionProvider,
    private readonly fallback: TranscriptionProvider
  ) {
    this.model = primary.model
    this.lastRun = {
      provider: primary.id,
      model: primary.model,
    }
  }

  async transcribe(meeting: MeetingRecord): Promise<TranscriptSegment[]> {
    if (!shouldPreferLocalHebrewAsr(meeting)) {
      const segments = await this.fallback.transcribe(meeting)
      const fallbackRun = getTranscriptionRunMetadata(this.fallback)
      this.lastRun = {
        ...fallbackRun,
        fallbackUsed: false,
      }
      return segments
    }

    const startTime = Date.now()
    try {
      const segments = await this.primary.transcribe(meeting)
      this.lastRun = getTranscriptionRunMetadata(this.primary)
      return segments
    } catch (error) {
      const elapsedMs = Date.now() - startTime
      const errorCategory = classifyWhisperError(error)
      const fallbackReason = error instanceof Error ? error.message : String(error)
      console.error(
        `[AutoTranscriptionProvider] Primary provider '${this.primary.id}' failed after ${elapsedMs}ms`,
        `category=${errorCategory}`,
        `falling back to '${this.fallback.id}':`,
        error
      )
      
      const segments = await this.fallback.transcribe(meeting)
      const fallbackRun = getTranscriptionRunMetadata(this.fallback)
      this.lastRun = {
        ...fallbackRun,
        fallbackUsed: true,
        attemptedProvider: this.primary.id,
        fallbackReason,
        fallbackCategory: errorCategory,
        fallbackElapsedMs: elapsedMs,
      }
      return segments
    }
  }

  getLastRun() {
    return this.lastRun
  }
}

export class GeminiSummaryProvider implements SummaryProvider {
  private readonly fallback = new HeuristicFallbackProvider()

  private async getTemplateAddendum(): Promise<string[]> {
    try {
      const settings = await getAppSettings()
      const template = (settings.summaryTemplate ?? "general") as SummaryTemplate
      const addendum = getSummaryTemplatePrompt(template)

      return addendum ? [addendum] : []
    } catch {
      return []
    }
  }

  async summarize(meeting: MeetingRecord) {
    if (!isGeminiConfigured() || !meeting.transcript?.length) {
      return this.fallback.summarize(meeting)
    }

    const ai = createGeminiClient()
    const transcript = meeting.transcript
      .map(
        (segment) =>
          `[${Math.floor(segment.startMs / 1000)}s] ${segment.speaker}: ${segment.text}`
      )
      .join("\n")
    const response = await ai.models.generateContent({
      model: process.env.GOOGLE_GEMINI_SUMMARY_MODEL ?? "gemini-3.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            {
              text: [
                "Create structured meeting intelligence as JSON.",
                "Support Hebrew, English, Portuguese, Spanish, Italian, and mixed-language meetings.",
                "Do not invent details; mark uncertainty in the text when needed.",
                "Action items must be real tasks only: commitments, assignments, next steps, decisions requiring follow-up, or explicit requests. Do not copy ordinary transcript fragments as tasks.",
                "For every action item, include title, owner if known, dueDate if stated or strongly implied, priority, confidence, sourceQuote, sourceStartMs, and kind explicit/inferred.",
                "Decisions should be concise business decisions and should not include generic discussion.",
                ...(await this.getTemplateAddendum()),
                `Meeting: ${meeting.title}`,
                transcript,
              ].join("\n\n"),
            },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            overview: { type: Type.STRING },
            decisions: { type: Type.ARRAY, items: { type: Type.STRING } },
            actionItems: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  owner: { type: Type.STRING },
                  dueDate: { type: Type.STRING },
                  priority: { type: Type.STRING },
                  confidence: { type: Type.NUMBER },
                  sourceQuote: { type: Type.STRING },
                  sourceStartMs: { type: Type.NUMBER },
                  kind: { type: Type.STRING },
                },
                required: ["title"],
              },
            },
            risks: { type: Type.ARRAY, items: { type: Type.STRING } },
            openQuestions: { type: Type.ARRAY, items: { type: Type.STRING } },
            commitments: { type: Type.ARRAY, items: { type: Type.STRING } },
            followUpDraft: { type: Type.STRING },
            tags: { type: Type.ARRAY, items: { type: Type.STRING } },
          },
          required: ["overview"],
        },
      },
    })

    try {
      const parsed = JSON.parse(response.text ?? "{}") as Partial<
        ReturnType<typeof buildMeetingIntelligence>
      >
      const fallback = buildMeetingIntelligence(meeting)
      const parsedActionItems: SmartTask[] = Array.isArray(parsed.actionItems)
        ? parsed.actionItems
            .filter((item) => item?.title && String(item.title).trim().length > 0)
            .slice(0, 20)
            .map((item, index) => {
              const priority: SmartTask["priority"] =
                item.priority === "low" ||
                item.priority === "high" ||
                item.priority === "urgent"
                  ? item.priority
                  : "normal"
              const kind: SmartTask["kind"] =
                item.kind === "inferred" ? "inferred" : "explicit"

              return {
                id: item.id ?? `task_${crypto.randomUUID()}_${index}`,
                title: String(item.title).trim(),
                owner: item.owner ? String(item.owner) : undefined,
                status: item.status === "done" ? "done" : "open",
                dueDate: item.dueDate ? String(item.dueDate) : undefined,
                priority,
                confidence:
                typeof item.confidence === "number"
                  ? Math.min(1, Math.max(0, item.confidence))
                  : 0.75,
                sourceQuote: item.sourceQuote
                  ? String(item.sourceQuote)
                  : String(item.title),
                sourceStartMs:
                  typeof item.sourceStartMs === "number" ? item.sourceStartMs : 0,
                kind,
              }
            })
        : fallback.actionItems

      return {
        ...fallback,
        overview: parsed.overview ?? fallback.overview,
        decisions: parsed.decisions ?? fallback.decisions,
        actionItems: parsedActionItems,
        risks: parsed.risks ?? fallback.risks,
        openQuestions: parsed.openQuestions ?? fallback.openQuestions,
        commitments: parsed.commitments ?? fallback.commitments,
        followUpDraft: parsed.followUpDraft ?? fallback.followUpDraft,
        tags: parsed.tags ?? fallback.tags,
      }
    } catch {
      return this.fallback.summarize(meeting)
    }
  }
}

export class GeminiAudioTranscriptionProvider implements TranscriptionProvider {
  readonly id = "gemini"
  readonly model = process.env.GOOGLE_GEMINI_AUDIO_MODEL ?? "gemini-3.5-flash"
  private readonly fallback = new HeuristicFallbackProvider()

  async transcribe(meeting: MeetingRecord): Promise<TranscriptSegment[]> {
    const asset = meeting.mediaAssets?.[0]

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
        model: process.env.GOOGLE_GEMINI_AUDIO_MODEL ?? "gemini-3.5-flash",
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

      const segments = normalizeGeminiSegments(
        parseGeminiTranscriptSegments(response.text ?? "{}"),
        meeting
      )

      return segments.length ? segments : this.fallback.transcribe(meeting)
    } catch (error) {
      console.error("Gemini audio transcription failed", error)
      throw error
    } finally {
      if (typeof tempDir === "string") {
        await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }
}

export function createTranscriptionProvider(): TranscriptionProvider {
  const mode = getTranscriptionProviderMode()
  const geminiProvider = isGeminiConfigured()
    ? new GeminiAudioTranscriptionProvider()
    : new HeuristicFallbackProvider()

  if (mode === "local-whisper" && isLocalWhisperConfigured()) {
    return new LocalWhisperTranscriptionProvider()
  }

  if (mode === "auto" && isLocalWhisperConfigured()) {
    return new AutoTranscriptionProvider(
      new LocalWhisperTranscriptionProvider(),
      geminiProvider
    )
  }

  return geminiProvider
}

export function createSummaryProvider(): SummaryProvider {
  return isGeminiConfigured()
    ? new GeminiSummaryProvider()
    : new HeuristicFallbackProvider()
}
