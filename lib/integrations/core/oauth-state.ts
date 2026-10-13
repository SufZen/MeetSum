/**
 * OAuth state, nonce cookie and redirect URI (docs/parity/m8.md, "OAuth
 * flow" and "Redirect URI allowlist"). Owner: Package A.
 *
 * `state = base64url(json{v:1, n, p, ws, u, exp}) + "." + HMAC-SHA256`,
 * keyed by HKDF(MEETSUM_SESSION_SECRET, "meetsum:integration-oauth-state").
 * The nonce is also an httpOnly cookie and a DB row (single use); the
 * callback checks all three and re-checks membership (core/oauth.ts).
 */
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto"

import { getSessionSecret } from "@/lib/auth/session"
import type { IntegrationErrorCode, ProviderId } from "@/lib/integrations/core/types"
import { DEFAULT_LOCALE, isSupportedLocale } from "@/lib/i18n/locales"

export const OAUTH_STATE_COOKIE = "meetsum_int_oauth"
export const OAUTH_STATE_COOKIE_PATH = "/api/integrations"
export const OAUTH_STATE_TTL_MS = 10 * 60_000

export type OAuthStatePayload = {
  v: 1
  /** Nonce (32 bytes, base64url). */
  n: string
  /** Provider id. */
  p: string
  /** Workspace id. */
  ws: string
  /** User id. */
  u: string
  /** Expiry, epoch ms. */
  exp: number
}

function stateKey(env: NodeJS.ProcessEnv): Buffer {
  return Buffer.from(hkdfSync("sha256", getSessionSecret(env), Buffer.alloc(0), "meetsum:integration-oauth-state", 32))
}

function mac(body: string, env: NodeJS.ProcessEnv): string {
  return createHmac("sha256", stateKey(env)).update(body).digest("base64url")
}

export function createOAuthNonce(): string {
  return randomBytes(32).toString("base64url")
}

export function signOAuthState(payload: Omit<OAuthStatePayload, "v">, env: NodeJS.ProcessEnv = process.env): string {
  const body = Buffer.from(JSON.stringify({ v: 1, ...payload }), "utf8").toString("base64url")

  return `${body}.${mac(body, env)}`
}

export type VerifiedOAuthState =
  | { ok: true; payload: OAuthStatePayload }
  | { ok: false; code: Extract<IntegrationErrorCode, "invalid_state" | "expired_state"> }

/** Signature first (timing-safe), then shape, then expiry. */
export function verifyOAuthState(
  state: string | null | undefined,
  options: { env?: NodeJS.ProcessEnv; now?: number } = {}
): VerifiedOAuthState {
  const env = options.env ?? process.env
  const invalid = { ok: false, code: "invalid_state" } as const

  if (!state || state.length > 2048) return invalid

  const [body, signature, extra] = state.split(".")

  if (!body || !signature || extra !== undefined) return invalid

  let expected: Buffer

  try {
    expected = Buffer.from(mac(body, env))
  } catch {
    return invalid
  }

  const actual = Buffer.from(signature)

  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return invalid

  let payload: OAuthStatePayload

  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as OAuthStatePayload
  } catch {
    return invalid
  }

  if (
    payload?.v !== 1 ||
    typeof payload.n !== "string" ||
    typeof payload.p !== "string" ||
    typeof payload.ws !== "string" ||
    typeof payload.u !== "string" ||
    typeof payload.exp !== "number"
  ) {
    return invalid
  }
  if (payload.exp <= (options.now ?? Date.now())) return { ok: false, code: "expired_state" }

  return { ok: true, payload }
}

/**
 * `MEETSUM_OAUTH_REDIRECT_BASE ?? NEXT_PUBLIC_APP_URL` as an origin, or
 * undefined when it is missing, has a path/query, or is not https in
 * production. Never derived from a request.
 */
export function oauthRedirectBase(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = (env.MEETSUM_OAUTH_REDIRECT_BASE?.trim() || env.NEXT_PUBLIC_APP_URL?.trim() || "").replace(/\/+$/, "")

  if (!raw) return undefined

  let url: URL

  try {
    url = new URL(raw)
  } catch {
    return undefined
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined
  if (env.NODE_ENV === "production" && url.protocol !== "https:") return undefined
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash || url.username || url.password) return undefined

  return url.origin
}

