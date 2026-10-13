import { NextResponse } from "next/server"

import { canManageMeeting, withAuthz } from "@/lib/auth/authz"
import { actorUserId, apiError, auditActor, idempotencyKeyOf, limitFor, readJsonBody } from "@/lib/integrations/core/api"
import { auditIntegration } from "@/lib/integrations/core/audit"
import { createManualDelivery } from "@/lib/integrations/core/deliveries"
import { getIntegrationQueuePort } from "@/lib/integrations/core/queue"
import { ruleContentSchema, ruleDestinationSchema } from "@/lib/integrations/core/rules"
import { getIntegrationStore } from "@/lib/integrations/core/store"
import type { RuleDestination } from "@/lib/integrations/core/types"
import { DEFAULT_RULE_CONTENT } from "@/lib/integrations/recap"

/**
 * POST /api/meetings/[id]/integrations/send `{connectionId, destination?, content?}`
 * with an `Idempotency-Key` header (M8 A6) → 202 `{deliveryId}`.
 * The meeting must be visible (else 404); private meetings need
 * `canManageMeeting` (and the deliver-time privacy gate still requires the
 * owner's own send or opt-in); the connection must be an active workspace
 * connection of this workspace with `allowManualSend !== false`. A
 * repeated key returns the same delivery.
 */

function defaultDestination(provider: string, config: Record<string, unknown>): RuleDestination | undefined {
  const value = (key: string) => (typeof config[key] === "string" && config[key] ? String(config[key]) : undefined)

  if (provider === "slack" && value("defaultChannelId")) {
    return { provider: "slack", channelId: value("defaultChannelId")!, channelName: "" }
  }
  if (provider === "notion" && value("defaultDatabaseId")) {
    return { provider: "notion", databaseId: value("defaultDatabaseId")!, databaseTitle: "" }
  }
  if (provider === "hubspot") {
    return {
      provider: "hubspot",
      ...(value("defaultDealId") ? { dealId: value("defaultDealId") } : {}),
      logAs: "meeting",
      createTasks: true,
      createMissingContacts: false,
      matchInternal: false,
    }
  }
  return undefined
}

export const POST = withAuthz<{ id: string }>("meeting:write", async (request, ctx, route) => {
  const limited = limitFor(request, ctx, "integrationsSend")

  if (limited) return limited

  const { id: meetingId } = await route.params
  const meeting = await ctx.meetings.getMeeting(meetingId)

  if (!meeting) return apiError("not_found", 404)
  if ((meeting.visibility ?? "private") === "private" && !canManageMeeting(ctx, meeting)) return apiError("forbidden", 403)

  const body = ((await readJsonBody(request)) ?? {}) as { connectionId?: unknown; destination?: unknown; content?: unknown }

  if (typeof body.connectionId !== "string" || !body.connectionId) return apiError("connection_required", 400)

  const store = await getIntegrationStore()
  const connection = await store.getConnection(ctx.workspace.id, body.connectionId)

  if (!connection || connection.status === "revoked" || !["slack", "notion", "hubspot"].includes(connection.provider)) {
    return apiError("not_found", 404)
  }
  if (connection.status !== "active") return apiError("integration_needs_reauth", 409)
  if (connection.config.allowManualSend === false) return apiError("manual_send_disabled", 403)

  let destination: RuleDestination | undefined

  if (body.destination !== undefined) {
    const parsed = ruleDestinationSchema.safeParse(body.destination)

    if (!parsed.success) return apiError("invalid_destination", 400)
    destination = parsed.data
  } else {
    destination = defaultDestination(connection.provider, connection.config)
  }
  if (!destination) return apiError("destination_required", 400)
  if (destination.provider !== connection.provider) return apiError("destination_provider_mismatch", 400)

  const content = ruleContentSchema.partial().safeParse(body.content ?? {})

  if (!content.success) return apiError("invalid_content", 400)

  const userId = actorUserId(ctx)
  const { delivery, created } = await createManualDelivery(store, getIntegrationQueuePort(), {
    workspaceId: ctx.workspace.id,
    connectionId: connection.id,
    provider: connection.provider,
    meetingId: meeting.id,
    ...(userId ? { requestedByUserId: userId } : {}),
    clientKey: idempotencyKeyOf(request),
    request: { destination, content: { ...DEFAULT_RULE_CONTENT, ...content.data } },
  })

  if (created) {
    await auditIntegration(auditActor(ctx), "integration.manual_send", { type: "meeting", id: meeting.id }, {
      provider: connection.provider,
      connectionId: connection.id,
      deliveryId: delivery.id,
    })
  }

  return NextResponse.json({ deliveryId: delivery.id, replayed: !created }, { status: 202 })
})
