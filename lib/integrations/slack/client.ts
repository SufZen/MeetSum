/**
 * Slack Web API client (docs/parity/m8.md A9). Owner: Package A. Every call
 * goes through `providerFetch("slack", …)`. Slack reports most errors as
 * HTTP 200 with `ok:false`; they map to ProviderError kinds with the Slack
 * error code as an allowlisted `providerCode` (never the body).
 */
import { parseRetryAfter, ProviderHttpError, safeProviderCode } from "@/lib/integrations/core/errors"
import { providerFetch, readJson } from "@/lib/integrations/core/http"
import type { ProviderErrorKind, ProviderFetch } from "@/lib/integrations/core/types"

export const SLACK_API = "https://slack.com/api"

const AUTH_ERRORS = new Set(["invalid_auth", "token_revoked", "account_inactive", "not_authed", "token_expired", "invalid_refresh_token"])
const INVALID_DESTINATION = new Set(["not_in_channel", "channel_not_found", "is_archived"])
const FORBIDDEN = new Set(["missing_scope", "restricted_action", "no_permission", "ekm_access_denied"])

export function slackErrorKind(code: string | undefined, status: number): ProviderErrorKind {
  if (status === 429 || code === "ratelimited" || code === "rate_limited") return "rate_limited"
  if (code && AUTH_ERRORS.has(code)) return "auth"
  if (code && INVALID_DESTINATION.has(code)) return "invalid"
  if (code && FORBIDDEN.has(code)) return "forbidden"
  if (status >= 500 || code === "internal_error" || code === "fatal_error" || code === "service_unavailable" || code === "request_timeout") {
    return "retryable"
  }
  if (status === 401) return "auth"
  if (status === 403) return "forbidden"
  return "invalid"
}

export type SlackResponse = Record<string, unknown> & { ok?: boolean; error?: string }

/** POSTs a Web API method; JSON body by default, form when `form` is set. */
export async function slackCall(
  method: string,
  params: Record<string, unknown>,
  options: { token?: string; form?: boolean; basicAuth?: string; fetch?: ProviderFetch } = {}
): Promise<SlackResponse> {
  const headers: Record<string, string> = {}

  if (options.token) headers.authorization = `Bearer ${options.token}`
  if (options.basicAuth) headers.authorization = `Basic ${options.basicAuth}`

  let body: string

  if (options.form) {
    headers["content-type"] = "application/x-www-form-urlencoded"
    body = new URLSearchParams(
      Object.entries(params)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => [key, String(value)])
    ).toString()
  } else {
    headers["content-type"] = "application/json; charset=utf-8"
    body = JSON.stringify(params)
  }

  const response = await (options.fetch ?? providerFetch)("slack", `${SLACK_API}/${method}`, { method: "POST", headers, body })
  const json = await readJson<SlackResponse>(response)

  if (response.ok && json?.ok) return json

  const code = safeProviderCode(json?.error) ?? (response.status === 429 ? "ratelimited" : undefined)
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"))

  throw new ProviderHttpError(slackErrorKind(code, response.status), "slack", response.status, {
    ...(code ? { providerCode: code } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  })
}

/** Localized hint for a destination error (`not_in_channel` …), for the UI. */
export function slackDestinationHint(code: string | undefined, locale: "he" | "en"): string | undefined {
  const hints: Record<string, Record<"he" | "en", string>> = {
    not_in_channel: { he: "יש להזמין את MeetSum לערוץ", en: "Invite the MeetSum app to the channel" },
    channel_not_found: { he: "הערוץ לא נמצא", en: "Channel not found" },
    is_archived: { he: "הערוץ בארכיון", en: "The channel is archived" },
  }

  return code ? hints[code]?.[locale] : undefined
}
