import { envNumber, envText, isHebrewLanguage, providerLanguage, type AsrEnv } from "../config"
import { throwForResponse } from "../errors"
import { buildHotwords, buildInitialPrompt, hotwordsMaxChars } from "../glossary"
import { prepareAsrHandoff, type AsrHandoff } from "../handoff"
import { guardedFetch, readJson, sleep, type FetchFn } from "../http"
import { finalizeResult, synthesizeWords } from "../segmentation"
import {
  AsrError,
  type AsrHealth,
  type AsrProvider,
  type AsrRequest,
  type AsrResult,
  type AsrWord,
} from "../types"
import { prepareAudio, roundUsd, type AsrProviderDeps } from "./shared"

/**
 * RunPod serverless ASR. Default worker is the ivrit-ai image
 * (`RUNPOD_ASR_WORKER=ivrit`, faster-whisper / stable-whisper + diarization);
 * `RUNPOD_ASR_WORKER=meetsum` talks the `meetsum-asr/v1` schema of our own
 * asr-worker/ image. Lifecycle: transcode → handoff → POST /run → poll
 * /status (2 s ×1.5, cap 10 s) → normalize; timeout/abort → /cancel.
 */

const PROVIDER = "runpod-ivrit" as const
export const MEETSUM_ASR_SCHEMA = "meetsum-asr/v1"
const DEFAULT_BASE_URL = "https://api.runpod.ai/v2"
const DEFAULT_MODEL = "ivrit-ai/whisper-large-v3-turbo-ct2"
const DEFAULT_MULTILINGUAL_MODEL = "large-v3-turbo"
const DEFAULT_PRICE_PER_SECOND = 0.00019
const MAX_POLL_INTERVAL_MS = 10_000
const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"])

export type RunpodConfig = {
  apiKey: string
  endpointId: string
  baseUrl: string
  worker: "ivrit" | "meetsum"
  model: string
  multilingualModel: string
  engine: string
  pollIntervalMs: number
  timeoutMs?: number
  pricePerSecond: number
}

