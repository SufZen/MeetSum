/**
 * Retries for embedding calls (docs/parity/m6.md, A4): 429/5xx/network/
 * timeout use exponential full-jitter backoff (500 ms × 2^n, cap 20 s,
 * Retry-After honoured) up to `maxRetries`, each attempt bounded by
 * `AbortSignal.timeout(timeoutMs)`. 400 → `bad_request` and 401/403 →
 * `auth`, never retried. A caller abort stops immediately.
 */
import { EmbeddingError, type EmbeddingErrorKind } from "@/lib/ai/embeddings/types"

const BASE_DELAY_MS = 500
const MAX_DELAY_MS = 20_000
const MAX_RETRY_AFTER_MS = 60_000

export type ClassifiedEmbeddingError = EmbeddingError & { retryAfterMs?: number; status?: number }

function statusOf(error: unknown): number | undefined {
  const candidate = error as { status?: unknown; code?: unknown; response?: { status?: unknown } } | undefined
  const status = candidate?.status ?? candidate?.response?.status ?? candidate?.code

  return typeof status === "number" ? status : undefined
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined

  const record = headers as Record<string, unknown>
  const value = record[name] ?? record[name.toLowerCase()]

  return typeof value === "string" ? value : undefined
}

/** Retry-After from response headers, or Google's `retryDelay: "12s"` in the error body. */
export function retryAfterMsOf(error: unknown, now = Date.now()): number | undefined {
  const candidate = error as { headers?: unknown; response?: { headers?: unknown }; message?: unknown } | undefined
  const header = headerValue(candidate?.headers, "retry-after") ?? headerValue(candidate?.response?.headers, "retry-after")

  if (header) {
    const seconds = Number(header)

    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
    const date = Date.parse(header)

    if (!Number.isNaN(date)) return Math.max(0, date - now)
  }

  const message = typeof candidate?.message === "string" ? candidate.message : ""
  const delay = /"?retryDelay"?\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(message)

  return delay ? Number(delay[1]) * 1000 : undefined
}

function make(message: string, kind: EmbeddingErrorKind, retryable: boolean, extra: { retryAfterMs?: number; status?: number } = {}) {
  const error = new EmbeddingError(message, kind, retryable) as ClassifiedEmbeddingError

  if (extra.retryAfterMs !== undefined) error.retryAfterMs = extra.retryAfterMs
  if (extra.status !== undefined) error.status = extra.status

  return error
}

/** Maps any provider/network error to an `EmbeddingError` with a retry decision. */
export function classifyEmbeddingError(error: unknown): ClassifiedEmbeddingError {
  if (error instanceof EmbeddingError) return error as ClassifiedEmbeddingError

  const status = statusOf(error)
  const name = (error as { name?: unknown } | undefined)?.name
  const message = error instanceof Error ? error.message : String(error)
  const retryAfterMs = retryAfterMsOf(error)

  if (status !== undefined) {
    if (status === 401 || status === 403) return make(`Embedding auth failed (${status})`, "auth", false, { status })
    if (status === 429) return make("Embedding rate limited", "rate_limit", true, { status, retryAfterMs })
    if (status === 408 || status === 504) return make(`Embedding timed out (${status})`, "timeout", true, { status, retryAfterMs })
    if (status >= 500) return make(`Embedding server error (${status})`, "server", true, { status, retryAfterMs })
    if (status >= 400) return make(`Embedding request rejected (${status})`, "bad_request", false, { status })
  }

  if (name === "TimeoutError") return make("Embedding request timed out", "timeout", true)
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|network/i.test(message)) {
    return make("Embedding network error", "timeout", true)
  }

  return make("Embedding request failed", "unknown", false)
}

export type RetryOptions = {
  maxRetries: number
  timeoutMs: number
  signal?: AbortSignal
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  random?: () => number
}

/** Full-jitter delay for retry `attempt` (0-based); Retry-After wins when given. */
export function backoffDelayMs(attempt: number, retryAfterMs: number | undefined, random: () => number = Math.random): number {
  if (retryAfterMs !== undefined) return Math.min(Math.max(0, retryAfterMs), MAX_RETRY_AFTER_MS)

  return Math.floor(random() * Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt))
}

function abortedError(): EmbeddingError {
  return new EmbeddingError("Embedding request aborted", "unknown", false)
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortedError())
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortedError())
    }

    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/** Runs `fn` with per-attempt timeouts and retries; returns the value and the attempt count. */
export async function withEmbeddingRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  options: RetryOptions
): Promise<{ value: T; attempts: number }> {
  const sleep = options.sleep ?? abortableSleep
  let attempt = 0

  for (;;) {
    if (options.signal?.aborted) throw abortedError()
    const timeout = AbortSignal.timeout(options.timeoutMs)
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout

    try {
      return { value: await fn(signal), attempts: attempt + 1 }
    } catch (error) {
      if (options.signal?.aborted) throw abortedError()
      const classified = timeout.aborted ? make("Embedding request timed out", "timeout", true) : classifyEmbeddingError(error)

      if (!classified.retryable || attempt >= options.maxRetries) throw classified
      await sleep(backoffDelayMs(attempt, classified.retryAfterMs, options.random), options.signal)
      attempt += 1
    }
  }
}
