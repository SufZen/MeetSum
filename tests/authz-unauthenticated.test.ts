/// <reference types="vite/client" />

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { dummyParams, handlers, isPublicHandler } from "./helpers/api-routes"

/**
 * M2 Integration guard: every non-public API handler answers 401 to a caller
 * without credentials, with a bogus bearer token (no cookie fallback) and
 * with a non-bearer Authorization header. Handlers are imported for real; the
 * auth wrapper must reject before any route logic runs.
 */

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => undefined,
    getAll: () => [],
    has: () => false,
  }),
  headers: async () => new Headers(),
}))

const ENV = {
  MEETSUM_STORAGE: "memory",
  MEETSUM_SESSION_SECRET: "authz-unauthenticated-test-secret",
  MEETSUM_RATE_LIMIT: "false",
  MEETSUM_API_KEYS: "",
  MEETSUM_API_KEY_HASHES: "",
  NODE_ENV: "test",
}

const modules = import.meta.glob<Record<string, unknown>>("../app/api/**/route.ts")

type RouteHandler = (
  request: Request,
  route: { params: Promise<Record<string, string>> }
) => Promise<Response>

const protectedHandlers = handlers.filter((handler) => !isPublicHandler(handler))

async function loadHandler(route: string, method: string): Promise<RouteHandler> {
  const load = modules[`../app/api/${route}/route.ts`]

  if (!load) throw new Error(`route module not found: ${route}`)

  const handler = (await load())[method]

  if (typeof handler !== "function") {
    throw new Error(`${route} does not export ${method}`)
  }

  return handler as RouteHandler
}

async function call(
  route: string,
  method: string,
  headers: Record<string, string>
): Promise<Response> {
  const handler = await loadHandler(route, method)
  const hasBody = method !== "GET" && method !== "HEAD"
  const request = new Request(`http://localhost/api/${route}`, {
    method,
    headers: {
      origin: "http://localhost",
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(hasBody ? { body: "{}" } : {}),
  })

  return handler(request, { params: Promise.resolve(dummyParams(route)) })
}

describe("unauthenticated access to API routes", () => {
  beforeAll(() => {
    for (const [key, value] of Object.entries(ENV)) vi.stubEnv(key, value)
  })

  afterAll(() => {
    vi.unstubAllEnvs()
  })

  it("discovers the protected handlers", () => {
    expect(protectedHandlers.length).toBeGreaterThan(80)
  })

  it.each(protectedHandlers.map((h) => [`${h.method} /api/${h.route}`, h] as const))(
    "%s -> 401 without credentials",
    async (_label, handler) => {
      const response = await call(handler.route, handler.method, {})

      expect(response.status).toBe(401)
    },
    20_000
  )

  it.each(protectedHandlers.map((h) => [`${h.method} /api/${h.route}`, h] as const))(
    "%s -> 401 with a bogus bearer token",
    async (_label, handler) => {
      const response = await call(handler.route, handler.method, {
        authorization: "Bearer ms_bogus0000000000000000000000000000",
      })

      expect(response.status).toBe(401)
    },
    20_000
  )

  it.each(protectedHandlers.map((h) => [`${h.method} /api/${h.route}`, h] as const))(
    "%s -> 401 with a non-bearer Authorization header",
    async (_label, handler) => {
      const response = await call(handler.route, handler.method, {
        authorization: "Basic dXNlcjpwYXNz",
      })

      expect(response.status).toBe(401)
    },
    20_000
  )
})