export function getRunpodConfig(env: AsrEnv = process.env): RunpodConfig {
  return {
    apiKey: envText(env, "RUNPOD_API_KEY") ?? "",
    endpointId: envText(env, "RUNPOD_ASR_ENDPOINT_ID") ?? "",
    baseUrl: (envText(env, "RUNPOD_API_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    worker: envText(env, "RUNPOD_ASR_WORKER")?.toLowerCase() === "meetsum" ? "meetsum" : "ivrit",
    model: envText(env, "RUNPOD_ASR_MODEL") ?? DEFAULT_MODEL,
    multilingualModel: envText(env, "RUNPOD_ASR_MODEL_MULTILINGUAL") ?? DEFAULT_MULTILINGUAL_MODEL,
    engine: envText(env, "RUNPOD_ASR_ENGINE") ?? "stable-whisper",
    pollIntervalMs: envNumber(env, "RUNPOD_ASR_POLL_INTERVAL_MS", 2000),
    timeoutMs: envText(env, "RUNPOD_ASR_TIMEOUT_MS") ? envNumber(env, "RUNPOD_ASR_TIMEOUT_MS", 600_000) : undefined,
    pricePerSecond: Number.isFinite(Number(env.RUNPOD_PRICE_PER_SECOND)) && env.RUNPOD_PRICE_PER_SECOND?.trim()
      ? Number(env.RUNPOD_PRICE_PER_SECOND)
      : DEFAULT_PRICE_PER_SECOND,
  }
}

export function isRunpodConfigured(env: AsrEnv = process.env) {
  return Boolean(envText(env, "RUNPOD_API_KEY") && envText(env, "RUNPOD_ASR_ENDPOINT_ID"))
}

// ---------------------------------------------------------------------------
// Output normalization
// ---------------------------------------------------------------------------

type RawWord = {
  start?: number
  end?: number
  word?: string
  text?: string
  probability?: number
  confidence?: number | null
  score?: number
  speaker?: string | null
}

type RawSegment = {
  start?: number
  end?: number
  text?: string
  speaker?: string | null
  speakers?: string[]
  words?: RawWord[]
}

type MeetsumOutput = {
  schema: string
  model?: string
  language?: string
  duration_s?: number
  diarization?: "provider" | "none"
  words?: RawWord[]
  speakers?: Array<{ label: string; embedding?: number[] | null }>
  embedding_model?: string | null
  warnings?: string[]
  error?: string
}

export type NormalizedRunpodOutput = {
  words: AsrWord[]
  diarized: boolean
  syntheticWords: boolean
  language?: string
  durationMs?: number
  model?: string
  warnings: string[]
  speakerEmbeddings?: Record<string, { embedding: number[]; model?: string }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isSegment(value: unknown): value is RawSegment {
  return isRecord(value) && typeof value.text === "string" && typeof value.start === "number"
}

function toMs(seconds: unknown): number {
  const value = Number(seconds)

  return Number.isFinite(value) ? Math.round(value * 1000) : 0
}

function wordConfidence(word: RawWord): number | undefined {
  const value = word.probability ?? word.confidence ?? word.score

  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function convertWord(raw: RawWord, fallbackSpeaker?: string): AsrWord | undefined {
  const text = (raw.word ?? raw.text ?? "").trim()

  if (!text) return undefined

  const word: AsrWord = { startMs: toMs(raw.start), endMs: toMs(raw.end ?? raw.start), text }
  const confidence = wordConfidence(raw)
  const speaker = raw.speaker ?? fallbackSpeaker

  if (confidence !== undefined) word.confidence = confidence
  if (speaker) word.speaker = speaker
  return word
}

/** Finds segments in generator chunk arrays, `{segments}`, `{result: […]}`, `{output}`. */
function collectSegments(value: unknown, into: RawSegment[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectSegments(item, into)
    return
  }
  if (isSegment(value)) {
    into.push(value)
    return
  }
  if (!isRecord(value)) return

  for (const key of ["segments", "result", "output", "transcription"]) {
    if (key in value) collectSegments(value[key], into)
  }
}

function findError(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const error = findError(item)

      if (error) return error
    }
    return undefined
  }
  if (!isRecord(value)) return undefined
  if (typeof value.error === "string" && value.error) return value.error
  return undefined
}

function normalizeMeetsum(output: MeetsumOutput): NormalizedRunpodOutput {
  const words = (output.words ?? [])
    .map((raw) => convertWord(raw))
    .filter((word): word is AsrWord => Boolean(word))
  const embeddings: Record<string, { embedding: number[]; model?: string }> = {}

  for (const speaker of output.speakers ?? []) {
    if (speaker.embedding?.length) {
      embeddings[speaker.label] = {
        embedding: speaker.embedding,
        ...(output.embedding_model ? { model: output.embedding_model } : {}),
      }
    }
  }

  return {
    words,
    diarized: output.diarization !== "none" && words.some((word) => word.speaker),
    syntheticWords: false,
    language: output.language,
    durationMs: output.duration_s ? toMs(output.duration_s) : undefined,
    model: output.model,
    warnings: [...(output.warnings ?? [])],
    speakerEmbeddings: Object.keys(embeddings).length ? embeddings : undefined,
  }
}

/** Normalizes any supported RunPod output shape into flat words. */
export function normalizeRunpodOutput(output: unknown): NormalizedRunpodOutput {
  const single = Array.isArray(output) && output.length === 1 ? output[0] : output

  if (isRecord(single) && single.schema === MEETSUM_ASR_SCHEMA) {
    return normalizeMeetsum(single as MeetsumOutput)
  }

  const segments: RawSegment[] = []

  collectSegments(output, segments)

  const words: AsrWord[] = []
  let syntheticWords = false
  let language: string | undefined

  if (isRecord(single) && typeof single.language === "string") language = single.language

  for (const segment of segments) {
    const speaker = segment.speaker ?? segment.speakers?.[0] ?? undefined
    const converted = (segment.words ?? [])
      .map((raw) => convertWord(raw, speaker ?? undefined))
      .filter((word): word is AsrWord => Boolean(word))

    if (converted.length) {
      words.push(...converted)
    } else if (segment.text?.trim()) {
      syntheticWords = true
      words.push(
        ...synthesizeWords(segment.text, toMs(segment.start), toMs(segment.end ?? segment.start), {
          ...(speaker ? { speaker } : {}),
        })
      )
    }
  }

  return {
    words,
    diarized: words.some((word) => word.speaker),
    syntheticWords,
    language,
    warnings: [],
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

type RunpodStatus = {
  id?: string
  status?: string
  output?: unknown
  error?: unknown
  delayTime?: number
  executionTime?: number
}

/** Explicit decode-failure marker from our worker (asr-worker/handler.py). */
export const RUNPOD_BAD_MEDIA_KIND = "bad_media"
const BAD_MEDIA_PREFIX = `[${RUNPOD_BAD_MEDIA_KIND}]`

/** True when a worker error carries asr-worker's explicit decode-failure marker. */
export function hasBadMediaMarker(value: unknown, message: string): boolean {
  if (message.trimStart().startsWith(BAD_MEDIA_PREFIX)) return true
  if (Array.isArray(value)) return value.some((item) => hasBadMediaMarker(item, ""))
  if (isRecord(value)) return value.error_kind === RUNPOD_BAD_MEDIA_KIND
  if (typeof value === "string" && value.trimStart().startsWith("{")) {
    try {
      return hasBadMediaMarker(JSON.parse(value), "")
    } catch {
      return false
    }
  }
  return false
}

/**
 * Only an explicit `error_kind: "bad_media"` (or its `[bad_media]` message
 * prefix) from our worker stops the chain as `bad_input`; free-text errors
 * (including the ivrit image's) stay retryable so the next provider runs.
 */
function failureError(status: RunpodStatus): AsrError {
  const raw = status.error ?? findError(status.output) ?? "RunPod job failed"
  const message = typeof raw === "string" ? raw : JSON.stringify(raw)
  const lower = message.toLowerCase()

  if (hasBadMediaMarker(status.output, message) || hasBadMediaMarker(status.error, message)) {
    return new AsrError(`RunPod could not decode the audio: ${message.slice(0, 300)}`, "bad_input", PROVIDER, false)
  }
  if (/out of memory|cuda/.test(lower)) {
    return new AsrError(`RunPod worker error: ${message.slice(0, 300)}`, "server", PROVIDER, true)
  }

  return new AsrError(`RunPod job failed: ${message.slice(0, 300)}`, "server", PROVIDER, true)
}

/**
 * `meetsum-asr/v1` job input for our asr-worker (asr-worker/schema.py),
 * shared by the RunPod (`RUNPOD_ASR_WORKER=meetsum`) and Modal providers.
 */
export function buildMeetsumAsrInput(
  models: { model: string; multilingualModel: string },
  req: AsrRequest,
  handoff: AsrHandoff,
  env: AsrEnv
): Record<string, unknown> {
  const hebrew = isHebrewLanguage(req.language)
  const hotwords = buildHotwords(req.glossary, { maxChars: hotwordsMaxChars(env) }) || undefined
  const initialPrompt = buildInitialPrompt(req.glossary, env)

  return {
    schema: MEETSUM_ASR_SCHEMA,
    audio: handoff.type === "url" ? { type: "url", url: handoff.url } : { type: "blob", data: handoff.data },
    model: hebrew ? models.model : models.multilingualModel,
    language: hebrew ? "he" : providerLanguage(req.language) || null,
    diarize: req.diarize,
    ...(req.speakers?.min ? { min_speakers: req.speakers.min } : {}),
    ...(req.speakers?.max ? { max_speakers: req.speakers.max } : {}),
    ...(hotwords ? { hotwords } : {}),
    ...(initialPrompt ? { initial_prompt: initialPrompt } : {}),
    word_timestamps: true,
  }
}

export function buildRunpodInput(
  config: RunpodConfig,
  req: AsrRequest,
  handoff: AsrHandoff,
  env: AsrEnv
): Record<string, unknown> {
  if (config.worker === "meetsum") return buildMeetsumAsrInput(config, req, handoff, env)

  const hebrew = isHebrewLanguage(req.language)
  const model = hebrew ? config.model : config.multilingualModel
  const hotwords = buildHotwords(req.glossary, { maxChars: hotwordsMaxChars(env) }) || undefined
  const initialPrompt = buildInitialPrompt(req.glossary, env)
  const media = handoff.type === "url" ? { type: "url", url: handoff.url } : { type: "blob", data: handoff.data }

  return {
    ...media,
    model,
    engine: config.engine,
    streaming: false,
    transcribe_args: {
      // Hebrew is forced for the ivrit fine-tune; other languages auto-detect
      // on the multilingual model.
      ...(hebrew ? { language: "he" } : {}),
      diarize: req.diarize,
      word_timestamps: true,
      ...(hotwords ? { hotwords } : {}),
      ...(initialPrompt ? { initial_prompt: initialPrompt } : {}),
    },
  }
}

export function createRunpodIvritProvider(deps: AsrProviderDeps = {}): AsrProvider {
  const env = deps.env ?? process.env
  const config = getRunpodConfig(env)
  const now = deps.now ?? Date.now
  const wait = deps.sleep ?? sleep
  const fetchFn = (): FetchFn => deps.fetch ?? globalThis.fetch
  const headers = () => ({ Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" })
  const endpointUrl = (suffix: string) => `${config.baseUrl}/${encodeURIComponent(config.endpointId)}/${suffix}`

  async function cancel(id: string) {
    await fetchFn()(endpointUrl(`cancel/${encodeURIComponent(id)}`), { method: "POST", headers: headers() }).catch(
      () => undefined
    )
  }

  async function getStatus(id: string, signal?: AbortSignal): Promise<RunpodStatus> {
    const response = await guardedFetch(fetchFn(), PROVIDER, endpointUrl(`status/${encodeURIComponent(id)}`), {
      headers: headers(),
      signal,
    })

    if (!response.ok) await throwForResponse(response, PROVIDER, "RunPod status")
    return readJson<RunpodStatus>(response, PROVIDER, "RunPod status")
  }

  async function poll(id: string, initial: RunpodStatus, timeoutMs: number, signal?: AbortSignal) {
    const deadline = now() + timeoutMs
    let interval = config.pollIntervalMs
    let status = initial
    let transientFailures = 0

    while (!TERMINAL.has(status.status ?? "")) {
      if (signal?.aborted) {
        await cancel(id)
        throw new AsrError("RunPod transcription aborted", "timeout", PROVIDER, false)
      }
      if (now() >= deadline) {
        await cancel(id)
        throw new AsrError(`RunPod transcription timed out after ${timeoutMs}ms`, "timeout", PROVIDER, true)
      }

      try {
        await wait(Math.max(0, Math.min(interval, deadline - now())), signal)
      } catch {
        await cancel(id)
        throw new AsrError("RunPod transcription aborted", "timeout", PROVIDER, false)
      }

      interval = Math.min(Math.round(interval * 1.5), MAX_POLL_INTERVAL_MS)

      try {
        status = await getStatus(id, signal)
        transientFailures = 0
      } catch (error) {
        if (error instanceof AsrError && error.retryable && error.kind !== "timeout" && transientFailures < 3) {
          transientFailures += 1
          continue
        }
        await cancel(id)
        throw error
      }
    }

    return status
  }

  return {
    id: PROVIDER,
    model: config.model,
    isConfigured: (value?: NodeJS.ProcessEnv) => isRunpodConfigured(value ?? env),

    async healthCheck(): Promise<AsrHealth> {
      if (!isRunpodConfigured(env)) return { provider: PROVIDER, configured: false, healthy: null }

      try {
        const response = await guardedFetch(fetchFn(), PROVIDER, endpointUrl("health"), { headers: headers() })

        if (!response.ok) {
          return { provider: PROVIDER, configured: true, healthy: false, lastError: `HTTP ${response.status}` }
        }

        const body = await readJson<Record<string, unknown>>(response, PROVIDER, "RunPod health")

        return {
          provider: PROVIDER,
          configured: true,
          healthy: true,
          detail: { worker: config.worker, workers: body.workers, jobs: body.jobs },
        }
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
      if (!isRunpodConfigured(env)) {
        throw new AsrError("RunPod ASR is not configured (RUNPOD_API_KEY, RUNPOD_ASR_ENDPOINT_ID)", "config", PROVIDER, false)
      }

      const started = now()
      const audio = await prepareAudio(req, PROVIDER, deps)
      let handoff: AsrHandoff | undefined

      try {
        const handoffStarted = now()

        handoff = await prepareAsrHandoff(audio.audioPath, PROVIDER, { env, ...deps.handoff })

        const handoffMs = now() - handoffStarted
        const hebrew = isHebrewLanguage(req.language)
        const model = hebrew ? config.model : config.multilingualModel
        const runResponse = await guardedFetch(fetchFn(), PROVIDER, endpointUrl("run"), {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ input: buildRunpodInput(config, req, handoff, env) }),
          signal: req.signal,
        })

        if (!runResponse.ok) await throwForResponse(runResponse, PROVIDER, "RunPod run")

        const submitted = await readJson<RunpodStatus>(runResponse, PROVIDER, "RunPod run")

        if (!submitted.id) {
          throw new AsrError("RunPod run response has no job id", "server", PROVIDER, true)
        }

        const timeoutMs = config.timeoutMs ?? Math.max(600_000, Math.round(0.5 * audio.durationMs + 300_000))
        const final = await poll(submitted.id, submitted, timeoutMs, req.signal)

        if (final.status === "FAILED" || findError(final.output)) throw failureError(final)
        if (final.status === "TIMED_OUT") {
          throw new AsrError("RunPod job timed out on the worker", "timeout", PROVIDER, true)
        }
        if (final.status === "CANCELLED") {
          throw new AsrError("RunPod job was cancelled", "unknown", PROVIDER, true)
        }

        const normalized = normalizeRunpodOutput(final.output)
        const executionMs = Number(final.executionTime ?? 0) || 0
        const billedSeconds = executionMs / 1000
        const warnings = [...normalized.warnings]

        if (normalized.syntheticWords) warnings.push("synthetic_word_timings")

        return finalizeResult(
          {
            provider: PROVIDER,
            model: normalized.model ?? model,
            language: hebrew ? "he" : normalized.language ?? providerLanguage(req.language),
            durationMs: normalized.durationMs ?? audio.durationMs,
            words: normalized.words,
            diarization: req.diarize && normalized.diarized ? "provider" : "none",
            cost: {
              usd: roundUsd(billedSeconds * config.pricePerSecond),
              basis: "gpu_seconds",
              billedSeconds,
              unitPrice: config.pricePerSecond,
            },
            timings: {
              ...audio.timings,
              handoffMs,
              queueMs: Number(final.delayTime ?? 0) || 0,
              executionMs,
              totalMs: now() - started,
            },
            warnings,
            speakerEmbeddings: normalized.speakerEmbeddings,
          },
          req.glossary
        )
      } finally {
        await handoff?.cleanup().catch(() => undefined)
        await audio.cleanup()
      }
    },
  }
}
