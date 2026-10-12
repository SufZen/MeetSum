import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import {
  GraphSubscriptionError,
  ensureTeamsSubscription,
  getTeamsSubscriptionConfig,
  isTeamsSubscriptionConfigured,
  listTeamsSubscriptions,
} from "@/lib/capture/teams-subscriptions"
import { CaptureConfigError, RecordingDownloadError } from "@/lib/capture/types"

export const runtime = "nodejs"

/** GET /api/integrations/teams/subscription — Teams subscription status. */
export async function GET(request: Request) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const configured = isTeamsSubscriptionConfigured()
  const config = getTeamsSubscriptionConfig()

  return NextResponse.json({
    configured,
    resource: config?.resource,
    notificationUrl: config?.notificationUrl,
    lifecycleNotificationUrl: config?.lifecycleNotificationUrl,
    subscriptions: configured ? await listTeamsSubscriptions() : [],
  })
}

/** POST /api/integrations/teams/subscription — create or renew the subscription now. */
export async function POST(request: Request) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  if (!isTeamsSubscriptionConfigured()) {
    return jsonError(
      "Teams subscriptions are not configured (Azure credentials, TEAMS_WEBHOOK_CLIENT_STATE, an https MEETINGS_APP_URL and Postgres storage are required)",
      503
    )
  }

  try {
    const result = await ensureTeamsSubscription()

    return NextResponse.json(result, {
      status: result.action === "created" ? 201 : 200,
    })
  } catch (error) {
    if (error instanceof CaptureConfigError) {
      return jsonError(error.message, 503)
    }

    const status =
      error instanceof GraphSubscriptionError || error instanceof RecordingDownloadError
        ? 502
        : 500

    return jsonError(
      error instanceof Error ? error.message : "Unable to ensure Teams subscription",
      status
    )
  }
}
