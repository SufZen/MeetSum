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
 * Built-in routes: `GET /__fake/requests` (the redacted log) and
 * `POST /__fake/reset`.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"

import type { FakeProviderHandlers, FakeProviderRequest, FakeProviderResponse } from "@/lib/integrations/core/types"

export type FakeProviderServer = {
  /** `http://127.0.0.1:<port>` */
  url: string
  /** Requests received so far, tokens redacted. */
  requests(): FakeProviderRequest[]
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

export async function createFakeProviderServer(
  handlers: FakeProviderHandlers,
  options: { port?: number; host?: "127.0.0.1" | "localhost" } = {}
): Promise<FakeProviderServer> {
  if (process.env.NODE_ENV === "production") throw new Error("the fake provider server is refused in production")

  const log: FakeProviderRequest[] = []
  const host = options.host ?? "127.0.0.1"

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${host}`)
      const method = (req.method ?? "GET").toUpperCase()

      if (url.pathname === "/__fake/requests" && method === "GET") return send(res, { body: log })
      if (url.pathname === "/__fake/reset" && method === "POST") {
        log.length = 0
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

      log.push(redactFakeRequest(request))

      const handler = handlers[`${method} ${url.pathname}`]

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
    requests: () => structuredClone(log),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** Every registered provider's fake routes, merged (later keys win). */
export function mergeFakeHandlers(...sets: (FakeProviderHandlers | undefined)[]): FakeProviderHandlers {
  return Object.assign({}, ...sets.filter(Boolean))
}
