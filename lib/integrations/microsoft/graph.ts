/**
 * Microsoft identity platform + Graph HTTP helpers (docs/parity/m8.md, B1/B2).
 * Every call goes through the injected `ProviderFetch` (A's `providerFetch`:
 * host allowlist, redirect refusal, time and size caps). Errors become
 * `ProviderError`s with fixed messages: provider bodies are never reflected,
 * only the provider's short error *code* (e.g. `syncStateNotFound`) is kept.
 */
import { ProviderError, type ProviderErrorKind, type ProviderFetch } from "@/lib/integrations/core/types"

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0"
export const LOGIN_BASE = "https://login.microsoftonline.com"

/** Codes meaning the grant is dead and the user must reconnect. */
const REAUTH_CODES = ["invalid_grant", "interaction_required", "consent_required", "login_required"]
/**
 * AADSTS70008x (expired/revoked refresh token, e.g. 700082, 700084) and
 * AADSTS50173 (grant revoked after a password change). Verify against
 * current Entra error-code docs.
 */
const REAUTH_AADSTS = /\bAADSTS70008\d*\b|\bAADSTS50173\b/

const SAFE_CODE = /^[A-Za-z0-9_.-]{1,64}$/

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after")

  if (!header) return undefined

  const seconds = Number(header)

  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000))

  const date = Date.parse(header)

  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined
}

function kindForStatus(status: number): ProviderErrorKind {
  if (status === 401) return "auth"
  if (status === 403) return "forbidden"
  if (status === 404 || status === 410) return "not_found"
  if (status === 429) return "rate_limited"
  if (status >= 500) return "retryable"
  return "invalid"
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

function safeCode(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_CODE.test(value) ? value : undefined
}

/** Maps a failed identity-platform (token endpoint) response. */
export async function tokenEndpointError(response: Response): Promise<ProviderError> {
  const body = (await readJson(response)) as { error?: unknown; error_description?: unknown } | undefined
  const code = safeCode(body?.error)
  const description = typeof body?.error_description === "string" ? body.error_description : ""

  if ((code && REAUTH_CODES.includes(code)) || REAUTH_AADSTS.test(description)) {
    return new ProviderError("auth", "microsoft token grant rejected", { providerCode: code ?? "invalid_grant" })
  }
  if (response.status === 429) {
    return new ProviderError("rate_limited", "microsoft token endpoint rate limited", { retryAfterMs: retryAfterMs(response) })
  }
  if (response.status >= 500) return new ProviderError("retryable", `microsoft token endpoint ${response.status}`)
  if (code === "invalid_client" || code === "unauthorized_client") {
    return new ProviderError("config", "microsoft client rejected", { providerCode: code })
  }
  return new ProviderError("invalid", `microsoft token endpoint ${response.status}`, { providerCode: code })
}

/**
 * Maps a failed Graph response. 410 keeps `syncStateNotFound` for a delta
 * reset. Verified 2026-10-14 (https://learn.microsoft.com/en-us/graph/errors):
 * apps should walk the nested `innererror` codes, and an expired delta token
 * can surface as a 40X with `syncStateNotFound` there, so that code wins.
 */
export async function graphError(response: Response): Promise<ProviderError> {
  const body = (await readJson(response)) as
    | { error?: { code?: unknown; innererror?: { code?: unknown; innererror?: { code?: unknown } } } }
    | undefined
  const nested = [body?.error?.innererror?.code, body?.error?.innererror?.innererror?.code].map(safeCode)
  const code = nested.includes("syncStateNotFound") ? "syncStateNotFound" : safeCode(body?.error?.code)
  const kind = kindForStatus(response.status)

  return new ProviderError(kind, `graph ${response.status}`, {
    providerCode: response.status === 410 ? (code ?? "syncStateNotFound") : code,
    retryAfterMs: kind === "rate_limited" || kind === "retryable" ? retryAfterMs(response) : undefined,
  })
}

export async function graphGet<T>(
  fetch: ProviderFetch,
  accessToken: string,
  url: string,
  headers: Record<string, string> = {}
): Promise<T> {
  if (!url.startsWith(`${GRAPH_BASE}/`)) {
    // nextLink/deltaLink come from Graph; anything else is refused.
    throw new ProviderError("invalid", "graph url outside v1.0")
  }

  const response = await fetch("microsoft", url, {
    method: "GET",
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json", ...headers },
  })

  if (!response.ok) throw await graphError(response)
  return (await response.json()) as T
}

/** True for a Graph 410 / `syncStateNotFound` (delta token expired). */
export function isSyncStateLost(error: unknown): boolean {
  return (
    error instanceof ProviderError &&
    (error.providerCode === "syncStateNotFound" || error.providerCode === "resyncRequired" || error.message === "graph 410")
  )
}
