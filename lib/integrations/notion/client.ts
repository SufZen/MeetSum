/**
 * Notion REST client (docs/parity/m8.md, C1). Owner: Package C.
 *
 * Every call goes through the injected `providerFetch("notion", …)` (exact
 * host allowlist, no redirects, caps). Errors become `ProviderError`s whose
 * message is a fixed code: Notion's own `message` is never kept, logged or
 * reflected (it can echo ids, names and request details).
 */
import { ProviderError, type ProviderErrorKind, type ProviderFetch } from "@/lib/integrations/core/types"

export const NOTION_API_ORIGIN = "https://api.notion.com"
export const DEFAULT_NOTION_API_VERSION = "2022-06-28"

export type NotionClientContext = {
  fetch: ProviderFetch
  getAccessToken(): Promise<string>
  env?: NodeJS.ProcessEnv
  /** Waits before an in-request retry after a short 429 (tests inject a no-op). */
  sleep?(ms: number): Promise<void>
}

/** `NOTION_API_VERSION` (default 2022-06-28, `database_id` parents). The 2025 data-source API is deferred. */
export function notionApiVersion(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.NOTION_API_VERSION?.trim()

  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : DEFAULT_NOTION_API_VERSION
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after")

  if (!header) return undefined

  const seconds = Number(header)

  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)

  const date = Date.parse(header)

  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now())
}

const SAFE_CODE = /^[a-z_]{1,64}$/

/** Notion status/code → ProviderError (fixed message, never Notion's text). */
export async function notionErrorFrom(response: Response): Promise<ProviderError> {
  const body = (await response.json().catch(() => ({}))) as { code?: unknown; error?: unknown }
  const raw = typeof body.code === "string" ? body.code : typeof body.error === "string" ? body.error : ""
  const code = SAFE_CODE.test(raw) ? raw : undefined
  const status = response.status
  let kind: ProviderErrorKind

  if (status === 401 || code === "unauthorized" || code === "invalid_grant") kind = "auth"
  else if (status === 403 || code === "restricted_resource") kind = "forbidden"
  else if (status === 404 || code === "object_not_found") kind = "not_found"
  else if (status === 429 || code === "rate_limited") kind = "rate_limited"
  else if (status === 400 || status === 409 || status === 422) kind = "invalid"
  else kind = "retryable"

  const retryAfter = kind === "rate_limited" ? (retryAfterMs(response) ?? 1000) : undefined

  return new ProviderError(kind, `notion_${code ?? status}`, {
    ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}),
    ...(code ? { providerCode: code } : {}),
  })
}

const MAX_INLINE_RETRY_MS = 3000

/**
 * One Notion API call. A 429 with a short `Retry-After` (≤ 3 s) is retried
 * in-request up to twice (Notion allows about 3 requests/s); longer waits
 * surface as `rate_limited` so the delivery worker reschedules.
 */
export async function notionRequest<T>(
  context: NotionClientContext,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown
): Promise<T> {
  const token = await context.getAccessToken()
  const sleep = context.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  for (let attempt = 0; ; attempt += 1) {
    const response = await context.fetch("notion", `${NOTION_API_ORIGIN}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "notion-version": notionApiVersion(context.env),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

    if (response.ok) return (await response.json().catch(() => ({}))) as T

    const error = await notionErrorFrom(response)

    if (error.kind === "rate_limited" && attempt < 2 && (error.retryAfterMs ?? 0) <= MAX_INLINE_RETRY_MS) {
      await sleep(error.retryAfterMs ?? 1000)
      continue
    }

    throw error
  }
}
