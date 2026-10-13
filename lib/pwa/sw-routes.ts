/**
 * Service-worker request routing (docs/parity/m9.md D4; owner: Package D).
 *
 * These functions are serialized verbatim into the service-worker script
 * (`lib/pwa/sw-source.ts` uses `Function.prototype.toString`), so each one
 * must stay self-contained: no imports, no references to module scope, no
 * syntax that a compiler would rewrite into a helper call. The tests run the
 * same functions directly and inside the built script.
 *
 * Policy: only hashed `/_next/static/**` assets and the precached offline
 * page and icons are ever cached. Navigations are network-only (HTML carries
 * session data); `/api/**`, `/share/**`, `/sw.js`, auth routes, non-GET,
 * credentialed and cross-origin requests are never touched.
 */

export type SwRequestKind = "bypass" | "navigation" | "static" | "precached"

export type SwRequestInput = {
  url: string
  method: string
  /** `Request.mode`; "navigate" for page loads. */
  mode: string
  /** The service worker's origin (`self.location.origin`). */
  origin: string
  hasAuthorization: boolean
}

export type SwResponseInput = {
  status: number
  /** `Response.type`; "opaque" responses are never cached. */
  type?: string
  headers: { get(name: string): string | null }
}

/** Files the service worker precaches at install. */
export const SW_PRECACHE = [
  "/offline.html",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
] as const

export function classifyRequest(input: SwRequestInput, precache: readonly string[]): SwRequestKind {
  if (input.method.toUpperCase() !== "GET") return "bypass"
  if (input.hasAuthorization) return "bypass"

  let url: URL

  try {
    url = new URL(input.url)
  } catch {
    return "bypass"
  }
  if (url.origin !== input.origin) return "bypass"

  const path = url.pathname
  const neverTouch = [/^\/api(\/|$)/, /^\/share(\/|$)/, /^\/sw\.js$/, /^\/auth(\/|$)/, /^\/[a-z]{2}\/login(\/|$)/]

  for (const pattern of neverTouch) {
    if (pattern.test(path)) return "bypass"
  }
  if (input.mode === "navigate") return "navigation"
  if (path.indexOf("/_next/static/") === 0 && !url.search) return "static"
  if (precache.indexOf(path) !== -1 && !url.search) return "precached"

  return "bypass"
}

/** Whether a response may be stored (only ever called for "static"). */
export function isCacheableResponse(response: SwResponseInput): boolean {
  if (response.type === "opaque" || response.type === "opaqueredirect") return false
  if (response.status < 200 || response.status > 299) return false
  if (response.headers.get("set-cookie")) return false

  const cacheControl = (response.headers.get("cache-control") || "").toLowerCase()

  if (/(^|[\s,])(private|no-store)([\s,=]|$)/.test(cacheControl)) return false

  const contentType = (response.headers.get("content-type") || "").toLowerCase()

  if (contentType.indexOf("text/html") !== -1) return false

  return true
}
