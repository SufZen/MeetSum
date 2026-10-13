/**
 * Service worker script (docs/parity/m9.md D4): public, no data, not under
 * /api. M9 Step 0 stub (501, never cached); owner: Package D, which serves the
 * versioned script from lib/pwa/sw-source.ts with Service-Worker-Allowed: /.
 */
export const dynamic = "force-dynamic"

export function GET(): Response {
  return new Response("// MeetSum service worker: not implemented yet", {
    status: 501,
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
    },
  })
}
