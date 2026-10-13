import { NextResponse } from "next/server"

import { withPublicRoute } from "@/lib/auth/authz"
import { redactBotError } from "@/lib/bot/redact"
import { processVexaWebhook, readBodyCapped, VEXA_WEBHOOK_MAX_BYTES } from "@/lib/bot/webhook-handler"
import { getLogger } from "@/lib/log"

const log = getLogger({ component: "integrations/vexa" })

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * POST /api/integrations/vexa/webhook — Vexa bot status events (M7 B3).
 *
 * Public: authenticated by the Vexa HMAC-SHA256 signature over
 * "<timestamp>.<raw body>" (legacy Bearer only when explicitly allowed),
 * both compared in constant time. The workspace comes only from the stored
 * bot session; unknown meetings are a 200 no-op.
 */
export const POST = withPublicRoute(
  "Vexa webhook: HMAC-SHA256 signed with VEXA_WEBHOOK_SECRET",
  handleVexaWebhook
)

async function handleVexaWebhook(request: Request) {
  try {
    // Size is enforced while reading, before HMAC and JSON parse.
    const body = await readBodyCapped(request, VEXA_WEBHOOK_MAX_BYTES)

    if (!body.ok) return NextResponse.json({ error: "payload_too_large" }, { status: 413 })

    const result = await processVexaWebhook({ headers: request.headers, rawBody: body.text })

    return NextResponse.json(result.body, { status: result.status })
  } catch (error) {
    log.error({ error: redactBotError(error) }, "[bot] vexa webhook failed")

    return NextResponse.json({ error: "webhook_failed" }, { status: 500 })
  }
}
