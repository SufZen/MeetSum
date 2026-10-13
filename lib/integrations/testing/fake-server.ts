/**
 * Dev/e2e fake provider server (docs/parity/m8.md, "Fake mode"). Owner:
 * Package A. Loopback only; never used in production.
 *
 * Routing: `providerFetch` rewrites `https://<host><path>` to
 * `<fake>/<host><path>`, so handler keys are `"<METHOD> /<host><path>"`
 * (e.g. `"POST /slack.com/api/chat.postMessage"`). Handlers receive the
 * real request (to check fake tokens); the request log keeps a redacted
 * copy (Authorization, tokens, secrets and OAuth codes masked).
 *
 * Keys may also use `:param` segments (one path segment each) or end with
 * `/` (a prefix match); exact keys win, then `:param` keys, then the
 * longest prefix. Package B and C handlers are written without the host
 * (`"POST /v1/pages"`); `scopeFakeHandlers` binds them to their provider's
 * hosts and hands them the host-less path.
 *
 * Built-in routes (the e2e inspection contract):
 *   GET    /__fake/requests?provider=<id>  -> `{requests: [...]}` (redacted)
 *   DELETE /__fake/requests?provider=<id>  -> clears the log (all without `provider`)
 *   POST   /__fake/reset                   -> clears the log
 *   POST   /__fake/webhook                 -> a webhook receiver, recorded as
 *                                            provider `webhook` with `rawBody`
 *                                            (to verify `x-meetsum-signature-v2`)
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"

import { AUTHORIZE_HOSTS, PROVIDER_HOSTS } from "@/lib/integrations/core/http"
import type { FakeProviderHandlers, FakeProviderRequest, FakeProviderResponse, ProviderId } from "@/lib/integrations/core/types"

/** A logged request: which provider it was for (by host) and, for webhooks, the raw body. */
export type FakeLoggedRequest = FakeProviderRequest & { provider?: string; rawBody?: string }

export type FakeProviderServer = {
  /** `http://127.0.0.1:<port>` */
  url: string
  /** Requests received so far (optionally of one provider), tokens redacted. */
  requests(provider?: string): FakeLoggedRequest[]
  close(): Promise<void>
}

const SECRET_KEYS = /^(access_token|refresh_token|id_token|token|client_secret|code|code_verifier|password|secret|authorization)$/i
const MAX_BODY_BYTES = 2 * 1024 * 1024

function redactValue(key: string, value: unknown): unknown {
  if (SECRET_KEYS.test(key)) return "***"
  if (Array.isArray(value)) return value.map((item) => redactValue("", item))
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactValue(k, v)]))
  }
  if (typeof value === "string") return value.replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 ***").replace(/\bx(?:ox[a-z]|app)-[A-Za-z0-9-]+/g, "***")
  return value
}

/** A copy safe to log: no Authorization header, token, secret or code. */
export function redactFakeRequest(request: FakeProviderRequest): FakeProviderRequest {
  return {
    method: request.method,
    path: request.path,
    query: redactValue("", request.query) as Record<string, string>,
    headers: Object.fromEntries(
      Object.entries(request.headers).map(([key, value]) => [key, key === "authorization" || key === "cookie" ? "***" : String(redactValue(key, value))])
    ),
    body: redactValue("", request.body),
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)

    total += buffer.byteLength
    if (total > MAX_BODY_BYTES) throw new Error("fake request body too large")
    chunks.push(buffer)
  }

  return Buffer.concat(chunks).toString("utf8")
}

