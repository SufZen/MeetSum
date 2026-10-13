/**
 * Outbound provider HTTP (docs/parity/m8.md, "Outbound HTTP" and "Provider
 * hosts"). Owner: Package A. Every provider API call goes through
 * `providerFetch`:
 *  - https only, exact host match against `PROVIDER_HOSTS` (no env override);
 *  - `redirect: "error"`, 15 s timeout, 2 MB response cap,
 *    `user-agent: MeetSum-Integrations/1`;
 *  - the Microsoft tenant path segment is validated.
 *
 * User-influenced URLs (webhooks, Slack `response_url`) never come here;
 * they use `guardedWebhookFetch` (lib/webhooks/url-guard.ts).
 *
 * Fake mode (dev/e2e only): with `MEETSUM_INTEGRATIONS_FAKE_BASE_URL` set to
 * a loopback origin, every provider URL `https://<host><path>` is rewritten
 * to `<fake>/<host><path>` (the fake server routes on that path). Fake mode
 * is refused in production.
 */
import { oauthRedirectBase } from "@/lib/integrations/core/oauth-state"
import { ProviderError, type ProviderFetch, type ProviderId } from "@/lib/integrations/core/types"

export const PROVIDER_HOSTS: Readonly<Record<ProviderId, readonly string[]>> = {
  slack: ["slack.com"],
  microsoft: ["login.microsoftonline.com", "graph.microsoft.com"],
  notion: ["api.notion.com"],
  hubspot: ["api.hubapi.com"],
  google_drive: ["oauth2.googleapis.com", "www.googleapis.com", "docs.googleapis.com"],
}

/** Browser redirect targets (authorize pages); never fetched. */
export const AUTHORIZE_HOSTS: Readonly<Record<ProviderId, readonly string[]>> = {
  slack: ["slack.com"],
  microsoft: ["login.microsoftonline.com"],
  notion: ["api.notion.com"],
  hubspot: ["app.hubspot.com"],
  google_drive: ["accounts.google.com"],
}

export const PROVIDER_FETCH_TIMEOUT_MS = 15_000
export const PROVIDER_FETCH_MAX_BYTES = 2 * 1024 * 1024
export const PROVIDER_USER_AGENT = "MeetSum-Integrations/1"

type Transport = (url: string, init: RequestInit) => Promise<Response>

let transportOverride: Transport | undefined

/** Tests: replace the underlying fetch (undefined restores `globalThis.fetch`). */
export function setProviderTransportForTesting(transport: Transport | undefined) {
  transportOverride = transport
}

function transport(): Transport {
  return transportOverride ?? ((url, init) => globalThis.fetch(url, init))
}

const TENANT_PATTERN = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|organizations|common|consumers|[a-z0-9.-]+\.[a-z]{2,})$/i

/** GUID, `organizations`, `common`, `consumers`, or a verified domain. */
export function isValidMicrosoftTenant(segment: string): boolean {
  return TENANT_PATTERN.test(segment) && !segment.includes("..")
}

function isProduction(env: NodeJS.ProcessEnv) {
  return env.NODE_ENV === "production"
}

/**
 * The validated fake-provider origin, or undefined when fake mode is off.
 * Throws when set in production or when it is not a loopback http origin.
 */
export function getFakeBaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.MEETSUM_INTEGRATIONS_FAKE_BASE_URL?.trim()

  if (!raw) return undefined
  if (isProduction(env)) {
    throw new ProviderError("config", "MEETSUM_INTEGRATIONS_FAKE_BASE_URL is refused in production")
  }

  let url: URL

  try {
    url = new URL(raw)
  } catch {
    throw new ProviderError("config", "MEETSUM_INTEGRATIONS_FAKE_BASE_URL is not a URL")
  }

  if (
    url.protocol !== "http:" ||
    (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") ||
    !url.port ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.username ||
    url.password
  ) {
    throw new ProviderError("config", "MEETSUM_INTEGRATIONS_FAKE_BASE_URL must be http://127.0.0.1:<port> or http://localhost:<port>")
  }

  return url.origin
}

/** True when the server runs against the dev/e2e fake providers (never in production). */
export function isFakeMode(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return Boolean(getFakeBaseUrl(env))
  } catch {
    return false
  }
}

/** `https://<host><path>` → `<fake>/<host><path>` in fake mode; unchanged otherwise. */
export function rewriteForFakeMode(url: string, env: NodeJS.ProcessEnv = process.env): string {
  const fake = getFakeBaseUrl(env)

  if (!fake) return url

  const parsed = new URL(url)

  return `${fake}/${parsed.host}${parsed.pathname}${parsed.search}`
}

/**
 * Authorize URL for a browser redirect: the host must be one of the
 * provider's authorize hosts (https). Rewritten in fake mode.
 */
export function providerAuthorizeUrl(
  provider: ProviderId,
  base: string,
  params: Record<string, string | undefined>,
  env: NodeJS.ProcessEnv = process.env
): string {
  const url = new URL(base)

  if (url.protocol !== "https:" || !AUTHORIZE_HOSTS[provider].includes(url.hostname)) {
    throw new ProviderError("config", `${provider} authorize host refused`)
  }

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value)
  }

  return rewriteForFakeMode(url.toString(), env)
}

