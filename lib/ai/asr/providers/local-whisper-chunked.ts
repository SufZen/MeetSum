import path from "node:path"

import { cutAudioChunk, detectSilences, planChunks, type Chunk } from "../audio"
import { envNumber, envText, isHebrewLanguage, providerLanguage, type AsrEnv } from "../config"
import { throwForResponse, toAsrError } from "../errors"
import { buildHotwords, buildInitialPrompt, hotwordsMaxChars } from "../glossary"
import { guardedFetch, postMultipart, readJson, timeoutSignal, type FetchFn } from "../http"
import { finalizeResult, synthesizeWords } from "../segmentation"
import {
  AsrError,
  type AsrHealth,
  type AsrProvider,
  type AsrRequest,
  type AsrResult,
  type AsrWord,
} from "../types"
import { prepareAudio, readAudio, type AsrProviderDeps } from "./shared"

/**
 * Self-hosted OpenAI-compatible faster-whisper server
 * (docs/runbooks/laptop-hebrew-asr/app.py). Long audio is cut at silences
 * into ≤ 10 min chunks transcribed sequentially (one retry each) and
 * re-offset. No diarization: everything is Speaker 1 with a warning.
 */

const PROVIDER = "local-whisper-chunked" as const
const DEFAULT_MODEL = "ivrit-ai/whisper-large-v3-turbo-ct2"

export type LocalChunkedConfig = {
  baseUrl: string
  model: string
  language?: string
  timeoutMs: number
  chunkMs: number
  searchMs: number
}

export function getLocalChunkedConfig(env: AsrEnv = process.env): LocalChunkedConfig {
  return {
    baseUrl: (envText(env, "LOCAL_TRANSCRIPTION_URL") ?? "").replace(/\/+$/, ""),
    model: envText(env, "LOCAL_TRANSCRIPTION_MODEL") ?? DEFAULT_MODEL,
    language: envText(env, "LOCAL_TRANSCRIPTION_LANGUAGE"),
    timeoutMs: envNumber(env, "LOCAL_TRANSCRIPTION_TIMEOUT_MS", 900_000),
    chunkMs: envNumber(env, "LOCAL_TRANSCRIPTION_CHUNK_MS", 600_000),
    searchMs: envNumber(env, "LOCAL_TRANSCRIPTION_CHUNK_SEARCH_MS", 60_000),
  }
}

export function isLocalChunkedConfigured(env: AsrEnv = process.env) {
  return Boolean(envText(env, "LOCAL_TRANSCRIPTION_URL"))
}

type WhisperWord = { word?: string; text?: string; start?: number; end?: number; probability?: number }
type WhisperSegment = { start?: number; end?: number; text?: string; words?: WhisperWord[]; avg_logprob?: number }
type WhisperResponse = { text?: string; language?: string; duration?: number; segments?: WhisperSegment[]; words?: WhisperWord[] }

function toMs(seconds: unknown) {
  const value = Number(seconds)

  return Number.isFinite(value) ? Math.round(value * 1000) : 0
}

function convertWords(words: WhisperWord[], offsetMs: number): AsrWord[] {
  return words
    .map((raw) => {
      const text = (raw.word ?? raw.text ?? "").trim()

      if (!text) return undefined

      const word: AsrWord = {
        startMs: offsetMs + toMs(raw.start),
        endMs: offsetMs + toMs(raw.end ?? raw.start),
        text,
      }

      if (typeof raw.probability === "number" && Number.isFinite(raw.probability)) word.confidence = raw.probability
      return word
    })
    .filter((word): word is AsrWord => Boolean(word))
}

/**
 * Words of one chunk response, offset by the chunk start. Prefers
 * top-level `words` (OpenAI verbose_json), then per-segment words, then
 * synthesizes timings from segment (or whole-text) spans.
 */
export function parseWhisperChunk(
  raw: WhisperResponse | string,
  chunk: Chunk
): { words: AsrWord[]; synthetic: boolean; language?: string } {
  const parsed: WhisperResponse =
    typeof raw === "string" ? (raw.trim().startsWith("{") ? JSON.parse(raw) : { text: raw }) : raw
  const offset = chunk.startMs

  if (Array.isArray(parsed.words) && parsed.words.length) {
    return { words: convertWords(parsed.words, offset), synthetic: false, language: parsed.language }
  }

  const segments = Array.isArray(parsed.segments) ? parsed.segments : []

  if (segments.some((segment) => segment.words?.length)) {
    return {
      words: segments.flatMap((segment) => convertWords(segment.words ?? [], offset)),
      synthetic: false,
      language: parsed.language,
    }
  }

  if (segments.length) {
    return {
      words: segments.flatMap((segment) =>
        synthesizeWords(segment.text ?? "", offset + toMs(segment.start), offset + toMs(segment.end ?? segment.start))
      ),
      synthetic: true,
      language: parsed.language,
    }
  }

  return {
    words: parsed.text?.trim() ? synthesizeWords(parsed.text, chunk.startMs, chunk.endMs) : [],
    synthetic: Boolean(parsed.text?.trim()),
    language: parsed.language,
  }
}

