/**
 * M9 D4 security check 2 (docs/parity/m9.md): the service worker never
 * stores private data. The generated SW source runs against a fake
 * CacheStorage and replays a browsing session: `/api/**`, `/share/**`, HTML
 * navigations, `Set-Cookie`, `private` / `no-store` and HTML responses (also
 * when they come back for a `/_next/static` URL). Afterwards the cache holds
 * only hashed `/_next/static/**` files, `offline.html` and the icons; logout
 * (`clear-caches`) empties every cache. (Routing-table cases live in
 * tests/sw-routing.test.ts.)
 */
import { describe, expect, it } from "vitest"

import { SW_PRECACHE } from "@/lib/pwa/sw-routes"

import { bootWorker, okJs } from "./helpers/sw-fakes"

const ALLOWED = (path: string) => path.startsWith("/_next/static/") || (SW_PRECACHE as readonly string[]).includes(path)

function privateNetwork(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname
  const json = (body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json", ...headers } })

  if (path === "/_next/static/chunks/app-abc.js") return Promise.resolve(okJs())
  if (path === "/_next/static/css/app-abc.css") return Promise.resolve(new Response("css", { headers: { "content-type": "text/css" } }))
  // A static URL that answers with something private must still not be stored.
  if (path === "/_next/static/chunks/leak-html.js") {
    return Promise.resolve(new Response("<html>secret</html>", { headers: { "content-type": "text/html" } }))
  }
  if (path === "/_next/static/chunks/leak-cookie.js") return Promise.resolve(new Response("js", { headers: { "set-cookie": "s=1" } }))
  if (path === "/_next/static/chunks/leak-private.js") {
    return Promise.resolve(new Response("js", { headers: { "cache-control": "private, max-age=600" } }))
  }
  if (path === "/_next/static/chunks/leak-nostore.js") return Promise.resolve(new Response("js", { headers: { "cache-control": "no-store" } }))
  if (path.startsWith("/api/")) {
    return Promise.resolve(json({ meetings: [{ title: "Secret 1:1" }] }, { "cache-control": "private, no-store", "set-cookie": "s=1" }))
  }
  if (path.startsWith("/share/")) {
    return Promise.resolve(new Response("<html>shared summary</html>", { headers: { "content-type": "text/html; charset=utf-8" } }))
  }

  return Promise.resolve(
    new Response("<html>meeting Secret 1:1</html>", {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" },
    })
  )
}

describe("service worker private data", () => {
  it("stores only static assets, offline.html and icons after a browsing session", async () => {
    const worker = bootWorker(privateNetwork)

    await worker.install()
    await worker.activate()

    // Data requests are not even intercepted (the browser handles them).
    for (const path of ["/api/meetings", "/api/meetings/m_1?include=transcript", "/api/notifications", "/api/me/preferences"]) {
      expect(await worker.fetch(path), path).toBeUndefined()
    }
    expect(await worker.fetch("/api/meetings/m_1/upload", { method: "POST", body: "x" })).toBeUndefined()
    expect(await worker.fetch("/share/tok_123", { mode: "navigate" })).toBeUndefined()
    expect(await worker.fetch("/share/tok_123/media")).toBeUndefined()

    // Navigations go to the network and are never stored.
    for (const path of ["/he?meeting=m_priv", "/en/tasks", "/he/rooms/r_1", "/he?panel=settings"]) {
      const page = await worker.fetch(path, { mode: "navigate" })

      expect(await page?.text(), path).toContain("Secret")
    }

    // Static assets: the good ones are cached, private-looking ones are not.
    for (const name of ["app-abc.js", "leak-html.js", "leak-cookie.js", "leak-private.js", "leak-nostore.js"]) {
      await worker.fetch(`/_next/static/chunks/${name}`)
    }
    await worker.fetch("/_next/static/css/app-abc.css")

    const stored = worker.caches.allUrls().sort()

    expect(stored.every(ALLOWED)).toBe(true)
    expect(stored).toEqual(["/_next/static/chunks/app-abc.js", "/_next/static/css/app-abc.css", ...SW_PRECACHE].sort())
    expect(stored.some((path) => path.includes("leak"))).toBe(false)

    // No stored body carries private content.
    for (const cache of worker.caches.stores.values()) {
      for (const response of cache.entries.values()) expect(await response.clone().text()).not.toContain("Secret")
    }
  })

  it("never stores a query-string variant of a static or precached file", async () => {
    const worker = bootWorker(async () => okJs())

    await worker.install()
    await worker.fetch("/_next/static/chunks/app-abc.js?token=abc")
    await worker.fetch("/offline.html?meeting=m_1")

    expect(worker.caches.allUrls().every((path) => !path.includes("?"))).toBe(true)
    expect(worker.caches.allUrls().sort()).toEqual([...SW_PRECACHE].sort())
  })

  it("logout (clear-caches) deletes every cache", async () => {
    const worker = bootWorker(privateNetwork)

    await worker.install()
    await worker.activate()
    await worker.fetch("/_next/static/chunks/app-abc.js")
    expect((await worker.caches.keys()).length).toBe(1)

    await worker.message({ type: "clear-caches" })
    expect(await worker.caches.keys()).toEqual([])
    expect(worker.caches.allUrls()).toEqual([])
  })
})
