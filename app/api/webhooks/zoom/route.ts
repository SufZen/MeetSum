import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { zoomCaptureAdapter, handleZoomChallenge } from "@/lib/capture/zoom"
import { meetingRepository } from "@/lib/meetings/store"
import { enqueueMeetSumJob } from "@/lib/jobs/queue"

/**
 * POST /api/webhooks/zoom — Receive Zoom webhook events.
 *
 * Handles:
 * - endpoint.url_validation — Zoom URL verification challenge
 * - recording.completed — New recording available for processing
 */
export async function POST(request: Request) {
  const rawBody = await request.text()
  let body: unknown

  try {
    body = JSON.parse(rawBody)
  } catch {
    return jsonError("Invalid JSON", 400)
  }

  // Handle Zoom URL validation challenge (no signature check needed)
  if (
    typeof body === "object" &&
    body !== null &&
    (body as { event?: string }).event === "endpoint.url_validation"
  ) {
    const challenge = handleZoomChallenge(
      body as Parameters<typeof handleZoomChallenge>[0]
    )
    return NextResponse.json(challenge)
  }

  // Validate webhook signature
  const headers: Record<string, string> = {}

  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value
  })

  const validation = zoomCaptureAdapter.validateWebhook(headers, rawBody)

  if (!validation.valid) {
    return jsonError(validation.reason, 401)
  }

  // Parse the event
  const event = zoomCaptureAdapter.parseEvent(body)

  if (!event) {
    // Not a relevant event type — acknowledge silently
    return NextResponse.json({ status: "ignored" })
  }

  try {
    // Create meeting record
    const input = zoomCaptureAdapter.toMeetingInput(event)
    const meeting = await meetingRepository.createMeeting(input)

    // Enqueue media ingestion
    await enqueueMeetSumJob("media.ingest", {
      meetingId: meeting.id,
      recordingUrl: event.recordingUrl,
      platform: "zoom",
      externalId: event.externalId,
    })

    await recordAuditLog({
      action: "capture.zoom.recording",
      targetType: "meeting",
      targetId: meeting.id,
      metadata: {
        externalId: event.externalId,
        title: event.title,
        recordingUrl: event.recordingUrl ? "[redacted]" : undefined,
      },
    })

    return NextResponse.json(
      { status: "accepted", meetingId: meeting.id },
      { status: 201 }
    )
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Failed to process Zoom event",
      500
    )
  }
}
