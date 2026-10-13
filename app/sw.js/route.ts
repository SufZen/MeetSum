/**
 * Service worker script (docs/parity/m9.md D4; owner: Package D): public, no
 * data, not under /api. The script is versioned by the build id so a deploy
 * replaces the static cache; it is never cached itself (`no-cache`).
 */
import { buildServiceWorkerSource } from "@/lib/pwa/sw-source"
import { serviceWorkerVersion } from "@/lib/pwa/sw-version"

export const dynamic = "force-dynamic"

export function GET(): Response {
  return new Response(buildServiceWorkerSource(serviceWorkerVersion()), {
    status: 200,
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
      "service-worker-allowed": "/",
      "x-content-type-options": "nosniff",
    },
  })
}
