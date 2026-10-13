import { envNumber, envText, isHebrewLanguage, providerLanguage, type AsrEnv } from "../config"
import { throwForResponse } from "../errors"
import { hotwordTerms } from "../glossary"
import { guardedFetch, postMultipart, readJson, sleep, type FetchFn } from "../http"
import { finalizeResult } from "../segmentation"
import {
  AsrError,
  type AsrHealth,
  type AsrProvider,
  type AsrRequest,
  type AsrResult,
  type AsrWord,
} from "../types"
import { prepareAudio, readAudio, roundUsd, type AsrProviderDeps } from "./shared"

/**
 * Soniox async STT (`stt-async-v3`): upload file → create transcription
 * (Hebrew/English hints, diarization, language identification, glossary as
 * context terms) → poll → fetch tokens → always delete transcription + file.
 *
 * Field names follow the public v1 REST docs; fixtures are synthetic and
 * must be re-recorded against the live API when a key is available.
 */

const PROVIDER = "soniox" as const
const DEFAULT_BASE_URL = "https://api.soniox.com"
const DEFAULT_MODEL = "stt-async-v3"
const DEFAULT_TIMEOUT_MS = 1_800_000
const DEFAULT_PRICE_PER_HOUR = 0.1
const POLL_START_MS = 2000
const POLL_MAX_MS = 10_000

export type SonioxConfig = {
  apiKey: string
  baseUrl: string
  model: string
  timeoutMs: number
  pricePerHour: number
}

