import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import {
  getZoomWebhookSecret,
  handleZoomChallenge,
  isZoomChallenge,
  verifyZoomSignature,
  zoomCaptureAdapter,
} from "@/lib/capture/zoom"
import { withPublicRoute } from "@/lib/auth/authz"
import { getCaptureWorkspaceId } from "@/lib/capture/workspace"
import { enqueueMeetSumJob } from "@/lib/jobs/queue"
import { getSystemMeetingRepository } from "@/lib/meetings/store"
import { getAppSettings } from "@/lib/settings/app-settings"

export const runtime = "nodejs"

function lowerCaseHeaders(request: Request) {
  const headers: Record<string, string> = {}

  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value
  })

  return headers
}

/**
 * POST /api/webhooks/zoom — Receive Zoom webhook events.
 *
 * Handles:
 * - endpoint.url_validation — Zoom URL verification challenge
 * - recording.completed — New recording available for processing
 *
 * Idempotent per Zoom meeting UUID: redeliveries return 200 without
 * creating another meeting or job. The recording itself is downloaded by
 * the worker (`media.ingest` → importPlatformRecording), not in the request.
 *
 * Public (Zoom signs every request); recordings land in the capture
 * workspace (MEETSUM_CAPTURE_WORKSPACE_ID) through its system repository.
 */
export const POST = withPublicRoute(
  "Zoom webhook: authenticated by the Zoom HMAC signature",
  handleZoomWebhook
)

async function handleZoomWebhook(request: Request) {
  const rawBody = await request.text()
  const headers = lowerCaseHeaders(request)
  let body: unknown

  try {
    body = JSON.parse(rawBody)
  } catch {
    return jsonError("Invalid JSON", 400)
  }

  if (isZoomChallenge(body)) {
    const secret = getZoomWebhookSecret()

    // An HMAC keyed with "" would validate the endpoint for anyone.
    if (!secret) {
      return jsonError("ZOOM_WEBHOOK_SECRET not configured", 503)
    }

    // Always require a valid signature: the challenge response is
    // HMAC(secret, plainToken), the same primitive Zoom uses to sign events,
    // so answering unsigned challenges would be a signing oracle that lets
    // anyone forge `recording.completed` events.
    if (!verifyZoomSignature(headers, rawBody, secret)) {
      return jsonError("Invalid Zoom webhook signature", 401)
    }

    return NextResponse.json(handleZoomChallenge(body))
  }

  const validation = zoomCaptureAdapter.validateWebhook(headers, rawBody)

  if (!validation.valid) {
    return jsonError(validation.reason, 401)
  }

  const event = zoomCaptureAdapter.parseEvent(body)

  if (!event) {
    // Not a relevant event type (or no downloadable media) — acknowledge.
    return NextResponse.json({ status: "ignored" })
  }

  let meetingId: string | undefined
  let created = false
  const workspaceId = getCaptureWorkspaceId()
  const repository = getSystemMeetingRepository(workspaceId)

  try {
    const settings = await getAppSettings(workspaceId)
    const outcome = await repository.createMeetingIfAbsent({
      ...zoomCaptureAdapter.toMeetingInput(event),
      visibility: settings.defaultMeetingVisibility,
      externalSource: "zoom",
      externalId: event.externalId,
    })

    meetingId = outcome.meeting.id
    created = outcome.created

    if (!created) {
      return NextResponse.json({ status: "duplicate", meetingId })
    }

    await enqueueMeetSumJob("media.ingest", {
      meetingId,
      workspaceId,
      platform: "zoom",
      externalId: event.externalId,
      captureEvent: event,
    })

    await recordAuditLog({
      workspaceId,
      actor: "zoom",
      action: "capture.zoom.recording",
      targetType: "meeting",
      targetId: meetingId,
      metadata: {
        externalId: event.externalId,
        title: event.title,
        recordingUrl: event.recordingUrl ? "[redacted]" : undefined,
      },
    }).catch(() => {})

    return NextResponse.json({ status: "accepted", meetingId })
  } catch (error) {
    // Let Zoom redeliver: drop the meeting we just created so the retry
    // isn't mistaken for a duplicate.
    if (created && meetingId) {
      await repository.discardMeeting(meetingId).catch(() => false)
    }

    console.error("[zoom] webhook processing failed", error)

    return jsonError("Failed to process Zoom event", 500)
  }
}
