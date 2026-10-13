/**
 * M9 D4: the service worker caches only hashed static assets, the offline
 * page and icons. The routing table runs directly and the fetch handler runs
 * inside the generated script against a fake CacheStorage
 * (tests/helpers/sw-fakes.ts; the private-data session replay is
 * tests/sw-private-data.test.ts).
 */
import { describe, expect, it } from "vitest"

import { SW_PRECACHE, classifyRequest, isCacheableResponse } from "@/lib/pwa/sw-routes"
import { buildServiceWorkerSource, swCacheName } from "@/lib/pwa/sw-source"

import { ORIGIN, bootWorker, okJs } from "./helpers/sw-fakes"

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


describe("generated service worker", () => {
  it("names its cache after the build and sanitizes the version", () => {
    expect(swCacheName("abc_123")).toBe("meetsum-abc_123")
    expect(swCacheName("../x y")).toBe("meetsum-..xy")
    expect(swCacheName("")).toBe("meetsum-dev")
    expect(buildServiceWorkerSource("b1")).toContain('const CACHE = "meetsum-b1"')
  })

  // Private-data storage (API, share, HTML, Set-Cookie, private/no-store,
  // logout) is covered end to end in tests/sw-private-data.test.ts.

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
