import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { createTestCtx, routeParams, setRouteCtx } from "./helpers/route-ctx"

vi.mock("@/lib/auth/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/authz")>()
  const { mockAuthzModule } = await import("./helpers/route-ctx")

  return mockAuthzModule(actual)
})
vi.mock("@/lib/search/hebrew-normalize", async () => (await import("./helpers/search-doubles")).normalizerDouble)
vi.mock("@/lib/search/chunker", async () => (await import("./helpers/search-doubles")).chunkerDouble)
vi.mock("@/lib/search/chunk-sources", async () => (await import("./helpers/search-doubles")).chunkSourcesDouble)

import { GET as legacySearch } from "@/app/api/meetings/search/route"
import { GET as memorySearch } from "@/app/api/memory/search/route"
import { GET as facets } from "@/app/api/search/facets/route"
import { GET as search } from "@/app/api/search/route"
import { searchRateLimitKey } from "@/lib/search/context"

const ROOT = path.resolve(__dirname, "..")

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)

    if (statSync(full).isDirectory()) return routeFiles(full)

    return name === "route.ts" ? [full] : []
  })
}

/** Every search route Package B owns: app/api/search/** plus the compat routes. */
const SEARCH_ROUTES = [
  ...routeFiles(path.join(ROOT, "app/api/search")),
  path.join(ROOT, "app/api/meetings/search/route.ts"),
  path.join(ROOT, "app/api/memory/search/route.ts"),
]

afterEach(() => {
  setRouteCtx(undefined)
  delete process.env.MEETSUM_RATE_LIMIT
})

describe("search rate limiting (static)", () => {
  it("covers search, facets and both compat routes", () => {
    const relative = SEARCH_ROUTES.map((file) => path.relative(ROOT, file).split(path.sep).join("/")).sort()

    expect(relative).toEqual(
      expect.arrayContaining([
        "app/api/meetings/search/route.ts",
        "app/api/memory/search/route.ts",
        "app/api/search/facets/route.ts",
        "app/api/search/route.ts",
      ])
    )
  })

  it("every search route handler applies the keyed search preset and fails closed", () => {
    for (const file of SEARCH_ROUTES) {
      const source = readFileSync(file, "utf8")
      const handlers = source.match(/export const (GET|POST|PUT|PATCH|DELETE) = /g) ?? []

      expect(handlers.length, file).toBeGreaterThan(0)
      expect(source.match(/const limitKey = searchRateLimitKey\(ctx\)/g)?.length ?? 0, file).toBe(handlers.length)
      expect(source.match(/if \(!limitKey\) return searchRateLimitUnavailable\(\)/g)?.length ?? 0, file).toBe(handlers.length)
      expect(
        source.match(/rateLimitRequest\(request, RATE_LIMIT_PRESETS\.search, limitKey\)/g)?.length ?? 0,
        file
      ).toBe(handlers.length)
      expect(source.match(/if \(rateLimit\.blocked\) return rateLimit\.blocked/g)?.length ?? 0, file).toBe(handlers.length)
    }
  })
})

describe("searchRateLimitKey", () => {
  const workspace = { id: "ws_a", name: "A", slug: "a" }

  it("keys on workspace and user, or workspace and the API key creator", () => {
    expect(searchRateLimitKey({ principal: "user", user: { id: "u1", email: "" }, workspace })).toBe("search:ws_a:u1")
    expect(
      searchRateLimitKey({ principal: "api_key", apiKey: { id: "k1", scopes: ["read"], createdByUserId: "u9" }, workspace })
    ).toBe("search:ws_a:u9")
    expect(searchRateLimitKey({ principal: "api_key", apiKey: { id: "k1", scopes: ["read"] }, workspace })).toBe(
      "search:ws_a:key:k1"
    )
  })

  it("is null (fail closed) without an identity", () => {
    expect(searchRateLimitKey({ principal: "user", workspace })).toBeNull()
    expect(searchRateLimitKey({ principal: "api_key", workspace })).toBeNull()
    expect(searchRateLimitKey({ principal: "user", user: { id: "u1", email: "" }, workspace: { ...workspace, id: "" } })).toBeNull()
  })
})

describe("search rate limiting (behaviour)", () => {
  const handlers = {
    search: () => search(new Request("http://localhost/api/search?q=x"), routeParams({})),
    facets: () => facets(new Request("http://localhost/api/search/facets"), routeParams({})),
    legacy: () => legacySearch(new Request("http://localhost/api/meetings/search?q=x"), routeParams({})),
    memory: () => memorySearch(new Request("http://localhost/api/memory/search?query=x"), routeParams({})),
  }

  it("blocks each route after 60 requests per principal, independent of client IP, and not other principals", async () => {
    for (const [name, call] of Object.entries(handlers)) {
      setRouteCtx(await createTestCtx({ userId: `rl_${name}`, meetings: [] }))

      for (let index = 0; index < 60; index += 1) expect((await call()).status, name).not.toBe(429)

      const blocked = await call()

      expect(blocked.status, name).toBe(429)

      setRouteCtx(await createTestCtx({ userId: `rl_${name}_other`, meetings: [] }))
      expect((await call()).status, name).not.toBe(429)
    }
  })

  it("search and facets share one bucket per principal", async () => {
    setRouteCtx(await createTestCtx({ userId: "rl_shared", meetings: [] }))

    for (let index = 0; index < 60; index += 1) await handlers.search()

    expect((await handlers.facets()).status).toBe(429)
  })

  it("fails closed when no rate-limit identity exists", async () => {
    const ctx = await createTestCtx({ meetings: [] })

    setRouteCtx({ ...ctx, user: undefined })

    for (const [name, call] of Object.entries(handlers)) expect((await call()).status, name).toBe(429)
  })
})
