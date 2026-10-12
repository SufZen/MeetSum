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
import { meetingRepository } from "@/lib/meetings/store"
import { enqueueMeetSumJob } from "@/lib/jobs/queue"

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
 */
export async function POST(request: Request) {
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

    if (
      headers["x-zm-signature"] &&
      !verifyZoomSignature(headers, rawBody, secret)
    ) {
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

  try {
    const outcome = await meetingRepository.createMeetingIfAbsent({
      ...zoomCaptureAdapter.toMeetingInput(event),
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
      platform: "zoom",
      externalId: event.externalId,
      captureEvent: event,
    })

    await recordAuditLog({
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
      await meetingRepository.discardMeeting(meetingId).catch(() => false)
    }

    console.error("[zoom] webhook processing failed", error)

    return jsonError("Failed to process Zoom event", 500)
  }
}
