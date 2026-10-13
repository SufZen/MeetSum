import { NextResponse } from "next/server"

import {
  auditActor,
  loadVisibleMeeting,
  meetingManageForbidden,
  meetingNotFound,
} from "@/app/api/_lib/meeting-access"
import { recordAuditLog } from "@/lib/audit"
import { canManageMeeting, withAuthz } from "@/lib/auth/authz"
import { meetingAppUrl } from "@/lib/integrations/core/links"
import { checkManualPush } from "@/lib/integrations/core/manual-send"
import { ruleDestinationSchema } from "@/lib/integrations/core/rules"
import { ProviderError, type DeliverResult, type RuleDestination } from "@/lib/integrations/core/types"
import { notionLocaleFor } from "@/lib/integrations/notion/blocks"
import { getManualExportRuntime, manualExportPrefs } from "@/lib/integrations/notion/manual-export-runtime"
import { notionProvider } from "@/lib/integrations/notion/provider"
import {
  isPrivateMeeting,
  manualIdempotencyKey,
  providerErrorResponse,
  readJsonObject,
} from "@/lib/integrations/notion/route-helpers"
import { buildMeetingRecap, DEFAULT_RULE_CONTENT } from "@/lib/integrations/recap"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"

/**
 * POST /api/meetings/:id/export/notion `{databaseId?}` (M8 C1).
 *
 * - `meeting:write` + visible (else 404); a private meeting needs
 *   `canManageMeeting`. No admin check: the token comes only from the
 *   workspace's Notion OAuth connection, never from the request or a server
 *   fallback; a body carrying a token is refused (400 `token_not_accepted`).
 * - No active connection → 409 `notion_not_connected`.
 * - The shared manual-push checks (`checkManualPush`, as the send route):
 *   `allowManualSend === false` → 403 `manual_send_disabled`; the single
 *   privacy gate (a private meeting needs the owner's per-meeting opt-in)
 *   → 403 `private_meeting_not_opted_in`; a client-supplied `databaseId`
 *   is checked with Notion (`validateDestination`) → 400
 *   `invalid_destination`.
 * - Runs `provider.deliver` synchronously as a manual delivery (idempotency
 *   key from `Idempotency-Key`): re-exporting updates the tracked page in
 *   place. Returns `{deliveryId, pageId, url, updated}`.
 * - Errors map to fixed codes; Notion's messages are never reflected.
 */
function notConnected() {
  return NextResponse.json({ error: "notion_not_connected" }, { status: 409 })
}

