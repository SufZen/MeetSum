import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { ingestDesktopCaptureForMeeting } from "@/lib/capture/desktop-upload"
import {
  normalizeDesktopCaptureMetadata,
  normalizeDesktopTranscriptSegments,
  parseDesktopJsonField,
  parseDesktopMeetingInput,
} from "@/lib/capture/desktop-ingestion"
import { meetingRepository } from "@/lib/meetings/store"
import { createPlatformEvent } from "@/lib/platform/events"

export async function POST(request: Request) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) {
    return unauthorized
  }

  const formData = await request.formData()
  let parsedMeeting: ReturnType<typeof parseDesktopMeetingInput>
  let result: Awaited<ReturnType<typeof ingestDesktopCaptureForMeeting>>

  try {
    parsedMeeting = parseDesktopMeetingInput(parseDesktopJsonField(formData, "meeting"))
    const metadata = normalizeDesktopCaptureMetadata(
      parseDesktopJsonField(formData, "captureMetadata")
    )
    const transcriptSegments = normalizeDesktopTranscriptSegments(
      parseDesktopJsonField(formData, "transcript"),
      parsedMeeting.meeting.language
    )

    if (!(formData.get("file") instanceof File) && transcriptSegments.length === 0) {
      throw new Error("Audio/video file or transcript segments are required")
    }

    const meeting = await meetingRepository.createMeeting(parsedMeeting.meeting)
    const enrichedForm = new FormData()

    for (const [key, value] of formData.entries()) {
      enrichedForm.set(key, value)
    }
    enrichedForm.set(
      "captureMetadata",
      JSON.stringify({
        ...metadata,
        endedAt: parsedMeeting.endedAt,
      })
    )

    result = await ingestDesktopCaptureForMeeting({
      meetingId: meeting.id,
      formData: enrichedForm,
      language: meeting.language,
      captureSource: "desktop",
    })

    return NextResponse.json(
      {
        meeting,
        asset: result.asset,
        job: result.job,
        transcriptSegments: result.transcriptSegments.length,
        captureMetadata: result.captureMetadata,
        event: createPlatformEvent("meeting.created", { meetingId: meeting.id }),
      },
      { status: 202 }
    )
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Invalid desktop capture payload",
      400
    )
  }
}
