import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { parseCaptureEvents } from "@/lib/capture/registry"
import { teamsCaptureAdapter } from "@/lib/capture/teams"
import { meetingRepository } from "@/lib/meetings/store"
import { enqueueMeetSumJob } from "@/lib/jobs/queue"

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
 */
export async function POST(request: Request) {
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

  for (const event of events) {
    let meetingId: string | undefined
    let created = false

    try {
      const outcome = await meetingRepository.createMeetingIfAbsent({
        ...teamsCaptureAdapter.toMeetingInput(event),
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
        platform: "teams",
        externalId: event.externalId,
        captureEvent: event,
      })
      accepted.push(meetingId)

      await recordAuditLog({
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
        await meetingRepository.discardMeeting(meetingId).catch(() => false)
      }

      console.error("[teams] notification processing failed", error)
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
