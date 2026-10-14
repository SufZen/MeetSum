import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { parseCaptureEvents } from "@/lib/capture/registry"
import { teamsCaptureAdapter } from "@/lib/capture/teams"
import { withPublicRoute } from "@/lib/auth/authz"
import { getCaptureWorkspaceId } from "@/lib/capture/workspace"
import { enqueueMeetSumJob } from "@/lib/jobs/queue"
import { getSystemMeetingRepository } from "@/lib/meetings/store"
import { getAppSettings } from "@/lib/settings/app-settings"
import { getLogger } from "@/lib/log"

const log = getLogger({ component: "webhooks/teams" })

export const runtime = "nodejs"

function validationResponse(request: Request) {
  const validationToken = new URL(request.url).searchParams.get("validationToken")

  return validationToken
    ? new NextResponse(validationToken, {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      })
    : undefined
}

/**
 * POST /api/webhooks/teams — Receive Microsoft Graph change notifications.
 *
 * Handles:
 * - Subscription validation (validationToken echo)
 * - Batched change notifications for new recordings: one meeting (created
 *   idempotently per recording id) + one `media.ingest` job per recording.
 *
 * Public (Graph clientState is verified); recordings land in the capture
 * workspace (MEETSUM_CAPTURE_WORKSPACE_ID) through its system repository.
 */
export const POST = withPublicRoute(
  "Microsoft Graph notifications: authenticated by the subscription clientState",
  handleTeamsWebhook
)

async function handleTeamsWebhook(request: Request) {
  const validation = validationResponse(request)

  if (validation) return validation

  const rawBody = await request.text()
  let body: unknown

  try {
    body = JSON.parse(rawBody)
  } catch {
    return jsonError("Invalid JSON", 400)
  }

  const headers: Record<string, string> = {}

  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value
  })

  const check = teamsCaptureAdapter.validateWebhook(headers, rawBody)

  if (!check.valid) {
    return jsonError(check.reason, 401)
  }

  const events = parseCaptureEvents(teamsCaptureAdapter, body)

  if (events.length === 0) {
    return NextResponse.json({ status: "ignored" }, { status: 202 })
  }

  const accepted: string[] = []
  const duplicates: string[] = []
  let failed = 0
  const workspaceId = getCaptureWorkspaceId()
  const repository = getSystemMeetingRepository(workspaceId)
  const settings = await getAppSettings(workspaceId)

  for (const event of events) {
    let meetingId: string | undefined
    let created = false

    try {
      const outcome = await repository.createMeetingIfAbsent({
        ...teamsCaptureAdapter.toMeetingInput(event),
        visibility: settings.defaultMeetingVisibility,
        externalSource: "teams",
        externalId: event.externalId,
      })

      meetingId = outcome.meeting.id
      created = outcome.created

      if (!created) {
        duplicates.push(meetingId)
        continue
      }

      await enqueueMeetSumJob("media.ingest", {
        meetingId,
        workspaceId,
        platform: "teams",
        externalId: event.externalId,
        captureEvent: event,
      })
      accepted.push(meetingId)

      await recordAuditLog({
        workspaceId,
        actor: "teams",
        action: "capture.teams.recording",
        targetType: "meeting",
        targetId: meetingId,
        metadata: {
          externalId: event.externalId,
          resource: event.recordingUrl ? "[redacted]" : undefined,
        },
      }).catch(() => {})
    } catch (error) {
      failed += 1

      if (created && meetingId) {
        await repository.discardMeeting(meetingId).catch(() => false)
      }

      log.error({ err: error }, "[teams] notification processing failed")
    }
  }

  if (failed > 0) {
    // Graph redelivers on 5xx; successful events are idempotent.
    return jsonError("Failed to process some Teams notifications", 500)
  }

  return NextResponse.json(
    { status: "accepted", meetingIds: accepted, duplicates },
    { status: 202 }
  )
}
