import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { teamsCaptureAdapter } from "@/lib/capture/teams"
import { meetingRepository } from "@/lib/meetings/store"
import { enqueueMeetSumJob } from "@/lib/jobs/queue"

/**
 * POST /api/webhooks/teams — Receive Microsoft Graph change notifications.
 *
 * Handles:
 * - Subscription validation (validationToken echo)
 * - Change notifications for new recording files
 */
export async function POST(request: Request) {
  const url = new URL(request.url)

  // Handle Graph subscription validation
  const validationToken = url.searchParams.get("validationToken")

  if (validationToken) {
    return new NextResponse(validationToken, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    })
  }

  const rawBody = await request.text()
  let body: unknown

  try {
    body = JSON.parse(rawBody)
  } catch {
    return jsonError("Invalid JSON", 400)
  }

  // Validate webhook
  const headers: Record<string, string> = {}

  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value
  })

  const validation = teamsCaptureAdapter.validateWebhook(headers, rawBody)

  if (!validation.valid) {
    return jsonError(validation.reason, 401)
  }

  // Parse the event
  const event = teamsCaptureAdapter.parseEvent(body)

  if (!event) {
    return NextResponse.json({ status: "ignored" })
  }

  try {
    const input = teamsCaptureAdapter.toMeetingInput(event)
    const meeting = await meetingRepository.createMeeting(input)

    await enqueueMeetSumJob("media.ingest", {
      meetingId: meeting.id,
      recordingUrl: event.recordingUrl,
      platform: "teams",
      externalId: event.externalId,
    })

    await recordAuditLog({
      action: "capture.teams.recording",
      targetType: "meeting",
      targetId: meeting.id,
      metadata: {
        externalId: event.externalId,
        resource: event.recordingUrl ? "[redacted]" : undefined,
      },
    })

    return NextResponse.json(
      { status: "accepted", meetingId: meeting.id },
      { status: 201 }
    )
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Failed to process Teams event",
      500
    )
  }
}
