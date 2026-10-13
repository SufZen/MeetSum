import {
  breakerOptionsFromEnv,
  createCircuitBreaker,
  MemoryBreakerStore,
  RedisBreakerStore,
  type BreakerRedisClient,
  type BreakerStore,
  type CircuitBreaker,
} from "./breaker"
import { DEFAULT_ASR_CHAIN, DEFAULT_ASR_CHAIN_NON_HE, envText, resolveAsrChain, type AsrEnv } from "./config"
import { redactAsrErrorMessage, toAsrError, TranscriptionUnavailableError } from "./errors"
import type { FetchFn } from "./http"
import { createGeminiLegacyProvider } from "./providers/gemini-legacy"
import { createLocalWhisperChunkedProvider } from "./providers/local-whisper-chunked"
import { createModalWorkerProvider } from "./providers/modal-worker"
import { createRunpodIvritProvider } from "./providers/runpod-ivrit"
import type { AsrProviderDeps } from "./providers/shared"
import { createSonioxProvider } from "./providers/soniox"
import {
  AsrChainError,
  type AsrAttempt,
  type AsrHealth,
  type AsrProvider,
  type AsrProviderId,
  type AsrRequest,
  type AsrResult,
  type AsrRouterResult,
} from "./types"

export type AsrRouterOptions = {
  env?: AsrEnv
  fetch?: FetchFn
  providers?: AsrProvider[]
  breaker?: CircuitBreaker
  /** Extra deps forwarded to the default providers (tests). */
  providerDeps?: AsrProviderDeps
  now?: () => number
  /** Health-check timeout for {@link getAsrRouterStatus}. */
  healthTimeoutMs?: number
}

export type AsrRouterStatus = {
  /** Effective provider order used for Hebrew / mixed meetings. */
  chain: AsrProviderId[]
  /** Effective provider order used for other languages. */
  nonHebrewChain: AsrProviderId[]
  providers: AsrHealth[]
}

/** The built-in providers wired to `env` / `fetch`. */
export function createDefaultAsrProviders(options: { env?: AsrEnv; fetch?: FetchFn; deps?: AsrProviderDeps } = {}): AsrProvider[] {
  const deps: AsrProviderDeps = { ...options.deps, env: options.env ?? options.deps?.env, fetch: options.fetch ?? options.deps?.fetch }

  return [
    createRunpodIvritProvider(deps),
    createModalWorkerProvider(deps),
    createSonioxProvider(deps),
    createLocalWhisperChunkedProvider(deps),
    createGeminiLegacyProvider({ env: deps.env }),
  ]
}

let sharedBreaker: CircuitBreaker | undefined

