/**
 * Request ids (docs/parity/m10.md, "Request ids"). The proxy accepts an
 * incoming `x-request-id` only when it matches `^[A-Za-z0-9._-]{8,64}$`
 * (no newlines or control characters, so no log injection); anything else is
 * replaced by a fresh UUID. Edge-safe: no Node-only imports.
 */
export const REQUEST_ID_HEADER = "x-request-id"

const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/

export function isValidRequestId(value: string | null | undefined): value is string {
  return typeof value === "string" && VALID_REQUEST_ID.test(value)
}

const WORD_SEGMENT = /^(?:[a-z][a-z-]{0,39}|v\d{1,2})$/

/**
 * A loggable route for a request URL: the path only (never the query), with
 * every segment that is not a plain lowercase word (ids, share tokens,
 * emails) replaced by `[id]`, e.g. `/api/share/[id]/verify`.
 */
export function routeTemplate(url: string): string {
  let pathname: string

  try {
    pathname = new URL(url, "http://route.invalid").pathname
  } catch {
    return "[invalid]"
  }

  return pathname
    .split("/")
    .map((segment) => (segment === "" || WORD_SEGMENT.test(segment) ? segment : "[id]"))
    .join("/")
    .slice(0, 200)
}

/** The incoming id when valid, otherwise a new UUID. */
export function resolveRequestId(incoming: string | null | undefined): string {
  return isValidRequestId(incoming) ? incoming : crypto.randomUUID()
}