/** `${base}/api/integrations/${provider}/oauth/callback`, or undefined when the base is invalid. */
export function oauthRedirectUri(provider: ProviderId, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const base = oauthRedirectBase(env)

  return base ? `${base}/api/integrations/${provider}/oauth/callback` : undefined
}

/** Settings → Integrations for a locale. */
export function defaultIntegrationsReturnTo(locale: string = DEFAULT_LOCALE): string {
  return `/${isSupportedLocale(locale) ? locale : DEFAULT_LOCALE}?panel=settings&section=integrations`
}

const RETURN_TO_BASE = new URL("https://meetsum.invalid")

/**
 * Pre-parse check of a relative return path: a single leading `/` not
 * followed by `/` or `\`, no backslash or control character anywhere, no
 * encoded `/` or `\` (`%2f`, `%5c`, also double-encoded), not `/api/`,
 * at most 512 characters.
 */
function isSafeRelativePath(value: string | null | undefined): value is string {
  if (!value || value.length > 512) return false
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return false
  if (value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return false
  if (value.startsWith("/api/")) return false

  let decoded = value

  for (let round = 0; round < 3; round += 1) {
    if (/%2f|%5c/i.test(decoded)) return false
    try {
      const next = decodeURIComponent(decoded)

      if (next === decoded) break
      decoded = next
    } catch {
      return false
    }
  }
  return !decoded.includes("\\") && !/[\u0000-\u001f\u007f]/.test(decoded) && !decoded.startsWith("//")
}

/** Parsed against a fixed base; undefined unless it stays same-origin. */
function parseSameOrigin(value: string): URL | undefined {
  try {
    const url = new URL(value, RETURN_TO_BASE)

    return url.origin === RETURN_TO_BASE.origin ? url : undefined
  } catch {
    return undefined
  }
}

/** Same-origin relative path (checked before and after parsing), else the integrations page. */
export function safeIntegrationReturnTo(value: string | null | undefined, locale?: string): string {
  if (!isSafeRelativePath(value)) return defaultIntegrationsReturnTo(locale)

  const url = parseSameOrigin(value)

  if (!url || url.pathname.startsWith("/api/")) return defaultIntegrationsReturnTo(locale)

  return value
}

/**
 * Relative return path plus `integration_error=<code>` (a fixed enum, never
 * provider text). The path is validated before parsing (see
 * `isSafeRelativePath`) and after (`new URL(value, base).origin === base`);
 * only `pathname + search + hash` is emitted, never an absolute URL, so the
 * code lands in the query (not the fragment) and a second `?` stays in the
 * query. Anything invalid falls back to the integrations settings path.
 */
export function withIntegrationError(returnTo: string, code: IntegrationErrorCode, locale?: string): string {
  const fallback = () => {
    const url = new URL(defaultIntegrationsReturnTo(locale), RETURN_TO_BASE)

    url.searchParams.set("integration_error", code)
    return `${url.pathname}${url.search}`
  }

  if (!isSafeRelativePath(returnTo)) return fallback()

  const url = parseSameOrigin(returnTo)

  if (!url || url.pathname.startsWith("/api/") || url.pathname.startsWith("//")) return fallback()

  url.searchParams.set("integration_error", code)
  return `${url.pathname}${url.search}${url.hash}`
}

export function oauthStateCookie(nonce: string, env: NodeJS.ProcessEnv = process.env): string {
  return [
    `${OAUTH_STATE_COOKIE}=${nonce}`,
    `Path=${OAUTH_STATE_COOKIE_PATH}`,
    `Max-Age=${OAUTH_STATE_TTL_MS / 1000}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(env.NODE_ENV === "production" ? ["Secure"] : []),
  ].join("; ")
}

export function clearOAuthStateCookie(env: NodeJS.ProcessEnv = process.env): string {
  return [
    `${OAUTH_STATE_COOKIE}=`,
    `Path=${OAUTH_STATE_COOKIE_PATH}`,
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
    ...(env.NODE_ENV === "production" ? ["Secure"] : []),
  ].join("; ")
}
