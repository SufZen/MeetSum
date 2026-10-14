/**
 * Integration error safety (docs/parity/m8.md, "Token secrecy" and
 * "Outbound HTTP"). Owner: Package A.
 *
 * Two rules:
 *  1. **Stored errors** (`integration_connections.last_error`,
 *     `integration_deliveries.last_error`, API `lastError`) are never free
 *     text. `storedIntegrationError` builds them only from typed fields: a
 *     code from `INTEGRATION_ERROR_CODES`, the ProviderError kind, the
 *     provider id, the HTTP status and a provider error code matching
 *     `[a-z_]{1,64}` (e.g. Slack's `channel_not_found`). Messages, bodies,
 *     URLs and `cause` chains never reach a column.
 *  2. **Logs** go through `integrationLog`, which runs every value through
 *     `redactIntegrationError`: the M7 bot redactor (query strings, Bearer
 *     and key=value secrets, long base64/hex blobs) plus Slack `xox*`/`xapp`
 *     tokens, Notion `secret_*`/`ntn_*` tokens, token-in-path segments
 *     (`/access-tokens/{t}`, `/refresh-tokens/{t}`), OAuth `code`s and email
 *     addresses, capped at 500 characters. `cause` is never read.
 *
 * ProviderErrors raised by Package A carry fixed messages (no provider
 * text) and no `cause`.
 */
import { redactBotText } from "@/lib/bot/redact"
import { getLogger } from "@/lib/log"
import {
  ProviderError,
  type IntegrationErrorCode,
  type ProviderErrorKind,
} from "@/lib/integrations/core/types"

export const MAX_INTEGRATION_ERROR_LENGTH = 500
const REDACT_INPUT_MAX = 4000

/** A provider error code safe to store and show (`[a-z_]{1,64}`), else undefined. */
export function safeProviderCode(code: unknown): string | undefined {
  if (typeof code !== "string") return undefined

  const lowered = code.trim().toLowerCase()

  return /^[a-z_]{1,64}$/.test(lowered) ? lowered : undefined
}

/** ProviderError with the HTTP status of the failed provider response. */
export class ProviderHttpError extends ProviderError {
  readonly status: number

  constructor(
    kind: ProviderErrorKind,
    provider: string,
    status: number,
    options: { retryAfterMs?: number; providerCode?: string } = {}
  ) {
    const providerCode = safeProviderCode(options.providerCode)

    super(kind, `${provider} request failed (${status}${providerCode ? ` ${providerCode}` : ""})`, {
      ...(options.retryAfterMs !== undefined ? { retryAfterMs: options.retryAfterMs } : {}),
      ...(providerCode ? { providerCode } : {}),
    })
    this.status = status
  }
}

function stringify(input: unknown): string {
  // Only the message: `cause`, stacks and own properties are never read.
  if (input instanceof Error) return input.message
  if (typeof input === "string") return input
  if (input === null || input === undefined) return ""
  if (typeof input === "object") {
    try {
      return JSON.stringify(input) ?? ""
    } catch {
      return "[unserializable]"
    }
  }
  return String(input)
}

