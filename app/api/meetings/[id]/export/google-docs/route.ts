import { NextResponse } from "next/server"

import { auditActor, loadVisibleMeeting, meetingNotFound } from "@/app/api/_lib/meeting-access"
import { recordAuditLog } from "@/lib/audit"
import { withAuthz } from "@/lib/auth/authz"
import { meetingAppUrl } from "@/lib/integrations/core/links"
import { checkManualPush } from "@/lib/integrations/core/manual-send"
import { flagNeedsReauthOnAuth } from "@/lib/integrations/core/reauth"
import type { LinkStore } from "@/lib/integrations/core/types"
import { googleDocsLocaleFor } from "@/lib/integrations/google-docs/builder"
import type { GoogleDocsClientContext } from "@/lib/integrations/google-docs/client"
import { googleDocsDwdAccessToken, googleDocsDwdDecision } from "@/lib/integrations/google-docs/dwd"
import { exportRecapToGoogleDocs } from "@/lib/integrations/google-docs/export"
import { getManualExportRuntime, manualExportPrefs, reauthGeneration } from "@/lib/integrations/notion/manual-export-runtime"
import { providerErrorResponse, readJsonObject } from "@/lib/integrations/notion/route-helpers"
import { buildMeetingRecap, DEFAULT_RULE_CONTENT } from "@/lib/integrations/recap"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"

/**
 * POST /api/meetings/:id/export/google-docs `{includeTranscript?}` (M8 C2).
 *
 * `meeting:read` + visible (else 404); `exports` rate limit. The shared
 * manual-push checks apply (`checkManualPush`, as the send route): a
 * connection with `allowManualSend === false` → 403 `manual_send_disabled`,
 * and a private meeting needs the owner's per-meeting opt-in (the single
 * privacy gate) → 403 `private_meeting_not_opted_in`. Auth, in order:
 *   1. the requester's personal `google_drive` connection (OAuth, PKCE,
 *      `drive.file`);
 *   2. `MEETSUM_GOOGLE_DOCS_DWD=true` with a service-account DWD strategy and
 *      the requester's domain equal to the workspace subject's domain;
 *   3. otherwise 409 `google_docs_not_connected {connectUrl}`.
 * Re-export replaces the tracked document's body; `?new=1` forces a new
 * document. Returns `{documentId, url, updated}`. Google's error text is
 * never reflected.
 */
export const POST = withAuthz<{ id: string }>("meeting:read", async (request, ctx, { params }) => {
  const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.exports)

  if (rateLimit.blocked) return rateLimit.blocked

  const payload = await readJsonObject(request)
  const forceNew = new URL(request.url).searchParams.get("new") === "1"
  const { id } = await params
  const meeting = await loadVisibleMeeting(ctx, id)

  if (!meeting) return meetingNotFound()

  const workspaceId = ctx.workspace.id
  const locale = googleDocsLocaleFor(meeting.language)
  const runtime = getManualExportRuntime()
  const userId = ctx.principal === "user" ? ctx.user?.id : undefined
  const connection =
    runtime && userId ? await runtime.findActiveConnection(workspaceId, "google_drive", { userId }) : undefined
  let client: GoogleDocsClientContext | undefined
  let links: LinkStore | undefined
  let via: "oauth" | "dwd" = "oauth"

  if (runtime && connection) {
    client = { fetch: runtime.providerFetch, getAccessToken: () => runtime.getAccessToken(workspaceId, connection.id) }
    links = runtime.linkStore(workspaceId, connection.id, meeting.id)
  } else if (runtime && userId) {
    const decision = googleDocsDwdDecision({ userEmail: ctx.user?.email, workspace: ctx.workspace })

    if (decision.allowed) {
      client = { fetch: runtime.providerFetch, getAccessToken: () => googleDocsDwdAccessToken(decision.subject) }
      via = "dwd"
    }
  }

  if (client && runtime) {
    // The same checks as POST /integrations/send (allowManualSend and the
    // single privacy gate): a private meeting needs the owner's opt-in.
    const check = await checkManualPush({
      meeting,
      ...(connection ? { connection } : {}),
      getPrefs: () => manualExportPrefs(runtime, workspaceId, meeting.id),
      ...(userId ? { requestedByUserId: userId } : {}),
    })

    if (!check.ok) return NextResponse.json({ error: check.code }, { status: check.status })
  }

  if (!client) {
    const returnTo = `/${locale}?meeting=${encodeURIComponent(meeting.id)}`

    return NextResponse.json(
      {
        error: "google_docs_not_connected",
        connectUrl: `/api/integrations/google_drive/oauth/start?returnTo=${encodeURIComponent(returnTo)}`,
      },
      { status: 409 }
    )
  }

  const recap = buildMeetingRecap(meeting, {
    content: { ...DEFAULT_RULE_CONTENT, openQuestions: true, transcript: payload.includeTranscript === true },
    links: { meeting: meetingAppUrl(meeting.id, locale) },
  })
  let result: Awaited<ReturnType<typeof exportRecapToGoogleDocs>>

  try {
    result = await exportRecapToGoogleDocs({ recap, client, ...(links ? { links } : {}), forceNew })
  } catch (error) {
    if (connection) await flagNeedsReauthOnAuth(workspaceId, connection.id, error, reauthGeneration(connection))
    return providerErrorResponse("google_docs", error)
  }

  await ctx.meetings.createExportRecord({
    meetingId: meeting.id,
    format: "google_docs",
    metadata: { documentId: result.documentId, updated: result.updated },
  })
  await recordAuditLog({
    ...auditActor(ctx),
    action: "meeting.export.google_docs",
    targetType: "meeting",
    targetId: meeting.id,
    metadata: { documentId: result.documentId, updated: result.updated, via },
  })

  return NextResponse.json(result, { headers: rateLimit.headers })
})
