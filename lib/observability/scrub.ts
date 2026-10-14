/**
 * PII scrubbing for Sentry events and breadcrumbs (docs/parity/m10.md,
 * "Sentry"). Pure functions with no Sentry runtime import, so they are
 * unit-tested without a DSN.
 *
 * - request cookies, headers, body (`data`) and query string are dropped; the
 *   URL loses its query;
 * - `user.email` and `user.ip_address` are dropped;
 * - messages, exception values, `extra` and `contexts` go through the
 *   logger's `scrub()` (secret keys, content keys, emails, URL queries, the
 *   bot/integration/ASR redactors);
 * - breadcrumb URLs lose their query; breadcrumb messages and data are scrubbed.
 */
import type { Breadcrumb, ErrorEvent } from "@sentry/node"

import { scrub } from "@/lib/log"
import { redactErrorMessage, scrubString } from "@/lib/log/redact"

function stripQuery(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined

  const cut = url.search(/[?#]/)

  return cut >= 0 ? url.slice(0, cut) : url
}

function scrubRecord<T extends Record<string, unknown> | undefined>(value: T): T {
  return value ? scrub(value) : value
}

function scrubBreadcrumbFields(breadcrumb: Breadcrumb): Breadcrumb {
  const out: Breadcrumb = { ...breadcrumb }

  if (typeof out.message === "string") out.message = scrubString(redactErrorMessage(out.message))
  if (out.data) {
    const data = { ...out.data }

    for (const key of ["url", "from", "to"]) {
      if (typeof data[key] === "string") data[key] = stripQuery(data[key])
    }

    out.data = scrub(data)
  }

  return out
}

/** `beforeSend`: returns a scrubbed copy of the event (never drops it). */
export function scrubSentryEvent(event: ErrorEvent): ErrorEvent {
  const out: ErrorEvent = { ...event }

  if (out.request) {
    const { cookies: _cookies, headers: _headers, data: _data, query_string: _query, env: _env, ...rest } = out.request

    void _cookies
    void _headers
    void _data
    void _query
    void _env
    out.request = { ...rest, url: stripQuery(rest.url) }
  }

  if (out.user) {
    const { email: _email, ip_address: _ip, username: _username, ...rest } = out.user

    void _email
    void _ip
    void _username
    out.user = rest
  }

  if (typeof out.message === "string") out.message = scrubString(redactErrorMessage(out.message))
  if (out.logentry) {
    out.logentry = {
      ...out.logentry,
      message: typeof out.logentry.message === "string" ? scrubString(redactErrorMessage(out.logentry.message)) : out.logentry.message,
      params: undefined,
    }
  }

  if (out.exception?.values) {
    out.exception = {
      ...out.exception,
      values: out.exception.values.map((value) => ({
        ...value,
        value: typeof value.value === "string" ? redactErrorMessage(value.value) : value.value,
        stacktrace: value.stacktrace
          ? {
              ...value.stacktrace,
              // Local variables can hold anything (tokens, transcript text).
              frames: value.stacktrace.frames?.map(({ vars: _vars, ...frame }) => {
                void _vars
                return frame
              }),
            }
          : value.stacktrace,
      })),
    }
  }

  out.extra = scrubRecord(out.extra)
  out.contexts = scrubRecord(out.contexts as Record<string, unknown> | undefined) as ErrorEvent["contexts"]
  out.tags = scrubRecord(out.tags as Record<string, unknown> | undefined) as ErrorEvent["tags"]
  if (out.breadcrumbs) out.breadcrumbs = out.breadcrumbs.map(scrubBreadcrumbFields)

  return out
}

/** `beforeBreadcrumb`: scrubbed copy (URLs without query, scrubbed message/data). */
export function scrubSentryBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  return scrubBreadcrumbFields(breadcrumb)
}
