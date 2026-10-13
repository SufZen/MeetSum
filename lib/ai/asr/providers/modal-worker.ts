import { envNumber, envText, isHebrewLanguage, providerLanguage, type AsrEnv } from "../config"
import { redactAsrErrorMessage, throwForResponse, toAsrError } from "../errors"
import { prepareAsrHandoff, type AsrHandoff } from "../handoff"
import { guardedFetch, readJson, sleep, type FetchFn } from "../http"
import { finalizeResult } from "../segmentation"
import { AsrError, type AsrHealth, type AsrProvider, type AsrRequest, type AsrResult } from "../types"
import { buildMeetsumAsrInput, hasBadMediaMarker, normalizeRunpodOutput } from "./runpod-ivrit"
import { prepareAudio, roundUsd, type AsrProviderDeps } from "./shared"

/**
 * Our own asr-worker (ivrit-ai turbo + pyannote) deployed serverlessly on
 * Modal (asr-worker/modal_app.py), which fits Modal's free monthly credit
 * for small workloads. Same `meetsum-asr/v1` input/output as the RunPod
 * `meetsum` worker. Modal web requests are capped at ~150 s, so the app is
 * submit/poll: POST /v1/jobs → GET /v1/jobs/{id} (3 s ×1.5, cap 15 s) →
 * normalize; timeout/abort → POST /v1/jobs/{id}/cancel. Every call carries
 * `Authorization: Bearer MODAL_ASR_TOKEN`.
 */

const PROVIDER = "modal-worker" as const
const DEFAULT_MODEL = "ivrit-ai/whisper-large-v3-turbo-ct2"
const DEFAULT_MULTILINGUAL_MODEL = "large-v3-turbo"
/** Modal T4 list price ($0.59/h); L4 is ~$0.000222/s. */
export const DEFAULT_MODAL_PRICE_PER_SECOND = 0.000164
const MAX_POLL_INTERVAL_MS = 15_000
const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"])

export type ModalWorkerConfig = {
  baseUrl: string
  token: string
  model: string
  multilingualModel: string
  pollIntervalMs: number
  timeoutMs?: number
  submitRetries: number
  pricePerSecond: number
}

export function getModalWorkerConfig(env: AsrEnv = process.env): ModalWorkerConfig {
  const price = Number(env.MODAL_PRICE_PER_SECOND)
  const retries = Number(env.MODAL_ASR_SUBMIT_RETRIES)

  return {
    baseUrl: (envText(env, "MODAL_ASR_URL") ?? "").replace(/\/+$/, ""),
    token: envText(env, "MODAL_ASR_TOKEN") ?? "",
    model: envText(env, "MODAL_ASR_MODEL") ?? DEFAULT_MODEL,
    multilingualModel: envText(env, "MODAL_ASR_MODEL_MULTILINGUAL") ?? DEFAULT_MULTILINGUAL_MODEL,
    pollIntervalMs: envNumber(env, "MODAL_ASR_POLL_INTERVAL_MS", 3000),
    timeoutMs: envText(env, "MODAL_ASR_TIMEOUT_MS") ? envNumber(env, "MODAL_ASR_TIMEOUT_MS", 900_000) : undefined,
    submitRetries:
      env.MODAL_ASR_SUBMIT_RETRIES?.trim() && Number.isInteger(retries) && retries >= 0 ? Math.min(retries, 5) : 2,
    pricePerSecond: env.MODAL_PRICE_PER_SECOND?.trim() && Number.isFinite(price) && price >= 0
      ? price
      : DEFAULT_MODAL_PRICE_PER_SECOND,
  }
}

export function isModalWorkerConfigured(env: AsrEnv = process.env) {
  return Boolean(envText(env, "MODAL_ASR_URL") && envText(env, "MODAL_ASR_TOKEN"))
}

/** Job state returned by modal_app.py (`GET /v1/jobs/{id}`). */
export type ModalJobStatus = {
  id?: string
  status?: string
  output?: unknown
  error?: string
  error_kind?: string
  /** GPU execution time in ms, measured inside the worker. */
  executionTime?: number
}

function outputError(output: unknown): string | undefined {
  return typeof output === "object" && output !== null && !Array.isArray(output) &&
    typeof (output as { error?: unknown }).error === "string"
    ? (output as { error: string }).error
    : undefined
}

/**
 * Only the worker's explicit `bad_media` marker is a permanent `bad_input`;
 * other job failures stay retryable so the next provider can run.
 */
export function modalFailureError(status: ModalJobStatus): AsrError {
  const message = redactAsrErrorMessage(status.error ?? outputError(status.output) ?? "Modal ASR job failed")

  if (status.error_kind === "bad_media" || hasBadMediaMarker(status.output, message)) {
    return new AsrError(`Modal worker could not decode the audio: ${message}`, "bad_input", PROVIDER, false)
  }
  if (/^invalid input/i.test(message)) {
    return new AsrError(`Modal worker rejected the request: ${message}`, "config", PROVIDER, false)
  }

  return new AsrError(`Modal ASR job failed: ${message}`, "server", PROVIDER, true)
}