/** Redacted, single-line, ≤ 500 characters, for logs only. Never throws. */
export function redactIntegrationError(input: unknown): string {
  let text: string

  try {
    text = redactBotText(stringify(input).slice(0, REDACT_INPUT_MAX))
      // Slack tokens (xoxb-, xoxp-, xoxe-, xapp-…), Notion secrets.
      .replace(/\bx(?:ox[a-z]|app)-[A-Za-z0-9-]+/gi, "[redacted]")
      .replace(/\b(?:secret|ntn)_[A-Za-z0-9]+/g, "[redacted]")
      // Token-in-path endpoints (HubSpot's legacy `/oauth/v1/access-tokens/{t}`
      // and `/oauth/v1/refresh-tokens/{t}`): the path segment is the secret.
      .replace(/(\/(?:access|refresh)-tokens\/)[^/?#\s"']+/gi, "$1[redacted]")
      // OAuth codes and verifiers (`code=…`, `"code":"…"`).
      .replace(/(["']?)\b(code|code_verifier|state)\b\1(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&"'}\]]+)/gi, "$1$2$1$3[redacted]")
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
      .replace(/\s+/g, " ")
      .trim()
  } catch {
    text = "[unredactable error]"
  }

  text ||= "unknown error"
  return text.length > MAX_INTEGRATION_ERROR_LENGTH ? `${text.slice(0, MAX_INTEGRATION_ERROR_LENGTH - 1)}…` : text
}

/** Typed code for a ProviderError kind (the stored error enum). */
export function errorCodeForKind(kind: ProviderErrorKind | undefined): IntegrationErrorCode {
  switch (kind) {
    case "auth":
    case "forbidden":
      return "forbidden"
    case "config":
      return "not_configured"
    default:
      return "unknown"
  }
}

const KINDS: readonly ProviderErrorKind[] = ["auth", "forbidden", "not_found", "invalid", "rate_limited", "retryable", "config"]

/**
 * The only error text ever stored or returned: typed fields, no message.
 * e.g. `code=unknown kind=invalid provider=slack status=404 provider_code=channel_not_found`.
 */
export function storedIntegrationError(error: unknown, provider?: string): string {
  const kind = error instanceof ProviderError && KINDS.includes(error.kind) ? error.kind : "retryable"
  const status = error instanceof ProviderHttpError && Number.isInteger(error.status) ? error.status : undefined
  const providerCode = error instanceof ProviderError ? safeProviderCode(error.providerCode) : undefined
  const parts = [`code=${errorCodeForKind(kind)}`, `kind=${kind}`]

  if (provider && /^[a-z_]{1,32}$/.test(provider)) parts.push(`provider=${provider}`)
  if (status !== undefined) parts.push(`status=${status}`)
  if (providerCode) parts.push(`provider_code=${providerCode}`)

  return parts.join(" ")
}

const STORED_PATTERN = /^code=[a-z_]+ kind=[a-z_]+( provider=[a-z_]+)?( status=\d{3})?( provider_code=[a-z_]{1,64})?$/

/** A stored error as the API returns it; anything not in the typed shape is dropped. */
export function publicIntegrationError(stored: string | undefined): string | undefined {
  if (!stored) return undefined

  return STORED_PATTERN.test(stored) ? stored : "code=unknown kind=retryable"
}

/** Logging that always goes through redaction. */
export const integrationLog = {
  warn(message: string, detail?: unknown) {
    getLogger({ component: "integrations" }).warn(
      detail === undefined ? {} : { detail: redactIntegrationError(detail) },
      redactIntegrationError(message)
    )
  },
  error(message: string, detail?: unknown) {
    getLogger({ component: "integrations" }).error(
      detail === undefined ? {} : { detail: redactIntegrationError(detail) },
      redactIntegrationError(message)
    )
  },
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

/** ProviderHttpError for a non-2xx response; no provider text, only status and a safe code. */
export function providerErrorForResponse(
  provider: string,
  response: Pick<Response, "status" | "headers">,
  providerCode?: string,
  kind: ProviderErrorKind = kindForStatus(response.status)
): ProviderHttpError {
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"))

  return new ProviderHttpError(kind, provider, response.status, {
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(providerCode ? { providerCode } : {}),
  })
}

/** Network failures, timeouts and unknown errors become `retryable` (fixed message, no cause). */
export function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error

  return new ProviderError("retryable", "provider call failed")
}

/** Kinds that never succeed on retry (the delivery fails immediately). */
export function isUnrecoverableKind(kind: ProviderErrorKind): boolean {
  return kind === "auth" || kind === "forbidden" || kind === "invalid" || kind === "not_found" || kind === "config"
}
