import { NextResponse } from "next/server"

import { canManageMeeting, withAuthz } from "@/lib/auth/authz"
import { actorUserId, apiError, auditActor, idempotencyKeyOf, limitFor, providerErrorResponse, readJsonBody } from "@/lib/integrations/core/api"
import { auditIntegration } from "@/lib/integrations/core/audit"
import { providerCtx } from "@/lib/integrations/core/connections"
import { createManualDelivery } from "@/lib/integrations/core/deliveries"
import { checkManualPush } from "@/lib/integrations/core/manual-send"
import { getProvider } from "@/lib/integrations/core/registry"
import { getIntegrationQueuePort } from "@/lib/integrations/core/queue"
import { ruleContentSchema, ruleDestinationSchema } from "@/lib/integrations/core/rules"
import { getIntegrationStore } from "@/lib/integrations/core/store"
import type { RuleDestination } from "@/lib/integrations/core/types"
import { DEFAULT_RULE_CONTENT } from "@/lib/integrations/recap"

/**
 * POST /api/meetings/[id]/integrations/send `{connectionId, destination?, content?}`
 * with an `Idempotency-Key` header (M8 A6) → 202 `{deliveryId}`.
 * The meeting must be visible (else 404); private meetings need
 * `canManageMeeting` AND the owner's per-meeting opt-in (the single privacy
 * gate, re-run at deliver time); the connection must be an active workspace
 * connection of this workspace with `allowManualSend !== false`, and the
 * destination is checked with the provider (`validateDestination`). A
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

  let destination: RuleDestination | undefined

  if (body.destination !== undefined) {
    const parsed = ruleDestinationSchema.safeParse(body.destination)

    if (!parsed.success) return apiError("invalid_destination", 400)
    destination = parsed.data
  } else {
    destination = defaultDestination(connection.provider, connection.config)
  }
  if (!destination) return apiError("destination_required", 400)

  const content = ruleContentSchema.partial().safeParse(body.content ?? {})

  if (!content.success) return apiError("invalid_content", 400)

  // The shared manual-push checks (also used by the export routes): active
  // connection, allowManualSend, the single privacy gate, and a destination
  // checked with the provider (never post to an unchecked id).
  const provider = getProvider(connection.provider)
  const validateDestination = provider?.validateDestination
  const check = await checkManualPush({
    meeting,
    connection,
    destination,
    clientDestination: body.destination !== undefined,
    ...(validateDestination ? { validate: (value: RuleDestination) => validateDestination(value, providerCtx(connection, store)) } : {}),
    getPrefs: () => store.getPrefs(ctx.workspace.id, meeting.id),
    ...(actorUserId(ctx) ? { requestedByUserId: actorUserId(ctx) } : {}),
  })

  if (!check.ok) {
    if (check.providerError) return providerErrorResponse(check.providerError)
    return apiError(check.code, check.status, check.providerCode ? { providerCode: check.providerCode } : {})
  }

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
