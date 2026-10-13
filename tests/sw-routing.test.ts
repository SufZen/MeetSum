/**
 * M9 D4: the service worker caches only hashed static assets, the offline
 * page and icons. The routing table runs directly and the fetch handler runs
 * inside the generated script against a fake CacheStorage.
 */
import { describe, expect, it } from "vitest"

import { SW_PRECACHE, classifyRequest, isCacheableResponse } from "@/lib/pwa/sw-routes"
import { buildServiceWorkerSource, swCacheName } from "@/lib/pwa/sw-source"

const ORIGIN = "https://meetsum.example"

function classify(path: string, init: { method?: string; mode?: string; auth?: boolean; origin?: string } = {}) {
  return classifyRequest(
    {
      url: path.startsWith("http") ? path : `${ORIGIN}${path}`,
      method: init.method ?? "GET",
      mode: init.mode ?? "cors",
      origin: init.origin ?? ORIGIN,
      hasAuthorization: init.auth ?? false,
    },
    SW_PRECACHE
  )
}

describe("classifyRequest", () => {
  it.each([
    ["/api/meetings"],
    ["/api/notifications"],
    ["/api/auth/logout"],
    ["/api"],
    ["/share/tok_123"],
    ["/share"],
    ["/sw.js"],
    ["/auth/callback"],
    ["/he/login"],
  ])("never caches %s", (path) => {
    expect(classify(path)).toBe("bypass")
    expect(classify(path, { mode: "navigate" })).toBe("bypass")
  })

  it("does not intercept other subresources", () => {
    expect(classify("/_next/image?url=%2Fx.png&w=64&q=75")).toBe("bypass")
    expect(classify("/favicon.ico")).toBe("bypass")
    expect(classify("/manifest.webmanifest")).toBe("bypass")
  })

  it("treats navigations as network-only", () => {
    expect(classify("/he?meeting=m_1", { mode: "navigate" })).toBe("navigation")
    expect(classify("/en/tasks", { mode: "navigate" })).toBe("navigation")
  })

  it("never touches non-GET, credentialed or cross-origin requests", () => {
    expect(classify("/_next/static/chunks/a.js", { method: "POST" })).toBe("bypass")
    expect(classify("/_next/static/chunks/a.js", { auth: true })).toBe("bypass")
    expect(classify("https://cdn.example/_next/static/chunks/a.js")).toBe("bypass")
    expect(classify("/he", { mode: "navigate", method: "POST" })).toBe("bypass")
  })

  it("caches hashed static assets and the precache list", () => {
    expect(classify("/_next/static/chunks/app-123.js")).toBe("static")
    expect(classify("/_next/static/css/a.css")).toBe("static")
    expect(classify("/offline.html")).toBe("precached")
    expect(classify("/icons/icon-192.png")).toBe("precached")
    expect(classify("/offline.html?x=1")).toBe("bypass")
  })

  it("rejects malformed URLs", () => {
    expect(classifyRequest({ url: "not a url", method: "GET", mode: "cors", origin: ORIGIN, hasAuthorization: false }, SW_PRECACHE)).toBe("bypass")
  })
})

describe("isCacheableResponse", () => {
  const response = (status: number, headers: Record<string, string> = {}, type = "basic") => ({
    status,
    type,
    headers: new Headers(headers),
  })

  it("accepts a plain 2xx static response", () => {
    expect(isCacheableResponse(response(200, { "content-type": "application/javascript" }))).toBe(true)
  })

  it.each([
    ["non-2xx", response(404)],
    ["redirect", response(302)],
    ["server error", response(500)],
    ["Set-Cookie", response(200, { "set-cookie": "s=1" })],
    ["private", response(200, { "cache-control": "private, max-age=60" })],
    ["no-store", response(200, { "cache-control": "no-store" })],
    ["HTML", response(200, { "content-type": "text/html; charset=utf-8" })],
    ["opaque", response(0, {}, "opaque")],
  ])("refuses %s", (_label, value) => {
    expect(isCacheableResponse(value)).toBe(false)
  })
})

/* ---------------------------------------------------------------- */
/* The generated script, run against fakes.                          */
/* ---------------------------------------------------------------- */

class FakeCache {
  entries = new Map<string, Response>()
  async match(request: Request | string) {
    const key = typeof request === "string" ? new URL(request, ORIGIN).href : request.url
    const hit = this.entries.get(key)

    return hit ? hit.clone() : undefined
  }
  async put(request: Request | string, response: Response) {
    this.entries.set(typeof request === "string" ? new URL(request, ORIGIN).href : request.url, response)
  }
  async addAll(paths: string[]) {
    for (const path of paths) this.entries.set(new URL(path, ORIGIN).href, new Response(`precached ${path}`))
  }
}

class FakeCacheStorage {
  stores = new Map<string, FakeCache>()
  async open(name: string) {
    if (!this.stores.has(name)) this.stores.set(name, new FakeCache())
    return this.stores.get(name) as FakeCache
  }
  async keys() {
    return [...this.stores.keys()]
  }
  async delete(name: string) {
    return this.stores.delete(name)
  }
  async match(request: Request | string) {
    for (const cache of this.stores.values()) {
      const hit = await cache.match(request)

      if (hit) return hit
    }
    return undefined
  }
  /** Every URL stored in any cache. */
  allUrls() {
    return [...this.stores.values()].flatMap((cache) => [...cache.entries.keys()].map((url) => new URL(url).pathname))
  }
}

type Listener = (event: Record<string, unknown>) => void

