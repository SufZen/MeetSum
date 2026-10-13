/**
 * The second redaction layer of the server logger (docs/parity/m10.md,
 * "Observability" → Redaction). pino's `redact.paths` is the first layer; this
 * deep scrub runs on every log object (and on Sentry events) and:
 *
 * - replaces values under secret-ish keys with "[redacted]" at any depth;
 * - replaces values under content keys (transcript, summary, question,
 *   comment, prompt, answer text) with "[omitted]": user content is never
 *   logged;
 * - masks email addresses inside strings (`dana@example.com` → `d***@example.com`);
 * - strips query strings and fragments from URL-shaped strings;
 * - runs the bot, integration and ASR redactors on error messages and stacks.
 *
 * Pure and never throws. Depth is capped at {@link SCRUB_MAX_DEPTH}.
 */
import { redactAsrErrorMessage } from "@/lib/ai/asr/errors"
import { redactBotText } from "@/lib/bot/redact"
import { redactIntegrationError } from "@/lib/integrations/core/errors"

/** Layer 1: pino `redact.paths` (censor "[redacted]"). */
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.idToken",
  "*.password",
  "*.passwordHash",
  "*.secret",
  "*.clientSecret",
  "*.apiKey",
  "*.passcode",
  "*.code",
  "*.codeVerifier",
  "*.authorization",
  "*.cookie",
]

export const REDACTED = "[redacted]"
export const OMITTED = "[omitted]"
export const SCRUB_MAX_DEPTH = 4
const MAX_STRING = 4000
const MAX_STACK = 4000

/** Keys whose values are secrets (matched anywhere in the key name). */
export const SECRET_KEY = /token|secret|password|passcode|authori[sz]ation|cookie|api[-_]?key|verifier|signature|credential|private[-_]?key|^code$|^otp$/i

/** Keys whose values are user content (exact key names, case-insensitive). */
export const CONTENT_KEY =
  /^(text|transcript|transcripttext|segments?|summary|summarytext|question|questions|answer|answers|comment|comments|commenttext|prompt|prompts|completion|messages|content|body|notes|html|markdown)$/i

const EMAIL = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g
const URL_QUERY = /\b([a-z][a-z0-9+.-]{0,30}:\/\/[^\s?#"'<>`]{1,2048})[?#][^\s"'<>`]*/gi

/** `dana@example.com` → `d***@example.com`. */
export function maskEmails(value: string): string {
  return value.replace(EMAIL, "$1***@$2")
}

/** Masks emails and strips URL query strings in a free-form string. */
export function scrubString(value: string): string {
  const bounded = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value

  return maskEmails(bounded.replace(URL_QUERY, "$1?[redacted]"))
}

function safe(fn: (input: string) => string, input: string): string {
  try {
    return fn(input)
  } catch {
    return REDACTED
  }
}

/** Error message: bot + integration + ASR redactors, then email masking. */
export function redactErrorMessage(message: string): string {
  const redacted = safe(
    (text) => redactAsrErrorMessage(redactIntegrationError(text)),
    message.slice(0, MAX_STRING)
  )

  return maskEmails(redacted)
}

/**
 * Error stack: the first line (the message) is replaced by the redacted
 * message; frames go through the bot redactor (query strings, key=value
 * secrets, long blobs) and email masking.
 */
export function redactErrorStack(stack: string, redactedMessage: string, name = "Error"): string {
  const lines = stack.slice(0, MAX_STACK).split("\n")
  const frameStart = lines.findIndex((line) => /^\s+at\s/.test(line))
  const frames = frameStart >= 0 ? lines.slice(frameStart) : []
  const head = `${name}: ${redactedMessage}`

  if (frames.length === 0) return head

  return [head, ...frames.map((frame) => maskEmails(safe(redactBotText, frame)))].join("\n")
}

function scrubError(error: Error, depth: number): Record<string, unknown> {
  const message = redactErrorMessage(error.message ?? "")
  const out: Record<string, unknown> = { type: error.name, message }

  if (typeof error.stack === "string") out.stack = redactErrorStack(error.stack, message, error.name)

  const code = (error as { code?: unknown }).code

  if (typeof code === "string" || typeof code === "number") out.code = code

  const status = (error as { status?: unknown }).status

  if (typeof status === "number") out.status = status

  const kind = (error as { kind?: unknown }).kind

  if (typeof kind === "string") out.kind = kind

  // `cause` may carry provider bodies: only its redacted message is kept.
  const cause = (error as { cause?: unknown }).cause

  if (cause instanceof Error && depth < SCRUB_MAX_DEPTH) out.cause = { type: cause.name, message: redactErrorMessage(cause.message ?? "") }

  return out
}

function isErrorLike(value: object): value is { message: string; stack?: string; name?: string; type?: string } {
  return (
    typeof (value as { message?: unknown }).message === "string" &&
    (typeof (value as { stack?: unknown }).stack === "string" || typeof (value as { type?: unknown }).type === "string")
  )
}

/** Usage counters (`inputTokens: 1200`) are numbers, not secrets. */
const TOKEN_COUNTER_KEY = /tokens$|token_?count|tokens_?used/i

export function scrubAt(value: unknown, depth: number, key?: string): unknown {
  if (key !== undefined && SECRET_KEY.test(key) && !(typeof value === "number" && TOKEN_COUNTER_KEY.test(key))) {
    return value === undefined ? undefined : REDACTED
  }
  if (key !== undefined && CONTENT_KEY.test(key) && value !== null && value !== undefined && typeof value !== "boolean" && typeof value !== "number") {
    return OMITTED
  }
  if (typeof value === "string") return scrubString(value)
  if (value === null || typeof value !== "object") return value
  if (value instanceof Error) return scrubError(value, depth)
  if (depth >= SCRUB_MAX_DEPTH) return "[truncated]"
  if (Array.isArray(value)) return value.map((item) => scrubAt(item, depth + 1))
  if (value instanceof Date) return value
  if (value instanceof URL) return scrubString(value.toString())

  // A serialized error (pino's err serializer output, a Sentry exception).
  if (key === "err" || key === "error") {
    if (isErrorLike(value)) {
      const message = redactErrorMessage(value.message)
      const out: Record<string, unknown> = {}

      for (const [innerKey, inner] of Object.entries(value)) {
        if (innerKey === "message") out.message = message
        else if (innerKey === "stack" && typeof inner === "string") out.stack = redactErrorStack(inner, message, value.type ?? value.name)
        else out[innerKey] = scrubAt(inner, depth + 1, innerKey)
      }

      return out
    }
  }

  const out: Record<string, unknown> = {}

  for (const [innerKey, inner] of Object.entries(value)) {
    out[innerKey] = scrubAt(inner, depth + 1, innerKey)
  }

  return out
}

/** Deep scrub (see the module comment). Pure: never mutates `value`. */
export function scrubValue<T>(value: T): T {
  try {
    return scrubAt(value, 0) as T
  } catch {
    return REDACTED as unknown as T
  }
}
