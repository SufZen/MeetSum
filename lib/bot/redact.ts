/**
 * Redaction for bot error text stored in bot_sessions.error, bot_events and
 * logs (M7 A1 redaction rules). Owned by Package A. It strips:
 * - every URL query string and fragment (Meet/Teams/Zoom join tokens, Teams
 *   `context`, presigned `X-Amz-*` recording URLs): scheme, host and path are
 *   kept and the query becomes `?[redacted]`;
 * - meeting passcodes and passwords: `pwd=`, `p=`, `passcode`, `password`,
 *   `meeting_password` as query params, `key: value` pairs or JSON fields;
 * - `X-API-Key`, `Authorization`, Bearer values, webhook secrets, tokens and
 *   signatures;
 * - long base64/base64url/hex blobs;
 * then truncates to at most {@link BOT_REDACT_MAX_LENGTH} characters.
 */
import { getLogger } from "@/lib/log"

export const BOT_REDACT_MAX_LENGTH = 300
const REDACT_INPUT_MAX = 4000

const SECRET_KEYS = [
  "meeting_password",
  "meetingpassword",
  "passcode",
  "password",
  "passwd",
  "pwd",
  "webhook_secret",
  "webhooksecret",
  "client_secret",
  "secret",
  "access_token",
  "refresh_token",
  "id_token",
  "token",
  "api_key",
  "apikey",
  "api-key",
  "x-api-key",
  "x-webhook-signature",
  "signature",
  "authorization",
  "x-amz-[a-z-]+",
].join("|")

// `"key": "value"`, `key=value`, `key: value`; the value may be quoted.
const KEY_VALUE = new RegExp(
  `(["']?)\\b(${SECRET_KEYS})\\b\\1(\\s*[:=]\\s*)("(?:[^"\\\\]|\\\\.)*"|'[^']*'|(?:bearer|basic)\\s+[^\\s,;&"'}\\]]+|[^\\s,;&"'}\\]]+)`,
  "gi"
)

function stringify(input: unknown): string {
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

function hasLetterAndDigit(value: string) {
  return /[A-Za-z]/.test(value) && /\d/.test(value)
}

export function redactBotText(raw: string): string {
  return (
    raw
      // URL query strings and fragments (scheme://host/path kept).
      // Bounded repetition only: input is attacker-influenced (Vexa bodies, URLs).
      .replace(/\b([a-z][a-z0-9+.-]{0,30}:\/\/[^\s?#"'<>`]{1,2048})[?#][^\s"'<>`]*/gi, "$1?[redacted]")
      // Scheme-less join links (`zoom.us/j/1?pwd=...`): any `host/path?query`.
      .replace(/\b([a-z0-9.-]{1,253}\/[^\s?#"'<>`]{0,2048})[?#][^\s"'<>`]*/gi, "$1?[redacted]")
      .replace(KEY_VALUE, (_match, quote: string, key: string, separator: string, value: string) => {
        const quoted = value.startsWith('"') || value.startsWith("'")
        const replacement = quoted ? `${value[0]}[redacted]${value[0]}` : "[redacted]"

        return `${quote}${key}${quote}${separator}${replacement}`
      })
      .replace(/\bbearer\s+(?!\[redacted\])[^\s,;"'}\]]+/gi, "Bearer [redacted]")
      // Bare `p=` (Teams passcode) when it survived outside a URL.
      .replace(/(^|[^A-Za-z0-9_])p=[^\s&,;"'}\]]+/g, "$1p=[redacted]")
      .replace(/\b[A-Fa-f0-9]{32,512}\b/g, "[hex]")
      .replace(/[A-Za-z0-9+_-]{40,}={0,2}/g, (match) => (hasLetterAndDigit(match) ? "[blob]" : match))
  )
}

/**
 * Redacts and truncates anything (Error, string, object) for storage or logs.
 * `maxLength` is clamped to {@link BOT_REDACT_MAX_LENGTH}.
 */
export function redactBotError(input: unknown, maxLength = BOT_REDACT_MAX_LENGTH): string {
  const limit = Math.max(1, Math.min(BOT_REDACT_MAX_LENGTH, Math.floor(maxLength)))
  // Output is at most 300 characters: bound the regex work on huge inputs.
  const redacted = redactBotText(stringify(input).slice(0, REDACT_INPUT_MAX)).replace(/\s+/g, " ").trim()

  return redacted.length > limit ? `${redacted.slice(0, limit - 1)}…` : redacted
}

/** Removes literal secrets (an API key, a decrypted passcode) before redaction. */
export function scrubSecrets(text: string, secrets: readonly (string | undefined | null)[]): string {
  let result = text

  for (const secret of secrets) {
    if (secret && secret.length >= 3) result = result.split(secret).join("[redacted]")
  }

  return result
}

/**
 * Bot logging (M10 B1): a thin wrapper over the server logger
 * (`getLogger({ component: "bot" })`) that still runs the bot redactor on the
 * message and detail before the logger's own two redaction layers.
 */
export const botLog = {
  info(message: string, detail?: unknown) {
    getLogger({ component: "bot" }).info(detail === undefined ? {} : { detail: redactBotError(detail) }, redactBotError(message))
  },
  error(message: string, detail?: unknown) {
    getLogger({ component: "bot" }).error(detail === undefined ? {} : { detail: redactBotError(detail) }, redactBotError(message))
  },
}