export function createLocalWhisperChunkedProvider(deps: AsrProviderDeps = {}): AsrProvider {
  const env = deps.env ?? process.env
  const config = getLocalChunkedConfig(env)
  const now = deps.now ?? Date.now

  async function transcribeChunk(
    file: string,
    chunk: Chunk,
    req: AsrRequest,
    fields: Array<[string, string]>
  ): Promise<WhisperResponse | string> {
    const bytes = await readAudio(deps, file)
    const { signal, dispose } = timeoutSignal(config.timeoutMs, req.signal)

    try {
      const response = await postMultipart(
        `${config.baseUrl}/v1/audio/transcriptions`,
        [["file", { blob: new Blob([new Uint8Array(bytes)], { type: "audio/ogg" }), filename: path.basename(file) }], ...fields],
        { fetch: deps.fetch, signal }
      )

      if (!response.ok) await throwForResponse(response, PROVIDER, `Local Whisper chunk ${chunk.startMs}ms`)

      const contentType = response.headers.get("content-type") ?? ""

      return contentType.includes("application/json")
        ? await readJson<WhisperResponse>(response, PROVIDER, "Local Whisper")
        : await response.text()
    } catch (error) {
      throw toAsrError(error, PROVIDER)
    } finally {
      dispose()
    }
  }

  return {
    id: PROVIDER,
    model: config.model,
    isConfigured: (value?: NodeJS.ProcessEnv) => isLocalChunkedConfigured(value ?? env),

    async healthCheck(): Promise<AsrHealth> {
      if (!isLocalChunkedConfigured(env)) return { provider: PROVIDER, configured: false, healthy: null }

      try {
        const fetchFn: FetchFn = deps.fetch ?? globalThis.fetch
        const response = await guardedFetch(fetchFn, PROVIDER, `${config.baseUrl}/v1/models`)

        return response.ok
          ? { provider: PROVIDER, configured: true, healthy: true, detail: { model: config.model } }
          : { provider: PROVIDER, configured: true, healthy: false, lastError: `HTTP ${response.status}` }
      } catch (error) {
        return {
          provider: PROVIDER,
          configured: true,
          healthy: false,
          lastError: error instanceof Error ? error.message : String(error),
        }
      }
    },

    async transcribe(req: AsrRequest): Promise<AsrResult> {
      if (!isLocalChunkedConfigured(env)) {
        throw new AsrError("LOCAL_TRANSCRIPTION_URL is required for local Whisper", "config", PROVIDER, false)
      }

      const started = now()
      const audio = await prepareAudio(req, PROVIDER, deps)

      try {
        const planStarted = now()
        const silences =
          audio.durationMs > config.chunkMs
            ? await detectSilences(audio.audioPath, { execFile: deps.execFile, env, provider: PROVIDER })
            : []
        const chunks = planChunks(audio.durationMs, silences, { maxMs: config.chunkMs, searchMs: config.searchMs })
        const planMs = now() - planStarted
        const language = config.language ?? providerLanguage(req.language)
        const hotwords = buildHotwords(req.glossary, { maxChars: hotwordsMaxChars(env) })
        const prompt = buildInitialPrompt(req.glossary, env)
        const fields: Array<[string, string]> = [
          ["model", config.model],
          ["language", language],
          ["response_format", "verbose_json"],
          ["timestamp_granularities[]", "word"],
          ["timestamp_granularities[]", "segment"],
          ...(hotwords ? ([["hotwords", hotwords]] as Array<[string, string]>) : []),
          ...(prompt ? ([["prompt", prompt]] as Array<[string, string]>) : []),
        ]
        const words: AsrWord[] = []
        let synthetic = false
        let retries = 0
        const transcribeStarted = now()

        for (const [index, chunk] of chunks.entries()) {
          const file =
            chunks.length === 1
              ? audio.audioPath
              : await cutAudioChunk(audio.audioPath, path.join(audio.dir, `chunk-${index}.ogg`), chunk, {
                  execFile: deps.execFile,
                  env,
                  provider: PROVIDER,
                })
          let raw: WhisperResponse | string

          try {
            raw = await transcribeChunk(file, chunk, req, fields)
          } catch (error) {
            const asrError = toAsrError(error, PROVIDER)

            if (asrError.kind === "bad_input" || asrError.kind === "auth" || req.signal?.aborted) throw asrError
            retries += 1
            raw = await transcribeChunk(file, chunk, req, fields)
          }

          const parsed = parseWhisperChunk(raw, chunk)

          synthetic ||= parsed.synthetic
          words.push(...parsed.words)
        }

        const warnings = ["diarization_unavailable"]

        if (synthetic) warnings.push("synthetic_word_timings")

        return finalizeResult(
          {
            provider: PROVIDER,
            model: config.model,
            language: isHebrewLanguage(req.language) ? "he" : language,
            durationMs: audio.durationMs,
            words,
            diarization: "none",
            cost: { usd: 0, basis: "none" },
            timings: {
              ...audio.timings,
              planMs,
              transcribeMs: now() - transcribeStarted,
              chunks: chunks.length,
              chunkRetries: retries,
              totalMs: now() - started,
            },
            warnings,
          },
          req.glossary
        )
      } finally {
        await audio.cleanup()
      }
    },
  }
}
