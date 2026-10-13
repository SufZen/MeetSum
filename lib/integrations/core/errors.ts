/**
 * Integration error redaction and mapping (docs/parity/m8.md, "Token
 * secrecy" and "Outbound HTTP"). Owner: Package A.
 *
 * Every error text that is stored (`last_error`), logged or put in a job
 * passes through `redactIntegrationError`. Provider response bodies are
 * never reflected to clients; routes answer with fixed codes only.
 */
import { ProviderError, type ProviderErrorKind } from "@/lib/integrations/core/types"

export const MAX_INTEGRATION_ERROR_LENGTH = 500

const REDACTIONS: readonly [RegExp, string][] = [
  // Authorization headers and bearer tokens.
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 ***"],
  // Slack tokens (xoxb-, xoxp-, xoxe-, xapp-…), even without a prefix word.
  [/\bx(?:ox[a-z]|app)-[A-Za-z0-9-]+/gi, "***"],
  // key=value / "key":"value" pairs that carry secrets or OAuth codes.
  [
    /((?:access_token|refresh_token|id_token|client_secret|code_verifier|code|token|secret|password|api_key|apikey)["']?\s*[:=]\s*["']?)[^"'&\s,}]+/gi,
    "$1***",
  ],
  // Email addresses.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "***"],
  // Long opaque strings (JWTs, raw tokens).
  [/\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?\b/g, "***"],
]

/** Redacted, single-line, ≤ 500 characters. Never throws. */
export function redactIntegrationError(error: unknown): string {
  let text: string

  try {
    if (error instanceof Error) text = `${error.name === "Error" ? "" : `${error.name}: `}${error.message}`
    else if (typeof error === "string") text = error
    else text = JSON.stringify(error) ?? String(error)
  } catch {
    text = "unknown error"
  }

  for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement)

  text = text.replace(/[\r\n\t]+/g, " ").trim() || "unknown error"

  return text.length > MAX_INTEGRATION_ERROR_LENGTH ? `${text.slice(0, MAX_INTEGRATION_ERROR_LENGTH - 1)}…` : text
}

/** `Retry-After` (seconds or HTTP date) → milliseconds, capped at 1 h. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined

  const seconds = Number(value)
  let ms: number | undefined

  if (Number.isFinite(seconds) && seconds >= 0) ms = seconds * 1000
  else {
    const date = Date.parse(value)

    if (Number.isFinite(date)) ms = Math.max(0, date - now)
  }

  return ms === undefined ? undefined : Math.min(ms, 60 * 60_000)
}

/** Kind for a provider HTTP status (body never inspected here). */
export function kindForStatus(status: number): ProviderErrorKind {
  if (status === 401) return "auth"
  if (status === 403) return "forbidden"
  if (status === 404 || status === 410) return "not_found"
  if (status === 429) return "rate_limited"
  if (status >= 500 || status === 408) return "retryable"
  return "invalid"
}

/** ProviderError for a non-2xx response; the message holds no provider text. */
export function providerErrorForResponse(
  provider: string,
  response: Pick<Response, "status" | "headers">,
  providerCode?: string
): ProviderError {
  const kind = kindForStatus(response.status)
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"))

  return new ProviderError(kind, `${provider} request failed (${response.status}${providerCode ? ` ${providerCode}` : ""})`, {
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(providerCode ? { providerCode: providerCode.slice(0, 80) } : {}),
  })
}

/** Network failures, timeouts and unknown errors become `retryable`. */
export function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error

  return new ProviderError("retryable", redactIntegrationError(error), { cause: error })
}

/** Kinds that never succeed on retry (the delivery fails immediately). */
export function isUnrecoverableKind(kind: ProviderErrorKind): boolean {
  return kind === "auth" || kind === "forbidden" || kind === "invalid" || kind === "not_found" || kind === "config"
}