async function queueRedisClient(): Promise<BreakerRedisClient> {
  const { getMeetSumQueue } = await import("@/lib/jobs/queue")

  return (await getMeetSumQueue().client) as unknown as BreakerRedisClient
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined

  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/**
 * Process-wide breaker: Redis-backed when REDIS_URL is set (shared by all
 * workers; any Redis trouble falls back to memory), else in-memory.
 */
export function getSharedAsrBreaker(env: AsrEnv = process.env): CircuitBreaker {
  if (sharedBreaker) return sharedBreaker

  const store: BreakerStore =
    envText(env, "REDIS_URL") && envText(env, "MEETSUM_ASR_BREAKER_STORE") !== "memory"
      ? new RedisBreakerStore(() => withTimeout(queueRedisClient(), 2000))
      : new MemoryBreakerStore()

  sharedBreaker = createCircuitBreaker({ store, ...breakerOptionsFromEnv(env) })
  return sharedBreaker
}

/** Test hook: drop the process-wide breaker. */
export function resetSharedAsrBreaker() {
  sharedBreaker = undefined
}

function resolveProviders(chainIds: AsrProviderId[], providers: AsrProvider[], env: AsrEnv): AsrProvider[] {
  const byId = new Map(providers.map((provider) => [provider.id, provider]))

  return chainIds
    .map((id) => byId.get(id))
    .filter((provider): provider is AsrProvider => Boolean(provider?.isConfigured(env as NodeJS.ProcessEnv)))
}

export type AsrChainConfig = {
  chain: AsrProviderId[]
  nonHebrewChain: AsrProviderId[]
  providers: Array<{ id: AsrProviderId; model: string; configured: boolean }>
}

/**
 * Synchronous configuration view (no network, no breaker): effective
 * chains and which providers are configured. Used by health/status pages.
 */
export function getAsrChainConfig(env: AsrEnv = process.env): AsrChainConfig {
  const providers = createDefaultAsrProviders({ env })

  return {
    chain: resolveProviders(resolveAsrChain("he", env), providers, env).map((provider) => provider.id),
    nonHebrewChain: resolveProviders(resolveAsrChain("en", env), providers, env).map((provider) => provider.id),
    providers: providers.map((provider) => ({
      id: provider.id,
      model: provider.model,
      configured: provider.isConfigured(env as NodeJS.ProcessEnv),
    })),
  }
}

/** Effective chain (configured providers only) for a meeting language. */
export function getEffectiveAsrChain(language: string, options: AsrRouterOptions = {}): AsrProviderId[] {
  const env = options.env ?? process.env
  const providers = options.providers ?? createDefaultAsrProviders({ env, fetch: options.fetch, deps: options.providerDeps })

  return resolveProviders(resolveAsrChain(language, env), providers, env).map((provider) => provider.id)
}

/** Empty transcripts of audio longer than this fall through to the next provider. */
export const EMPTY_RESULT_FALLBACK_MIN_MS = 5000

function emptyResult(provider: AsrProvider, req: AsrRequest, warning: string): AsrResult {
  return {
    provider: provider.id,
    model: provider.model,
    language: req.language,
    durationMs: 0,
    segments: [],
    speakers: [],
    diarization: "none",
    cost: { usd: null, basis: "none" },
    timings: {},
    glossaryReplacements: 0,
    warnings: [warning],
  }
}

/**
 * Transcribes through the configured provider chain. Unconfigured providers
 * are skipped, circuit-open providers too. `bad_input` stops the chain
 * (the media is the problem); `no_speech` yields an empty result. An empty
 * transcript of audio longer than {@link EMPTY_RESULT_FALLBACK_MIN_MS} is
 * recorded as a failed `no_speech` attempt and the next provider tries;
 * it is returned only when no later provider does better. Any other
 * failure moves on to the next provider. When everything fails an
 * {@link AsrChainError} is thrown, retryable if any failure was.
 */
export async function transcribeWithRouter(req: AsrRequest, opts: AsrRouterOptions = {}): Promise<AsrRouterResult> {
  const env = opts.env ?? process.env
  const now = opts.now ?? Date.now
  const providers = opts.providers ?? createDefaultAsrProviders({ env, fetch: opts.fetch, deps: opts.providerDeps })
  const chain = resolveProviders(resolveAsrChain(req.language, env), providers, env)
  const breaker = opts.breaker ?? getSharedAsrBreaker(env)

  if (!chain.length) {
    throw new TranscriptionUnavailableError(
      "No ASR provider is configured. Set RUNPOD_API_KEY + RUNPOD_ASR_ENDPOINT_ID, " +
        "MODAL_ASR_URL + MODAL_ASR_TOKEN, SONIOX_API_KEY " +
        "or LOCAL_TRANSCRIPTION_URL (Gemini needs MEETSUM_ASR_ALLOW_GEMINI=true)."
    )
  }

  const attempts: AsrAttempt[] = []
  const skipped: string[] = []
  let anyRetryable = false
  /** First empty transcript of real-length audio, returned if nothing better comes. */
  let emptyFallback: { result: AsrResult; index: number } | undefined

  for (const [index, provider] of chain.entries()) {
    if (req.signal?.aborted) {
      throw new AsrChainError("ASR transcription aborted", attempts, false)
    }

    const state = await breaker.status(provider.id)

    if (state.open) {
      skipped.push(`breaker_open:${provider.id}`)
      anyRetryable = true
      continue
    }

    const started = now()

    try {
      const result = await provider.transcribe(req)

      await breaker.recordSuccess(provider.id)

      if (!result.segments.length && result.durationMs > EMPTY_RESULT_FALLBACK_MIN_MS && index < chain.length - 1) {
        // Several seconds of audio and no words: a provider miss (VAD, wrong
        // language) is likelier than silence, so let the next provider try.
        attempts.push({
          provider: provider.id,
          ok: false,
          kind: "no_speech",
          error: `No segments for ${Math.round(result.durationMs / 1000)}s of audio`,
          elapsedMs: now() - started,
          cost: result.cost,
        })
        emptyFallback ??= { result, index }
        continue
      }

      attempts.push({ provider: provider.id, ok: true, elapsedMs: now() - started, cost: result.cost })

      return {
        ...result,
        warnings: [...result.warnings, ...skipped],
        attempts,
        fallbackUsed: index > 0,
      }
    } catch (error) {
      const asrError = toAsrError(error, provider.id)
      const elapsedMs = now() - started

      if (asrError.kind === "no_speech") {
        attempts.push({ provider: provider.id, ok: true, elapsedMs })
        await breaker.recordSuccess(provider.id)
        return {
          ...emptyResult(provider, req, "no_speech"),
          warnings: ["no_speech", ...skipped],
          attempts,
          fallbackUsed: index > 0,
        }
      }

      const safeMessage = redactAsrErrorMessage(asrError.message)
      attempts.push({ provider: provider.id, ok: false, kind: asrError.kind, error: safeMessage, elapsedMs })
      await breaker.recordFailure(provider.id, asrError)
      console.error(
        `[asr] ${provider.id} failed after ${elapsedMs}ms (${asrError.kind}, retryable=${asrError.retryable}): ${safeMessage}`
      )

      if (asrError.kind === "bad_input") {
        throw new AsrChainError(`ASR input rejected by ${provider.id}: ${safeMessage}`, attempts, false)
      }
      if (req.signal?.aborted) {
        throw new AsrChainError("ASR transcription aborted", attempts, false)
      }

      anyRetryable ||= asrError.retryable
    }
  }

  if (emptyFallback) {
    return {
      ...emptyFallback.result,
      warnings: [...emptyFallback.result.warnings, ...skipped],
      attempts,
      fallbackUsed: emptyFallback.index > 0,
    }
  }

  const summary = attempts.map((attempt) => `${attempt.provider}: ${attempt.kind} ${attempt.error ?? ""}`.trim())

  if (!attempts.length) {
    throw new AsrChainError(`All ASR providers are circuit-open (${skipped.join(", ")})`, attempts, true)
  }

  throw new AsrChainError(`All ASR providers failed — ${summary.join("; ")}`, attempts, anyRetryable)
}

/** Chains plus per-provider configuration, health (5 s timeout) and breaker state. */
export async function getAsrRouterStatus(opts: AsrRouterOptions = {}): Promise<AsrRouterStatus> {
  const env = opts.env ?? process.env
  const providers = opts.providers ?? createDefaultAsrProviders({ env, fetch: opts.fetch, deps: opts.providerDeps })
  const breaker = opts.breaker ?? getSharedAsrBreaker(env)
  const timeoutMs = opts.healthTimeoutMs ?? 5000
  const chain = resolveProviders(resolveAsrChain("he", env), providers, env).map((provider) => provider.id)
  const nonHebrewChain = resolveProviders(resolveAsrChain("en", env), providers, env).map((provider) => provider.id)
  const ordered = [
    ...new Set<AsrProviderId>([...DEFAULT_ASR_CHAIN, ...DEFAULT_ASR_CHAIN_NON_HE, "gemini-legacy"]),
  ]
  const byId = new Map(providers.map((provider) => [provider.id, provider]))

  const health = await Promise.all(
    ordered
      .map((id) => byId.get(id))
      .filter((provider): provider is AsrProvider => Boolean(provider))
      .map(async (provider): Promise<AsrHealth> => {
        const configured = provider.isConfigured(env as NodeJS.ProcessEnv)
        const state = await breaker.status(provider.id).catch(() => ({ open: false, failures: 0 }) as const)
        let result: AsrHealth = { provider: provider.id, configured, healthy: null }

        if (configured) {
          try {
            result = await withTimeout(provider.healthCheck(), timeoutMs)
          } catch (error) {
            result = {
              provider: provider.id,
              configured,
              healthy: false,
              lastError: redactAsrErrorMessage(error instanceof Error ? error.message : String(error)),
            }
          }
        }

        return {
          ...result,
          configured,
          ...("openUntil" in state && state.openUntil ? { breakerOpenUntil: new Date(state.openUntil).toISOString() } : {}),
          ...(result.lastError ? { lastError: redactAsrErrorMessage(result.lastError) } : {}),
          ...(!result.lastError && "lastError" in state && state.lastError
            ? { lastError: redactAsrErrorMessage(state.lastError) }
            : {}),
        }
      })
  )

  return { chain, nonHebrewChain, providers: health }
}
