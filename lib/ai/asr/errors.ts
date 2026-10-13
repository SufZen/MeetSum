import { AsrError, type AsrErrorKind } from "./types"

/**
 * Thrown when no transcription provider can produce a real transcript, so the
 * job fails honestly instead of persisting fabricated placeholder text.
 * Re-exported from lib/ai/providers for existing callers.
 */
export class TranscriptionUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TranscriptionUnavailableError"
  }
}

const MAX_ERROR_LENGTH = 300

/**
 * Strips secrets from provider error text before it is logged or persisted
 * (ai_runs metadata is shown to every workspace member): URL query strings
 * (presigned handoff signatures), bearer tokens, key/token/signature params,
 * and long base64 blobs. Output is capped at 300 characters.
 */
export function redactAsrErrorMessage(message: string): string {
  const redacted = message
    .replace(/(https?:\/\/[^\s?#"'<>]+)\?[^\s"'<>]*/gi, "$1?[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(
      /\b(api[_-]?key|access[_-]?token|token|secret|signature|password|x-amz-[a-z-]+)(["']?\s*[:=]\s*["']?)[^\s&"',}]+/gi,
      "$1$2[redacted]"
    )
    .replace(/[A-Za-z0-9+/]{200,}={0,2}/g, "[blob]")

  return redacted.length > MAX_ERROR_LENGTH
    ? `${redacted.slice(0, MAX_ERROR_LENGTH - 1)}…`
    : redacted
}

/** Kind + retryability for an HTTP status returned by an ASR provider. */
export function classifyHttpStatus(status: number): {
  kind: AsrErrorKind
  retryable: boolean
} {
  if (status === 401 || status === 403) return { kind: "auth", retryable: false }
  if (status === 429) return { kind: "rate_limit", retryable: true }
  if (status === 408 || status === 504) return { kind: "timeout", retryable: true }
  if (status === 413 || status === 415) return { kind: "bad_input", retryable: false }
  if (status >= 500) return { kind: "server", retryable: true }

  return { kind: "unknown", retryable: false }
}

function errorName(error: unknown) {
  return error instanceof Error || error instanceof DOMException ? error.name : ""
}

/**
 * Normalizes anything a provider threw into an {@link AsrError}. Network
 * failures and unknown errors are retryable (a later attempt or the next
 * provider may succeed); aborts are timeouts.
 */
export function toAsrError(error: unknown, provider: string): AsrError {
  if (error instanceof AsrError) return error

  const message = redactAsrErrorMessage(error instanceof Error ? error.message : String(error))
  const lower = message.toLowerCase()
  const name = errorName(error)

  if (name === "AbortError" || name === "TimeoutError") {
    return new AsrError(message || "ASR request aborted", "timeout", provider, true)
  }
  if (error instanceof TranscriptionUnavailableError) {
    return new AsrError(message, "config", provider, false)
  }
  if (lower.includes("etimedout") || lower.includes("timed out") || lower.includes("timeout")) {
    return new AsrError(message, "timeout", provider, true)
  }
  if (
    lower.includes("fetch failed") ||
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("enotfound") ||
    lower.includes("socket hang up")
  ) {
    return new AsrError(message, "server", provider, true)
  }

  return new AsrError(message, "unknown", provider, true)
}

/** Throws an AsrError built from a non-OK fetch response. */
export async function throwForResponse(
  response: Response,
  provider: string,
  context: string
): Promise<never> {
  const body = await response.text().catch(() => "")
  const { kind, retryable } = classifyHttpStatus(response.status)

  throw new AsrError(
    redactAsrErrorMessage(`${context} failed with HTTP ${response.status}${body ? `: ${body}` : ""}`),
    kind,
    provider,
    retryable,
    response.status
  )
}

const mediaSpecificErrors = new WeakSet<Error>()

/**
 * Flags an error caused by this particular media (e.g. too large for the
 * blob handoff) rather than by the provider, so the circuit breaker does
 * not penalize the provider for it.
 */
export function markMediaSpecific<T extends Error>(error: T): T {
  mediaSpecificErrors.add(error)
  return error
}

export function isMediaSpecific(error: Error): boolean {
  return mediaSpecificErrors.has(error)
}
