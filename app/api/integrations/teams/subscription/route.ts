import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { withAuthz, type AuthContext } from "@/lib/auth/authz"
import {
  GraphSubscriptionError,
  ensureTeamsSubscription,
  getTeamsSubscriptionConfig,
  isTeamsSubscriptionConfigured,
  listTeamsSubscriptions,
} from "@/lib/capture/teams-subscriptions"
import { CaptureConfigError, RecordingDownloadError } from "@/lib/capture/types"
import { getCaptureWorkspaceId } from "@/lib/capture/workspace"

export const runtime = "nodejs"

/**
 * The Teams subscription is instance-level and delivers into the capture
 * workspace (MEETSUM_CAPTURE_WORKSPACE_ID); only that workspace manages it.
 */
function notCaptureWorkspace(ctx: AuthContext) {
  return ctx.workspace.id !== getCaptureWorkspaceId()
    ? jsonError("Teams capture is not connected to this workspace", 404)
    : undefined
}

/** GET /api/integrations/teams/subscription — Teams subscription status. */
export const GET = withAuthz("integrations:manage", async (_request, ctx) => {
  const blocked = notCaptureWorkspace(ctx)

  if (blocked) return blocked

  const configured = isTeamsSubscriptionConfigured()
  const config = getTeamsSubscriptionConfig()

  return NextResponse.json({
    configured,
    resource: config?.resource,
    notificationUrl: config?.notificationUrl,
    lifecycleNotificationUrl: config?.lifecycleNotificationUrl,
    subscriptions: configured ? await listTeamsSubscriptions() : [],
  })
})

/** POST /api/integrations/teams/subscription — create or renew the subscription now. */
export const POST = withAuthz("integrations:manage", async (_request, ctx) => {
  const blocked = notCaptureWorkspace(ctx)

  if (blocked) return blocked

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
})