function parseBody(raw: string, contentType: string | undefined): unknown {
  if (!raw) return undefined
  if (contentType?.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(raw))

  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function send(res: ServerResponse, response: FakeProviderResponse) {
  if (response.redirect) {
    res.writeHead(302, { location: response.redirect, ...(response.headers ?? {}) })
    res.end()
    return
  }

  const status = response.status ?? 200

  res.writeHead(status, { "content-type": "application/json", ...(response.headers ?? {}) })
  res.end(response.body === undefined ? "" : JSON.stringify(response.body))
}

/** Hosts a provider is reached on (API and browser authorize pages). */
export function providerHosts(provider: ProviderId): string[] {
  return [...new Set([...(PROVIDER_HOSTS[provider] ?? []), ...(AUTHORIZE_HOSTS[provider] ?? [])])]
}

/** The provider for the first path segment of a fake-mode request (`/<host>/...`). */
export function providerForFakePath(path: string): ProviderId | undefined {
  const host = path.split("/")[1] ?? ""

  return (Object.keys(PROVIDER_HOSTS) as ProviderId[]).find((provider) => providerHosts(provider).includes(host))
}

/**
 * Binds host-less handler keys (`"POST /v1/pages"`) to every host of the
 * provider (`"POST /api.notion.com/v1/pages"`, ...). The handler receives
 * the path without the host, as in its own tests. Keys that already start
 * with one of the provider's hosts are kept as they are.
 */
export function scopeFakeHandlers(provider: ProviderId, handlers: FakeProviderHandlers | undefined): FakeProviderHandlers {
  const hosts = providerHosts(provider)
  const scoped: FakeProviderHandlers = {}

  for (const [key, handler] of Object.entries(handlers ?? {})) {
    const [method, path = ""] = key.split(" ")
    const first = path.split("/")[1] ?? ""

    if (hosts.includes(first)) {
      scoped[key] = handler
      continue
    }
    for (const host of hosts) {
      scoped[`${method} /${host}${path}`] = (request) => handler({ ...request, path: request.path.slice(host.length + 1) || "/" })
    }
  }

  return scoped
}

function segmentsMatch(pattern: string[], path: string[]): boolean {
  return (
    pattern.length === path.length &&
    pattern.every((segment, index) => (segment.startsWith(":") ? Boolean(path[index]) : segment === path[index]))
  )
}

/** Exact key, then a `:param` key, then the longest `/`-terminated prefix key. */
export function findFakeHandler(
  handlers: FakeProviderHandlers,
  method: string,
  path: string
): FakeProviderHandlers[string] | undefined {
  const exact = handlers[`${method} ${path}`]

  if (exact) return exact

  const segments = path.split("/")
  let prefix: { length: number; handler: FakeProviderHandlers[string] } | undefined

  for (const [key, handler] of Object.entries(handlers)) {
    const [keyMethod, keyPath = ""] = key.split(" ")

    if (keyMethod !== method) continue
    if (keyPath.includes("/:") && segmentsMatch(keyPath.split("/"), segments)) return handler
    if (keyPath.endsWith("/") && path.startsWith(keyPath) && (!prefix || keyPath.length > prefix.length)) {
      prefix = { length: keyPath.length, handler }
    }
  }

  return prefix?.handler
}

export async function createFakeProviderServer(
  handlers: FakeProviderHandlers,
  options: { port?: number; host?: "127.0.0.1" | "localhost" } = {}
): Promise<FakeProviderServer> {
  if (process.env.NODE_ENV === "production") throw new Error("the fake provider server is refused in production")

  let log: FakeLoggedRequest[] = []
  const host = options.host ?? "127.0.0.1"
  const filtered = (provider: string | null | undefined) => (provider ? log.filter((entry) => entry.provider === provider) : log)

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${host}`)
      const method = (req.method ?? "GET").toUpperCase()
      const only = url.searchParams.get("provider")

      if (url.pathname === "/__fake/requests" && method === "GET") return send(res, { body: { requests: filtered(only) } })
      if (url.pathname === "/__fake/requests" && method === "DELETE") {
        log = only ? log.filter((entry) => entry.provider !== only) : []
        return send(res, { body: { ok: true } })
      }
      if (url.pathname === "/__fake/reset" && method === "POST") {
        log = []
        return send(res, { body: { ok: true } })
      }

      const raw = await readBody(req)
      const request: FakeProviderRequest = {
        method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: Object.fromEntries(Object.entries(req.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : (value ?? "")])),
        body: parseBody(raw, req.headers["content-type"]),
      }

      if (url.pathname === "/__fake/webhook" && method === "POST") {
        // The raw body is kept so the e2e can verify x-meetsum-signature-v2.
        log.push({ ...redactFakeRequest(request), provider: "webhook", rawBody: raw })
        return send(res, { body: { ok: true } })
      }

      const provider = providerForFakePath(url.pathname)

      log.push({ ...redactFakeRequest(request), ...(provider ? { provider } : {}) })

      const handler = findFakeHandler(handlers, method, url.pathname)

      if (!handler) return send(res, { status: 404, body: { ok: false, error: "fake_route_not_found" } })

      send(res, await handler(request))
    } catch {
      send(res, { status: 500, body: { ok: false, error: "fake_server_error" } })
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(options.port ?? 0, host, () => resolve())
  })

  const address = server.address()
  const port = typeof address === "object" && address ? address.port : options.port

  return {
    url: `http://${host}:${port}`,
    requests: (provider) => structuredClone(filtered(provider)),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** Every registered provider's fake routes, merged (later keys win). */
export function mergeFakeHandlers(...sets: (FakeProviderHandlers | undefined)[]): FakeProviderHandlers {
  return Object.assign({}, ...sets.filter(Boolean))
}

/** All providers' fakes, each bound to its own hosts (what `npm run integrations:fake` serves). */
export function allProviderFakeHandlers(providers: readonly { id: string; fake?: FakeProviderHandlers }[]): FakeProviderHandlers {
  return mergeFakeHandlers(
    ...providers
      .filter((provider) => Object.hasOwn(PROVIDER_HOSTS, provider.id))
      .map((provider) => scopeFakeHandlers(provider.id as ProviderId, provider.fake))
  )
}
