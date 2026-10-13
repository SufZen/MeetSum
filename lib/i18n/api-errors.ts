/**
 * User-facing text for failed API responses (docs/parity/m9.md A3).
 *
 * A stable snake_case `error` code maps to `apiErr<PascalCode>` in the
 * dictionary (`lib/i18n/m9/api-error-messages.ts`). In Hebrew the server's
 * English `message` is never shown: an unknown code becomes the localized
 * "Unexpected error (code)" text and a plain message becomes `fallback`.
 * In English the server message is still used when no code matches.
 * Client-safe: never imports the runtime `dictionaries` object.
 */
import { hasHebrew } from "@/lib/i18n/hebrew-text"
import { fillMessage, type MessageValues } from "@/lib/i18n/messages"

type Lookup = Readonly<Record<string, string | undefined>>

const CODE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/

/** `not_found` → `apiErrNotFound`. */
export function apiErrorKey(code: string): string {
  return `apiErr${code
    .split("_")
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : ""))
    .join("")}`
}

/** The stable error code of a response body (`{ error: "not_found" }`), if any. */
export function apiErrorCode(body: unknown): string | undefined {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {}

  for (const value of [record.error, record.code]) {
    if (typeof value === "string" && CODE.test(value)) return value
  }

  return undefined
}

export type ApiErrorParts = {
  /** Localized text. */
  message: string
  /** The unmapped stable code, to render LTR next to the text (`<code dir="ltr">`). */
  code?: string
}

/**
 * Resolves a response body into localized text. `isHebrew` decides whether a
 * server message may be shown (never in Hebrew).
 */
export function resolveApiError(
  body: unknown,
  lookup: (key: string, values?: MessageValues) => string | undefined,
  fallback: string,
  isHebrew: boolean
): ApiErrorParts {
  const code = apiErrorCode(body)

  if (code) {
    const known = lookup(apiErrorKey(code))

    if (known) return { message: known }

    const generic = lookup("coreUnknownErrorCode", { code })

    return { message: generic ?? fallback, code }
  }

  if (!isHebrew) {
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {}

    for (const value of [record.message, record.error]) {
      if (typeof value === "string" && value.trim()) return { message: value }
    }
  }

  return { message: fallback }
}

/**
 * Text for a failed response, given the active locale's dictionary (or any
 * object with the `apiErr*` and `coreUnknownErrorCode` keys).
 */
export function apiErrorMessage(body: unknown, dictionary: Lookup, fallback: string): string {
  const lookup = (key: string, values?: MessageValues) => {
    const template = dictionary[key]

    return template === undefined ? undefined : fillMessage(template, values)
  }
  const isHebrew = hasHebrew(dictionary.coreGenericError ?? dictionary.googleNotConfigured ?? "")

  return resolveApiError(body, lookup, fallback, isHebrew).message
}

/** The same with `useI18n()`'s `t` (which returns the key itself when missing). */
export function apiErrorText(
  body: unknown,
  t: (key: string, values?: MessageValues) => string,
  fallback: string,
  locale: "he" | "en"
): string {
  const lookup = (key: string, values?: MessageValues) => {
    const text = t(key, values)

    return text === key ? undefined : text
  }

  return resolveApiError(body, lookup, fallback, locale === "he").message
}
