import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"
import { CATALOG_VERSION } from "@/lib/platform/event-catalog"
import { webhookCatalogEvents } from "@/lib/platform/event-schemas"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"

/**
 * GET /api/webhooks/catalog (M8 C4, `webhooks:manage`): the webhook event
 * catalog `{version, events: [{name, versions, description, example,
 * schemaUrl}]}` for the delivery-log and test-fire UI. `example` is the v2
 * data; `schemaUrl` is the generated JSON Schema in the repository.
 */
export const GET = withAuthz("webhooks:manage", async (request) => {
  const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.admin)

  if (rateLimit.blocked) return rateLimit.blocked

  return NextResponse.json(
    { version: CATALOG_VERSION, events: webhookCatalogEvents() },
    { headers: { "cache-control": "private, max-age=300", ...rateLimit.headers } }
  )
})
