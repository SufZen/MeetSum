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

  const message = error instanceof Error ? error.message : String(error)
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
    `${context} failed with HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ""}`,
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
