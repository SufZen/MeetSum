import type { MeetingRecord, TranscriptSegment } from "@/lib/meetings/repository"

import { envText, isHebrewLanguage, providerLanguage, type AsrEnv } from "../config"
import { toAsrError } from "../errors"
import { finalizeResult, synthesizeWords } from "../segmentation"
import { AsrError, type AsrHealth, type AsrProvider, type AsrRequest, type AsrResult, type AsrWord } from "../types"
import { roundUsd } from "./shared"

/**
 * Gemini audio as an LLM transcript, kept as a last resort. Only in the
 * chain when `MEETSUM_ASR_ALLOW_GEMINI=true`: it paraphrases, guesses
 * speakers and has no word timings (`llm_transcript`,
 * `synthetic_word_timings`). Object media only.
 */

const PROVIDER = "gemini-legacy" as const

export type GeminiUsage = { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number }

export type GeminiLegacyDeps = {
  env?: AsrEnv
  /** Transcribes a synthetic meeting record; defaults to GeminiAudioTranscriptionProvider. */
  transcribeSegments?: (meeting: MeetingRecord) => Promise<{ segments: TranscriptSegment[]; usage?: GeminiUsage }>
}

export function isGeminiLegacyConfigured(env: AsrEnv = process.env) {
  if (env.GOOGLE_GENAI_USE_VERTEXAI === "true") {
    return Boolean(envText(env, "GOOGLE_CLOUD_PROJECT") && envText(env, "GOOGLE_CLOUD_LOCATION") && envText(env, "GOOGLE_APPLICATION_CREDENTIALS"))
  }

  return Boolean(envText(env, "GOOGLE_GEMINI_API_KEY"))
}

async function defaultTranscribeSegments(meeting: MeetingRecord) {
  const { GeminiAudioTranscriptionProvider } = await import("@/lib/ai/providers")
  const provider = new GeminiAudioTranscriptionProvider()
  const segments = await provider.transcribe(meeting)

  return { segments, usage: provider.getLastUsage() }
}

export function createGeminiLegacyProvider(deps: GeminiLegacyDeps = {}): AsrProvider {
  const env = deps.env ?? process.env
  const model = envText(env, "GOOGLE_GEMINI_AUDIO_MODEL") ?? "gemini-3.5-flash"

  return {
    id: PROVIDER,
    model,
    isConfigured: (value?: NodeJS.ProcessEnv) => isGeminiLegacyConfigured(value ?? env),

    async healthCheck(): Promise<AsrHealth> {
      const configured = isGeminiLegacyConfigured(env)

      return { provider: PROVIDER, configured, healthy: null, detail: { model } }
    },

    async transcribe(req: AsrRequest): Promise<AsrResult> {
      if (!isGeminiLegacyConfigured(env)) {
        throw new AsrError("Gemini is not configured", "config", PROVIDER, false)
      }
      if (req.media.kind !== "object") {
        throw new AsrError("Gemini legacy ASR only accepts stored media", "config", PROVIDER, false)
      }

      const started = Date.now()
      const language = isHebrewLanguage(req.language) ? "he" : providerLanguage(req.language)
      const meetingId = req.meetingId ?? "asr"
      const createdAt = new Date().toISOString()
      const meeting: MeetingRecord = {
        id: meetingId,
        title: req.media.filename ?? "Meeting",
        source: "upload",
        language: req.language,
        status: "transcribing",
        retention: "audio",
        startedAt: createdAt,
        participants: [],
        workspaceId: req.workspaceId,
        mediaAssets: [
          {
            id: "asr_media",
            meetingId,
            storageKey: req.media.storageKey,
            contentType: req.media.contentType,
            filename: req.media.filename,
            sizeBytes: req.media.sizeBytes ?? 0,
            retention: "audio",
            createdAt,
          },
        ],
      }

      let output: { segments: TranscriptSegment[]; usage?: GeminiUsage }

      try {
        output = await (deps.transcribeSegments ?? defaultTranscribeSegments)(meeting)
      } catch (error) {
        throw toAsrError(error, PROVIDER)
      }

      const words: AsrWord[] = output.segments.flatMap((segment) =>
        synthesizeWords(segment.text.replace(/^\[uncertain\]\s*/u, ""), segment.startMs, segment.endMs, {
          ...(segment.speaker ? { speaker: segment.speaker } : {}),
          ...(typeof segment.confidence === "number" ? { confidence: segment.confidence } : {}),
        })
      )
      const tokens =
        output.usage?.totalTokenCount ??
        (output.usage ? (output.usage.promptTokenCount ?? 0) + (output.usage.candidatesTokenCount ?? 0) : undefined)
      const pricePerMTok = Number(env.GOOGLE_GEMINI_AUDIO_PRICE_PER_MTOK)
      const priced = env.GOOGLE_GEMINI_AUDIO_PRICE_PER_MTOK?.trim() && Number.isFinite(pricePerMTok) && tokens !== undefined

      return finalizeResult(
        {
          provider: PROVIDER,
          model,
          language,
          durationMs: 0,
          words,
          diarization: words.some((word) => word.speaker) ? "provider" : "none",
          cost: priced
            ? { usd: roundUsd((tokens / 1_000_000) * pricePerMTok), basis: "tokens", unitPrice: pricePerMTok }
            : { usd: null, basis: tokens !== undefined ? "tokens" : "none" },
          timings: { totalMs: Date.now() - started, ...(tokens !== undefined ? { tokens } : {}) },
          warnings: ["llm_transcript", "synthetic_word_timings"],
        },
        req.glossary
      )
    },
  }
}
