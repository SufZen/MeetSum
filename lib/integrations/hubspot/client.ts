/**
 * HubSpot HTTP (docs/parity/m8.md, B3). Every call goes through the injected
 * `ProviderFetch` (A's allowlisted `providerFetch`), sequentially (Search is
 * about 5 requests/s per account; the general limit is about 100 per 10 s).
 * Errors become `ProviderError`s with fixed messages; only HubSpot's short
 * `category` code is kept. 429 honours `Retry-After`.
 */
import { ProviderError, type ProviderErrorKind, type ProviderFetch } from "@/lib/integrations/core/types"

export const HUBSPOT_API = "https://api.hubapi.com"

const SAFE_CODE = /^[A-Za-z0-9_.-]{1,64}$/
/** HubSpot sends `Retry-After` rarely; its secondly/10-second windows suggest 10 s. */
const DEFAULT_RETRY_AFTER_MS = 10_000

function kindForStatus(status: number): ProviderErrorKind {
  if (status === 401) return "auth"
  if (status === 403) return "forbidden"
  if (status === 404) return "not_found"
  if (status === 429) return "rate_limited"
  if (status >= 500) return "retryable"
  return "invalid"
}

function retryAfterMs(response: Response): number {
  const seconds = Number(response.headers.get("retry-after"))

  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : DEFAULT_RETRY_AFTER_MS
}

export async function hubspotError(response: Response): Promise<ProviderError> {
  let category: string | undefined

  try {
    const body = (await response.json()) as { category?: unknown; status?: unknown; error?: unknown }
    const candidate = [body.category, body.status, body.error].find((value) => typeof value === "string")

    category = typeof candidate === "string" && SAFE_CODE.test(candidate) ? candidate : undefined
  } catch {
    category = undefined
  }

  const kind = kindForStatus(response.status)

  return new ProviderError(kind, `hubspot ${response.status}`, {
    providerCode: category,
    retryAfterMs: kind === "rate_limited" ? retryAfterMs(response) : undefined,
  })
}

export type HubspotClient = {
  request<T>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T>
}

/** A client bound to one access token. `path` must start with `/`. */
export function createHubspotClient(fetch: ProviderFetch, accessToken: string): HubspotClient {
  return {
    async request<T>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
      if (!path.startsWith("/")) throw new ProviderError("invalid", "hubspot path must be absolute")

      const response = await fetch("hubspot", `${HUBSPOT_API}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })

      if (!response.ok) throw await hubspotError(response)
      if (response.status === 204) return undefined as T

      const text = await response.text()

      return (text ? JSON.parse(text) : undefined) as T
    },
  }
}