function bootWorker(network: (request: Request) => Promise<Response>) {
  const listeners = new Map<string, Listener>()
  const caches = new FakeCacheStorage()
  const posted: unknown[] = []
  let skipped = false
  const self = {
    caches,
    fetch: network,
    location: { origin: ORIGIN },
    clients: {
      claim: async () => undefined,
      matchAll: async () => [{ postMessage: (message: unknown) => posted.push(message) }],
    },
    skipWaiting: () => {
      skipped = true
    },
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
  }

  new Function("self", buildServiceWorkerSource("build-1"))(self)

  async function dispatch(type: string, extra: Record<string, unknown> = {}) {
    const pending: Promise<unknown>[] = []
    let responded: Promise<Response> | undefined

    listeners.get(type)?.({
      ...extra,
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      respondWith: (promise: Promise<Response>) => {
        responded = promise
      },
    })
    await Promise.all(pending)

    return responded ? await responded : undefined
  }

  return {
    caches,
    posted,
    skipped: () => skipped,
    install: () => dispatch("install"),
    activate: () => dispatch("activate"),
    message: (data: unknown) => dispatch("message", { data }),
    sync: (tag: string) => dispatch("sync", { tag }),
    fetch: (path: string, init: RequestInit & { mode?: RequestMode } = {}) => {
      const request = new Request(new URL(path, ORIGIN), { ...init, mode: init.mode === "navigate" ? undefined : init.mode })

      if (init.mode === "navigate") Object.defineProperty(request, "mode", { value: "navigate" })

      return dispatch("fetch", { request })
    },
  }
}

const okJs = () => new Response("js", { headers: { "content-type": "application/javascript" } })

describe("generated service worker", () => {
  it("names its cache after the build and sanitizes the version", () => {
    expect(swCacheName("abc_123")).toBe("meetsum-abc_123")
    expect(swCacheName("../x y")).toBe("meetsum-..xy")
    expect(swCacheName("")).toBe("meetsum-dev")
    expect(buildServiceWorkerSource("b1")).toContain('const CACHE = "meetsum-b1"')
  })

  it("precaches only the offline page and icons, and never stores private responses", async () => {
    const network = async (request: Request) => {
      const path = new URL(request.url).pathname

      if (path.startsWith("/_next/static/")) return okJs()
      if (path === "/api/meetings" || path === "/api/notifications") {
        return new Response("{}", { headers: { "content-type": "application/json", "set-cookie": "s=1" } })
      }
      if (path.startsWith("/share/")) return new Response("<html>", { headers: { "content-type": "text/html" } })
      if (path === "/he") return new Response("<html>private</html>", { headers: { "content-type": "text/html" } })

      return new Response("x", { headers: { "cache-control": "no-store" } })
    }
    const worker = bootWorker(network)

    await worker.install()
    await worker.activate()

    // Not intercepted at all: the browser fetches them, nothing is stored.
    expect(await worker.fetch("/api/meetings")).toBeUndefined()
    expect(await worker.fetch("/api/notifications")).toBeUndefined()
    expect(await worker.fetch("/share/tok_1", { mode: "navigate" })).toBeUndefined()
    expect(await worker.fetch("/api/meetings", { method: "POST", body: "{}" })).toBeUndefined()

    // Navigations go to the network and are never stored.
    const page = await worker.fetch("/he?meeting=m_1", { mode: "navigate" })

    expect(await page?.text()).toContain("private")

    // Static assets are cached.
    await worker.fetch("/_next/static/chunks/app.js")

    const urls = worker.caches.allUrls().sort()

    expect(urls).toEqual(["/_next/static/chunks/app.js", ...SW_PRECACHE].sort())
    expect([...worker.caches.stores.keys()]).toEqual(["meetsum-build-1"])
  })

  it("does not cache a static response that is private, non-2xx or sets a cookie", async () => {
    const responses = [
      new Response("a", { status: 404 }),
      new Response("b", { headers: { "set-cookie": "s=1" } }),
      new Response("c", { headers: { "cache-control": "private" } }),
      new Response("d", { headers: { "cache-control": "no-store" } }),
    ]
    const worker = bootWorker(async () => responses.shift() as Response)

    for (let index = 0; index < 4; index += 1) await worker.fetch(`/_next/static/chunks/${index}.js`)

    expect(worker.caches.allUrls()).toEqual([])
  })

  it("serves offline.html when a navigation fails, and cache-first for static hits", async () => {
    let online = true
    let calls = 0
    const worker = bootWorker(async (request) => {
      calls += 1
      if (!online) throw new TypeError("offline")
      return new URL(request.url).pathname.startsWith("/_next/") ? okJs() : new Response("page")
    })

    await worker.install()
    await worker.fetch("/_next/static/chunks/a.js")
    online = false

    const offline = await worker.fetch("/en/tasks", { mode: "navigate" })

    expect(await offline?.text()).toBe("precached /offline.html")
    expect(await (await worker.fetch("/_next/static/chunks/a.js"))?.text()).toBe("js")
    expect(calls).toBe(2)
  })

  it("deletes old caches on activate and every cache on clear-caches", async () => {
    const worker = bootWorker(async () => okJs())

    await worker.caches.open("meetsum-old")
    await worker.install()
    await worker.activate()
    expect(await worker.caches.keys()).toEqual(["meetsum-build-1"])

    await worker.message({ type: "clear-caches" })
    expect(await worker.caches.keys()).toEqual([])
  })

  it("skips waiting only when asked, and relays the upload sync tag without reading data", async () => {
    const worker = bootWorker(async () => okJs())

    await worker.install()
    expect(worker.skipped()).toBe(false)
    await worker.message({ type: "skip-waiting" })
    expect(worker.skipped()).toBe(true)

    await worker.sync("other")
    await worker.sync("meetsum-uploads")
    expect(worker.posted).toEqual([{ type: "flush-uploads" }])
  })
})
