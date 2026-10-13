/**
 * Builds the service-worker script served at `/sw.js` (docs/parity/m9.md
 * D4; owner: Package D). The routing functions come from `sw-routes.ts` via
 * `toString()`, so the tests and the worker share one implementation.
 *
 * - install: precache `/offline.html` and the icons (no `skipWaiting`);
 * - activate: delete every cache except the current version, claim clients;
 * - fetch: navigations are network-only with an offline.html fallback;
 *   `/_next/static/**` is cache-first; everything else is not intercepted;
 * - messages: `skip-waiting` (the user accepted the update toast) and
 *   `clear-caches` (logout) delete or activate as asked;
 * - Background Sync `meetsum-uploads` only tells open clients to flush; the
 *   worker never reads upload data.
 */
import { SW_PRECACHE, classifyRequest, isCacheableResponse } from "@/lib/pwa/sw-routes"

export const SW_SYNC_TAG = "meetsum-uploads"
export const SW_CACHE_PREFIX = "meetsum-"

/** Cache names may only hold safe characters. */
export function swCacheName(version: string): string {
  const safe = version.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64) || "dev"

  return `${SW_CACHE_PREFIX}${safe}`
}

export function buildServiceWorkerSource(version: string): string {
  return `/* MeetSum service worker (generated; docs/parity/m9.md D4) */
"use strict";
const CACHE = ${JSON.stringify(swCacheName(version))};
const PRECACHE = ${JSON.stringify(SW_PRECACHE)};
const SYNC_TAG = ${JSON.stringify(SW_SYNC_TAG)};
const classifyRequest = ${classifyRequest.toString()};
const isCacheableResponse = ${isCacheableResponse.toString()};

self.addEventListener("install", (event) => {
  event.waitUntil(self.caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    self.caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => self.caches.delete(key))))
      .then(() => (self.clients && self.clients.claim ? self.clients.claim() : undefined))
  );
});

self.addEventListener("message", (event) => {
  const type = event.data && event.data.type;

  if (type === "skip-waiting") {
    self.skipWaiting();
  } else if (type === "clear-caches") {
    const done = self.caches.keys().then((keys) => Promise.all(keys.map((key) => self.caches.delete(key))));

    if (event.waitUntil) event.waitUntil(done);
  }
});

self.addEventListener("sync", (event) => {
  if (event.tag !== SYNC_TAG) return;
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => clients.forEach((client) => client.postMessage({ type: "flush-uploads" })))
  );
});

async function cacheFirst(request) {
  const cache = await self.caches.open(CACHE);
  const hit = await cache.match(request);

  if (hit) return hit;

  const response = await self.fetch(request);

  if (isCacheableResponse(response)) await cache.put(request, response.clone());

  return response;
}

async function networkOnlyNavigation(request) {
  try {
    return await self.fetch(request);
  } catch (error) {
    const cache = await self.caches.open(CACHE);
    const offline = await cache.match("/offline.html");

    if (offline) return offline;
    throw error;
  }
}

async function precached(request) {
  const cache = await self.caches.open(CACHE);
  const hit = await cache.match(request);

  return hit || self.fetch(request);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const kind = classifyRequest(
    {
      url: request.url,
      method: request.method,
      mode: request.mode,
      origin: self.location.origin,
      hasAuthorization: request.headers.has("authorization"),
    },
    PRECACHE
  );

  if (kind === "navigation") event.respondWith(networkOnlyNavigation(request));
  else if (kind === "static") event.respondWith(cacheFirst(request));
  else if (kind === "precached") event.respondWith(precached(request));
  // "bypass": not intercepted, the browser handles it and nothing is stored.
});
`
}
