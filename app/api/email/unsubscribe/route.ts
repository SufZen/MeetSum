import { NextResponse } from "next/server"

import { withPublicRoute } from "@/lib/auth/authz"
import { recordRecapUnsubscribe } from "@/lib/integrations/email-recap/unsubscribe-store"
import { unsubscribeLocale, verifyUnsubscribeToken } from "@/lib/integrations/email-recap/unsubscribe-token"
import { extractRateLimitKey, RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"

/**
 * /api/email/unsubscribe (M8 A10). Signed token, verified first.
 * GET never mutates: 302 to the confirmation page (link scanners are safe).
 * POST (the page's form, or RFC 8058 one-click
 * `List-Unsubscribe=One-Click`) records it. Rate-limited with
 * `publicAccess`; an invalid token is a bare 400.
 */

function invalid() {
  return NextResponse.json({ error: "invalid_token" }, { status: 400 })
}

function limited(request: Request) {
  return rateLimitRequest(request, RATE_LIMIT_PRESETS.publicAccess, `unsubscribe:${extractRateLimitKey(request)}`).blocked
}

export const GET = withPublicRoute("Signed email unsubscribe token", async (request) => {
  const url = new URL(request.url)
  const token = url.searchParams.get("t")
  const payload = verifyUnsubscribeToken(token)

  if (!payload || !token) return invalid()

  const blocked = limited(request)

  if (blocked) return blocked

  const locale = unsubscribeLocale(url.searchParams.get("l"))

  return new Response(null, {
    status: 302,
    headers: { location: `/${locale}/unsubscribe?t=${encodeURIComponent(token)}`, "cache-control": "no-store" },
  })
})

export const POST = withPublicRoute("Signed email unsubscribe token", async (request) => {
  const url = new URL(request.url)
  const raw = await request.text().catch(() => "")
  const form = new URLSearchParams(raw.length <= 4096 ? raw : "")
  const token = url.searchParams.get("t") ?? form.get("t")
  const payload = verifyUnsubscribeToken(token)

  if (!payload) return invalid()

  const blocked = limited(request)

  if (blocked) return blocked

  const oneClick = form.get("List-Unsubscribe") === "One-Click"

  await recordRecapUnsubscribe(payload, oneClick ? "one_click" : "link")

  if (!oneClick && form.get("t")) {
    const locale = unsubscribeLocale(form.get("l") ?? url.searchParams.get("l"))

    return new Response(null, { status: 303, headers: { location: `/${locale}/unsubscribe?done=1`, "cache-control": "no-store" } })
  }

  return NextResponse.json({ ok: true })
})