export function createModalWorkerProvider(deps: AsrProviderDeps = {}): AsrProvider {
  const env = deps.env ?? process.env
  const config = getModalWorkerConfig(env)
  const now = deps.now ?? Date.now
  const wait = deps.sleep ?? sleep
  const fetchFn = (): FetchFn => deps.fetch ?? globalThis.fetch
  const headers = () => ({ Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" })
  const jobUrl = (id: string, suffix = "") => `${config.baseUrl}/v1/jobs/${encodeURIComponent(id)}${suffix}`

  async function cancel(id: string) {
    await fetchFn()(jobUrl(id, "/cancel"), { method: "POST", headers: headers() }).catch(() => undefined)
  }

  async function submit(input: Record<string, unknown>, signal?: AbortSignal): Promise<ModalJobStatus> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await guardedFetch(fetchFn(), PROVIDER, `${config.baseUrl}/v1/jobs`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ input }),
          signal,
        })

        if (!response.ok) await throwForResponse(response, PROVIDER, "Modal submit")

        const submitted = await readJson<ModalJobStatus>(response, PROVIDER, "Modal submit")

        if (!submitted.id) throw new AsrError("Modal submit response has no job id", "server", PROVIDER, true)
        return submitted
      } catch (error) {
        const asrError = toAsrError(error, PROVIDER)

        if (!asrError.retryable || asrError.kind === "timeout" || signal?.aborted || attempt >= config.submitRetries) {
          throw asrError
        }
        await wait(1000 * 2 ** attempt, signal).catch(() => {
          throw new AsrError("Modal transcription aborted", "timeout", PROVIDER, false)
        })
      }
    }
  }

  async function getStatus(id: string, signal?: AbortSignal): Promise<ModalJobStatus> {
    const response = await guardedFetch(fetchFn(), PROVIDER, jobUrl(id), { headers: headers(), signal })

    if (!response.ok) await throwForResponse(response, PROVIDER, "Modal status")
    return readJson<ModalJobStatus>(response, PROVIDER, "Modal status")
  }

  async function poll(id: string, initial: ModalJobStatus, timeoutMs: number, signal?: AbortSignal) {
    const deadline = now() + timeoutMs
    let interval = config.pollIntervalMs
    let status = initial
    let transientFailures = 0

    while (!TERMINAL.has(status.status ?? "")) {
      if (signal?.aborted) {
        await cancel(id)
        throw new AsrError("Modal transcription aborted", "timeout", PROVIDER, false)
      }
      if (now() >= deadline) {
        await cancel(id)
        throw new AsrError(`Modal transcription timed out after ${timeoutMs}ms`, "timeout", PROVIDER, true)
      }

      try {
        await wait(Math.max(0, Math.min(interval, deadline - now())), signal)
      } catch {
        await cancel(id)
        throw new AsrError("Modal transcription aborted", "timeout", PROVIDER, false)
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
    isConfigured: (value?: NodeJS.ProcessEnv) => isModalWorkerConfigured(value ?? env),

    async healthCheck(): Promise<AsrHealth> {
      if (!isModalWorkerConfigured(env)) return { provider: PROVIDER, configured: false, healthy: null }

      try {
        // The web endpoint runs on CPU; this never starts a GPU container.
        const response = await guardedFetch(fetchFn(), PROVIDER, `${config.baseUrl}/health`, { headers: headers() })

        if (!response.ok) {
          return { provider: PROVIDER, configured: true, healthy: false, lastError: `HTTP ${response.status}` }
        }

        const body = await readJson<Record<string, unknown>>(response, PROVIDER, "Modal health")

        return {
          provider: PROVIDER,
          configured: true,
          healthy: body.ok !== false,
          detail: { gpu: body.gpu, model: body.model ?? config.model },
        }
      } catch (error) {
        return {
          provider: PROVIDER,
          configured: true,
          healthy: false,
          lastError: redactAsrErrorMessage(error instanceof Error ? error.message : String(error)),
        }
      }
    },

    async transcribe(req: AsrRequest): Promise<AsrResult> {
      if (!isModalWorkerConfigured(env)) {
        throw new AsrError("Modal ASR is not configured (MODAL_ASR_URL, MODAL_ASR_TOKEN)", "config", PROVIDER, false)
      }

      const started = now()
      const audio = await prepareAudio(req, PROVIDER, deps)
      let handoff: AsrHandoff | undefined

      try {
        const handoffStarted = now()
        const maxBlob = envText(env, "MODAL_MAX_BLOB_BYTES")

        handoff = await prepareAsrHandoff(audio.audioPath, PROVIDER, {
          env: maxBlob ? { ...env, RUNPOD_MAX_BLOB_BYTES: maxBlob } : env,
          ...deps.handoff,
        })

        const handoffMs = now() - handoffStarted
        const hebrew = isHebrewLanguage(req.language)
        const submitted = await submit(buildMeetsumAsrInput(config, req, handoff, env), req.signal)
        // Allow for a cold start (image pull + model load) on top of processing.
        const timeoutMs = config.timeoutMs ?? Math.max(900_000, Math.round(0.5 * audio.durationMs + 420_000))
        const final = await poll(submitted.id as string, submitted, timeoutMs, req.signal)

        if (final.status === "FAILED" || outputError(final.output)) throw modalFailureError(final)
        if (final.status === "TIMED_OUT") {
          throw new AsrError("Modal job timed out on the worker", "timeout", PROVIDER, true)
        }
        if (final.status === "CANCELLED") {
          throw new AsrError("Modal job was cancelled", "unknown", PROVIDER, true)
        }

        const normalized = normalizeRunpodOutput(final.output)
        const executionMs = Number(final.executionTime ?? 0) || 0
        const billedSeconds = executionMs / 1000
        const warnings = [...normalized.warnings]

        if (normalized.syntheticWords) warnings.push("synthetic_word_timings")

        return finalizeResult(
          {
            provider: PROVIDER,
            model: normalized.model ?? (hebrew ? config.model : config.multilingualModel),
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
            timings: { ...audio.timings, handoffMs, executionMs, totalMs: now() - started },
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