/** Throws a ProviderError("config") unless `url` is allowed for `provider`. */
export function assertProviderUrl(provider: ProviderId, url: string): URL {
  let parsed: URL

  try {
    parsed = new URL(url)
  } catch {
    throw new ProviderError("config", `${provider} URL is invalid`)
  }

  const hosts = PROVIDER_HOSTS[provider]

  if (!hosts) throw new ProviderError("config", "unknown provider")
  if (parsed.protocol !== "https:") throw new ProviderError("config", `${provider} URL must be https`)
  if (parsed.username || parsed.password || (parsed.port && parsed.port !== "443")) {
    throw new ProviderError("config", `${provider} URL refused`)
  }
  if (!hosts.includes(parsed.hostname.toLowerCase())) {
    throw new ProviderError("config", `${provider} host not allowed`)
  }
  if (parsed.hostname === "login.microsoftonline.com") {
    const tenant = decodeURIComponent(parsed.pathname.split("/")[1] ?? "")

    if (!isValidMicrosoftTenant(tenant)) throw new ProviderError("config", "invalid Microsoft tenant")
  }

  return parsed
}

async function readCapped(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  const declared = Number(response.headers.get("content-length"))

  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new ProviderError("invalid", "provider response too large")
  }
  if (!response.body) return new ArrayBuffer(0)

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  for (;;) {
    const { done, value } = await reader.read()

    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new ProviderError("invalid", "provider response too large")
    }
    chunks.push(value)
  }

  const buffer = new Uint8Array(total)
  let offset = 0

  for (const chunk of chunks) {
    buffer.set(chunk, offset)
    offset += chunk.byteLength
  }

  return buffer.buffer
}

export type ProviderFetchOptions = {
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  maxBytes?: number
}

/**
 * The only way to call a provider API. Returns a buffered Response (any
 * status; callers map non-2xx with `providerErrorForResponse`). Throws a
 * ProviderError for refused URLs (`config`), redirects and oversized bodies
 * (`invalid`) and network failures or timeouts (`retryable`).
 */
export async function providerFetchWith(
  provider: ProviderId,
  url: string,
  init: RequestInit = {},
  options: ProviderFetchOptions = {}
): Promise<Response> {
  const env = options.env ?? process.env

  assertProviderUrl(provider, url)

  const target = rewriteForFakeMode(url, env)
  const headers = new Headers(init.headers)

  headers.set("user-agent", PROVIDER_USER_AGENT)

  const timeout = AbortSignal.timeout(options.timeoutMs ?? PROVIDER_FETCH_TIMEOUT_MS)
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
  let response: Response

  try {
    response = await transport()(target, { ...init, headers, redirect: "error", signal })
  } catch (error) {
    if (error instanceof ProviderError) throw error
    if (timeout.aborted) throw new ProviderError("retryable", `${provider} request timed out`)
    if (error instanceof TypeError && /redirect/i.test(error.message)) {
      throw new ProviderError("invalid", `${provider} redirect refused`)
    }
    throw new ProviderError("retryable", `${provider} request failed`)
  }

  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined)
    throw new ProviderError("invalid", `${provider} redirect refused`)
  }

  let body: ArrayBuffer

  try {
    body = await readCapped(response, options.maxBytes ?? PROVIDER_FETCH_MAX_BYTES)
  } catch (error) {
    if (error instanceof ProviderError) throw error
    if (timeout.aborted) throw new ProviderError("retryable", `${provider} request timed out`)
    throw new ProviderError("retryable", `${provider} response failed`)
  }

  return new Response(response.status === 204 || response.status === 205 ? null : body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

/** `ProviderFetch` bound to the process env (what providers receive). */
export const providerFetch: ProviderFetch = (provider, url, init) => providerFetchWith(provider, url, init)

/** Parsed JSON body or undefined (never throws). */
export async function readJson<T = Record<string, unknown>>(response: Response): Promise<T | undefined> {
  try {
    const text = await response.text()

    return text ? (JSON.parse(text) as T) : undefined
  } catch {
    return undefined
  }
}

/**
 * Boot check (call from instrumentation): throws when fake mode is set in
 * production or malformed; returns warnings (redirect base, encryption key
 * fallback) for the caller to log.
 */
export function assertIntegrationsBootConfig(env: NodeJS.ProcessEnv = process.env): string[] {
  getFakeBaseUrl(env)

  const warnings: string[] = []
  const anyConfigured = [
    env.SLACK_CLIENT_ID,
    env.NOTION_CLIENT_ID,
    env.HUBSPOT_CLIENT_ID,
    env.MS_CLIENT_ID ?? env.AZURE_CLIENT_ID,
  ].some((value) => Boolean(value?.trim()))

  if (anyConfigured && !oauthRedirectBase(env)) {
    warnings.push("MEETSUM_OAUTH_REDIRECT_BASE must be an origin (https in production); integration OAuth is disabled")
  }
  if (anyConfigured && isProduction(env) && !env.GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY?.trim()) {
    warnings.push("GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY is unset; integration tokens fall back to the session secret")
  }

  return warnings
}
