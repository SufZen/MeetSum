import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { validateTeamsClientState } from "@/lib/capture/teams"
import { handleTeamsLifecycleNotifications } from "@/lib/capture/teams-subscriptions"

export const runtime = "nodejs"

/**
 * POST /api/webhooks/teams/lifecycle — Microsoft Graph lifecycle
 * notifications (reauthorizationRequired, subscriptionRemoved, missed).
 */
export async function POST(request: Request) {
  const validationToken = new URL(request.url).searchParams.get("validationToken")

  if (validationToken) {
    return new NextResponse(validationToken, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    })
  }

  const rawBody = await request.text()
  const check = validateTeamsClientState(rawBody)

  if (!check.valid) {
    return jsonError(check.reason, 401)
  }

  const body = JSON.parse(rawBody) as {
    value: Array<{ subscriptionId?: string; lifecycleEvent?: string }>
  }
  const outcomes = await handleTeamsLifecycleNotifications(
    body.value.filter((entry) => typeof entry?.lifecycleEvent === "string")
  )

  return NextResponse.json({ outcomes }, { status: 202 })
}