export function getSonioxConfig(env: AsrEnv = process.env): SonioxConfig {
  const price = Number(env.SONIOX_PRICE_PER_HOUR)

  return {
    apiKey: envText(env, "SONIOX_API_KEY") ?? "",
    baseUrl: (envText(env, "SONIOX_API_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    model: envText(env, "SONIOX_MODEL") ?? DEFAULT_MODEL,
    timeoutMs: envNumber(env, "SONIOX_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    pricePerHour: env.SONIOX_PRICE_PER_HOUR?.trim() && Number.isFinite(price) ? price : DEFAULT_PRICE_PER_HOUR,
  }
}

export function isSonioxConfigured(env: AsrEnv = process.env) {
  return Boolean(envText(env, "SONIOX_API_KEY"))
}

export type SonioxToken = {
  text: string
  start_ms?: number
  end_ms?: number
  confidence?: number
  speaker?: string | number | null
  language?: string | null
  translation_status?: string
}

const SPECIAL_TOKEN = /^<[^>]+>$/u
const PUNCT_ONLY = /^[\p{P}\p{S}]+$/u

/**
 * Assembles Soniox sub-word tokens into words: a token with a leading space
 * starts a new word, others (and punctuation) attach to the current word.
 * Words carry the first token's speaker/language and the mean confidence.
 */
export function tokensToWords(tokens: SonioxToken[]): AsrWord[] {
  const words: AsrWord[] = []
  let current: { word: AsrWord; confidences: number[] } | undefined

  const flush = () => {
    if (!current) return

    const text = current.word.text.trim()

    if (text) {
      if (current.confidences.length) {
        current.word.confidence =
          current.confidences.reduce((sum, value) => sum + value, 0) / current.confidences.length
      }
      words.push({ ...current.word, text })
    }
    current = undefined
  }

  for (const token of tokens) {
    if (typeof token.text !== "string" || SPECIAL_TOKEN.test(token.text.trim())) continue
    if (token.translation_status === "translation") continue

    const startsWord = !current || /^\s/u.test(token.text)
    const trimmed = token.text.trim()

    if (!trimmed) {
      // A bare space: the next token starts a new word.
      flush()
      continue
    }

    if (startsWord && !(current && PUNCT_ONLY.test(trimmed) && !/^\s/u.test(token.text))) {
      flush()

      const word: AsrWord = {
        startMs: Number(token.start_ms ?? 0),
        endMs: Number(token.end_ms ?? token.start_ms ?? 0),
        text: trimmed,
      }

      if (token.speaker !== undefined && token.speaker !== null && token.speaker !== "") {
        word.speaker = String(token.speaker)
      }
      if (token.language) word.language = token.language
      current = { word, confidences: typeof token.confidence === "number" ? [token.confidence] : [] }
      continue
    }

    if (!current) continue
    current.word.text += trimmed
    current.word.endMs = Math.max(current.word.endMs, Number(token.end_ms ?? current.word.endMs))
    if (typeof token.confidence === "number") current.confidences.push(token.confidence)
  }

  flush()
  return words
}

type SonioxTranscription = { id?: string; status?: string; error_message?: string | null; audio_duration_ms?: number }

export function createSonioxProvider(deps: AsrProviderDeps = {}): AsrProvider {
  const env = deps.env ?? process.env
  const config = getSonioxConfig(env)
  const now = deps.now ?? Date.now
  const wait = deps.sleep ?? sleep
  const fetchFn = (): FetchFn => deps.fetch ?? globalThis.fetch
  const auth = () => ({ Authorization: `Bearer ${config.apiKey}` })
  const url = (path: string) => `${config.baseUrl}${path}`

  async function request<T>(path: string, init: RequestInit, context: string): Promise<T> {
    const response = await guardedFetch(fetchFn(), PROVIDER, url(path), {
      ...init,
      headers: { ...auth(), ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
    })

    if (!response.ok) await throwForResponse(response, PROVIDER, context)
    return readJson<T>(response, PROVIDER, context)
  }

  async function remove(path: string) {
    await fetchFn()(url(path), { method: "DELETE", headers: auth() }).catch(() => undefined)
  }

  return {
    id: PROVIDER,
    model: config.model,
    isConfigured: (value?: NodeJS.ProcessEnv) => isSonioxConfigured(value ?? env),

    async healthCheck(): Promise<AsrHealth> {
      if (!isSonioxConfigured(env)) return { provider: PROVIDER, configured: false, healthy: null }

      try {
        const response = await guardedFetch(fetchFn(), PROVIDER, url("/v1/models"), { headers: auth() })

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
      if (!isSonioxConfigured(env)) {
        throw new AsrError("Soniox is not configured (SONIOX_API_KEY)", "config", PROVIDER, false)
      }

      const started = now()
      const audio = await prepareAudio(req, PROVIDER, deps)
      let fileId: string | undefined
      let transcriptionId: string | undefined

      try {
        const uploadStarted = now()
        const bytes = await readAudio(deps, audio.audioPath)
        const uploadResponse = await postMultipart(
          url("/v1/files"),
          [["file", { blob: new Blob([new Uint8Array(bytes)], { type: "audio/ogg" }), filename: "meeting.ogg" }]],
          { fetch: deps.fetch, headers: auth(), signal: req.signal }
        ).catch((error: unknown) => {
          throw error instanceof AsrError ? error : new AsrError(String(error), "server", PROVIDER, true)
        })

        if (!uploadResponse.ok) await throwForResponse(uploadResponse, PROVIDER, "Soniox file upload")

        const uploaded = await readJson<{ id?: string; file_id?: string }>(uploadResponse, PROVIDER, "Soniox file upload")

        fileId = uploaded.id ?? uploaded.file_id
        if (!fileId) throw new AsrError("Soniox upload returned no file id", "server", PROVIDER, true)

        const uploadMs = now() - uploadStarted
        const language = providerLanguage(req.language)
        const hints = isHebrewLanguage(req.language) ? ["he", "en"] : [...new Set([language, "en"])]
        const terms = hotwordTerms(req.glossary, { maxChars: 8000 })
        const created = await request<SonioxTranscription>(
          "/v1/transcriptions",
          {
            method: "POST",
            body: JSON.stringify({
              model: config.model,
              file_id: fileId,
              language_hints: hints,
              enable_speaker_diarization: req.diarize,
              enable_language_identification: true,
              ...(terms.length ? { context: { terms } } : {}),
            }),
            signal: req.signal,
          },
          "Soniox create transcription"
        )

        transcriptionId = created.id
        if (!transcriptionId) throw new AsrError("Soniox returned no transcription id", "server", PROVIDER, true)

        const processingStarted = now()
        const deadline = processingStarted + config.timeoutMs
        let interval = POLL_START_MS
        let status = created

        while (status.status !== "completed") {
          if (status.status === "error") {
            const message = status.error_message ?? "Soniox transcription failed"
            const badInput = /audio|decode|format|unsupported|invalid file|corrupt/i.test(message)

            throw new AsrError(`Soniox: ${message}`, badInput ? "bad_input" : "server", PROVIDER, !badInput)
          }
          if (req.signal?.aborted) throw new AsrError("Soniox transcription aborted", "timeout", PROVIDER, false)
          if (now() >= deadline) {
            throw new AsrError(`Soniox transcription timed out after ${config.timeoutMs}ms`, "timeout", PROVIDER, true)
          }

          try {
            await wait(Math.max(0, Math.min(interval, deadline - now())), req.signal)
          } catch {
            throw new AsrError("Soniox transcription aborted", "timeout", PROVIDER, false)
          }
          interval = Math.min(Math.round(interval * 1.5), POLL_MAX_MS)
          status = await request<SonioxTranscription>(
            `/v1/transcriptions/${encodeURIComponent(transcriptionId)}`,
            { method: "GET", signal: req.signal },
            "Soniox transcription status"
          )
        }

        const transcript = await request<{ text?: string; tokens?: SonioxToken[] }>(
          `/v1/transcriptions/${encodeURIComponent(transcriptionId)}/transcript`,
          { method: "GET", signal: req.signal },
          "Soniox transcript"
        )
        const words = tokensToWords(transcript.tokens ?? [])
        const durationMs = Math.max(audio.durationMs, Number(status.audio_duration_ms ?? 0) || 0)

        return finalizeResult(
          {
            provider: PROVIDER,
            model: config.model,
            language: isHebrewLanguage(req.language) ? "he" : language,
            durationMs,
            words,
            diarization: req.diarize && words.some((word) => word.speaker) ? "provider" : "none",
            cost: {
              usd: roundUsd((durationMs / 3_600_000) * config.pricePerHour),
              basis: "audio_hours",
              billedSeconds: durationMs / 1000,
              unitPrice: config.pricePerHour,
            },
            timings: {
              ...audio.timings,
              uploadMs,
              processingMs: now() - processingStarted,
              totalMs: now() - started,
            },
            warnings: [],
          },
          req.glossary
        )
      } finally {
        if (transcriptionId) await remove(`/v1/transcriptions/${encodeURIComponent(transcriptionId)}`)
        if (fileId) await remove(`/v1/files/${encodeURIComponent(fileId)}`)
        await audio.cleanup()
      }
    },
  }
}
