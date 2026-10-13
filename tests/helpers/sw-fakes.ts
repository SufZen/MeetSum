/**
 * Fakes for running the generated service worker (lib/pwa/sw-source.ts) in
 * Node: an in-memory CacheStorage and a `self` with fetch/clients. Shared by
 * tests/sw-routing.test.ts and tests/sw-private-data.test.ts.
 */
import { buildServiceWorkerSource } from "@/lib/pwa/sw-source"

export const ORIGIN = "https://meetsum.example"

/* ---------------------------------------------------------------- */
/* The generated script, run against fakes.                          */
/* ---------------------------------------------------------------- */

export class FakeCache {
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

export class FakeCacheStorage {
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

export function bootWorker(network: (request: Request) => Promise<Response>) {
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

export const okJs = () => new Response("js", { headers: { "content-type": "application/javascript" } })