export const POST = withAuthz<{ id: string }>("meeting:write", async (request, ctx, { params }) => {
  const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.exports)

  if (rateLimit.blocked) return rateLimit.blocked

  const payload = await readJsonObject(request)

  if (Object.hasOwn(payload, "token")) {
    return NextResponse.json({ error: "token_not_accepted" }, { status: 400 })
  }

  const { id } = await params
  const meeting = await loadVisibleMeeting(ctx, id)

  if (!meeting) return meetingNotFound()
  if (isPrivateMeeting(meeting) && !canManageMeeting(ctx, meeting)) return meetingManageForbidden()

  const runtime = getManualExportRuntime()
  const workspaceId = ctx.workspace.id
  const connection = runtime ? await runtime.findActiveConnection(workspaceId, "notion") : undefined

  if (!runtime || !connection || !notionProvider.deliver) return notConnected()

  const requested = typeof payload.databaseId === "string" ? payload.databaseId.trim() : ""
  const fallback = typeof connection.config.defaultDatabaseId === "string" ? connection.config.defaultDatabaseId : ""
  const databaseId = requested || fallback

  if (payload.databaseId !== undefined && typeof payload.databaseId !== "string") {
    return NextResponse.json({ error: "invalid_destination" }, { status: 400 })
  }
  if (!databaseId) return NextResponse.json({ error: "notion_database_required" }, { status: 400 })

  const parsed = ruleDestinationSchema.safeParse({ provider: "notion", databaseId, databaseTitle: "" })

  if (!parsed.success) return NextResponse.json({ error: "invalid_destination" }, { status: 400 })

  const destination = parsed.data
  const validateDestination = notionProvider.validateDestination
  // The same checks as POST /integrations/send: allowManualSend, the single
  // privacy gate, and a client-supplied database checked with Notion.
  const check = await checkManualPush({
    meeting,
    connection,
    destination,
    clientDestination: Boolean(requested),
    // The client-supplied database is checked with Notion; the connection
    // default was set by an admin and is checked when Notion is called.
    ...(requested && validateDestination
      ? {
          validate: (value: RuleDestination) =>
            validateDestination(value, {
              workspaceId,
              connection,
              getAccessToken: () => runtime.getAccessToken(workspaceId, connection.id),
              fetch: runtime.providerFetch,
            }),
        }
      : {}),
    getPrefs: () => manualExportPrefs(runtime, workspaceId, meeting.id),
    ...(ctx.user?.id ? { requestedByUserId: ctx.user.id } : {}),
  })

  if (!check.ok) {
    if (check.providerError) return providerErrorResponse("notion", check.providerError)
    return NextResponse.json(
      { error: check.code, ...(check.providerCode ? { providerCode: check.providerCode } : {}) },
      { status: check.status }
    )
  }

  const started = await runtime.startManualDelivery({
    workspaceId,
    connectionId: connection.id,
    provider: "notion",
    meetingId: meeting.id,
    idempotencyKey: manualIdempotencyKey(request),
    eventName: "meeting.export",
    ...(ctx.user?.id ? { requestedByUserId: ctx.user.id } : {}),
  })
  const { delivery } = started

  // A replayed key that already succeeded returns the same page.
  if (started.replayed && delivery.status === "sent") {
    return NextResponse.json(
      {
        deliveryId: delivery.id,
        pageId: delivery.externalRef.pageId,
        url: delivery.externalRef.url,
        updated: delivery.externalRef.updated === true,
      },
      { headers: rateLimit.headers }
    )
  }

  const content = { ...DEFAULT_RULE_CONTENT, openQuestions: true, transcript: true }
  const recap = buildMeetingRecap(meeting, {
    content,
    links: { meeting: meetingAppUrl(meeting.id, notionLocaleFor(meeting.language)) },
  })
  let result: DeliverResult

  try {
    result = await notionProvider.deliver({
      workspaceId,
      delivery,
      connection,
      getAccessToken: () => runtime.getAccessToken(workspaceId, connection.id),
      destination,
      content,
      recap,
      meeting,
      progress: started.progress ?? {},
      saveProgress: (progress) => runtime.saveDeliveryProgress(workspaceId, delivery.id, progress),
      links: runtime.linkStore(workspaceId, connection.id, meeting.id),
      fetch: runtime.providerFetch,
    })
  } catch (error) {
    await runtime
      .finishManualDelivery(workspaceId, delivery.id, {
        error: {
          kind: error instanceof ProviderError ? error.kind : "retryable",
          message: error instanceof ProviderError ? error.message : "notion_export_failed",
        },
      })
      .catch(() => {})

    return providerErrorResponse("notion", error)
  }

  await runtime.finishManualDelivery(workspaceId, delivery.id, { result })

  const pageId = String(result.externalRef.pageId ?? "")
  const url = String(result.externalRef.url ?? "")
  const updated = result.externalRef.updated === true

  await ctx.meetings.createExportRecord({
    meetingId: meeting.id,
    format: "notion",
    metadata: { deliveryId: delivery.id, pageId },
  })
  await recordAuditLog({
    ...auditActor(ctx),
    action: "meeting.export.notion",
    targetType: "meeting",
    targetId: meeting.id,
    metadata: { deliveryId: delivery.id, connectionId: connection.id, provider: "notion", updated },
  })

  return NextResponse.json({ deliveryId: delivery.id, pageId, url, updated }, { headers: rateLimit.headers })
})
